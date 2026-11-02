// Discord(#カレンダー追加)を確認して、予定を data/events.json に保存する
//  ・通常の投稿 → 予定の追加
//  ・1行目が del の投稿 → 予定の削除(2行目以降は追加と同じ書き方)
// 受け付けた投稿には、返信ではなくリアクションを付ける
// スプレッドシートへの反映は、Apps Script の syncEvents が GitHub から読み取って行う
const fs = require('fs');
const path = require('path');

// ===== 設定(Apps Script側の CAL_START / CAL_END と必ず同じにする) =====
const START = { y: 2026, m: 10 };
const END   = { y: 2028, m: 4 };
const READ_EXISTING_ON_FIRST_RUN = false;  // true: 初回にチャンネルの直近100件も処理する

// リアクションの絵文字
const REACT_OK       = '☑️';   // 予定を受け付けた(追加・削除)
const REACT_DUP      = '⚠️';   // すでに登録済み(追加をスキップ)
const REACT_NOTFOUND = '❓';   // 削除の対象が記録になかった(シートからは削除を試みる)
const REACT_ERR      = '❌';   // 読み取れなかった
// ===================================================================

const DATA_FILE = path.join(__dirname, 'data', 'events.json');
const DISCORD_API = 'https://discord.com/api/v10';
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL = process.env.DISCORD_CHANNEL_ID;

if (!TOKEN || !CHANNEL) {
  console.error('Secrets が足りません: DISCORD_BOT_TOKEN / DISCORD_CHANNEL_ID');
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));


// ---------------------------------------------------------------
//  保存データ { lastMessageId, nextSeq, events: [{seq,y,m,d,text,op?}] }
//   op が無い、または 'add' → 追加の記録 / op が 'del' → 削除の記録
// ---------------------------------------------------------------

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return { lastMessageId: '', nextSeq: 1, events: [] };
    throw e;   // 壊れているときは、上書きせずに止める
  }
}

function saveData(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 1) + '\n');
}

const sameEvent = (a, b) => a.y === b.y && a.m === b.m && a.d === b.d && a.text === b.text;


// ---------------------------------------------------------------
//  Discord
// ---------------------------------------------------------------

// Discord APIを呼ぶ(429と5xxは待ってやり直す)。失敗時は例外
async function discord(apiPath, options = {}) {
  for (let i = 1; i <= 3; i++) {
    const res = await fetch(DISCORD_API + apiPath, {
      ...options,
      headers: {
        'Authorization': 'Bot ' + TOKEN,
        'User-Agent': 'DiscordBot (https://github.com, 1.0)',
        'Content-Type': 'application/json'
      }
    });
    const text = await res.text();
    if (res.ok) return text ? JSON.parse(text) : null;

    if ((res.status === 429 || res.status >= 500) && i < 3) {
      let wait = 3000 * i;
      try { wait = Math.max(wait, (JSON.parse(text).retry_after || 0) * 1000); } catch (e) {}
      await sleep(wait);
      continue;
    }
    const err = new Error(`Discordエラー ${res.status} ${text}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
}

// 投稿にリアクションを付ける(失敗しても処理は続ける)
async function react(messageId, emojis) {
  for (const emoji of emojis) {
    try {
      await discord(
        `/channels/${CHANNEL}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
        { method: 'PUT' });
    } catch (e) {
      console.error(`  リアクション失敗(${emoji}): ${e.message}`);
      if (e.status === 403) console.warn('  → Bot に「リアクションの追加」の権限がない可能性があります(予定の保存自体は完了しています)');
    }
    await sleep(400);   // リアクションは連続で付けると制限されやすい
  }
}


// ---------------------------------------------------------------
//  日付まわり(日本時間で計算)
// ---------------------------------------------------------------

function todayJST() {
  const t = new Date(Date.now() + 9 * 3600 * 1000);
  return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
}

function inRange(y, m) {
  const ym = y * 12 + m;
  return ym >= START.y * 12 + START.m && ym <= END.y * 12 + END.m;
}

function isValidDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// 年が省略されたとき、期間内で「今日以降でいちばん近い年」を選ぶ
function pickYear(m, d) {
  const today = todayJST();
  const cands = [];
  for (let y = START.y; y <= END.y; y++) {
    if (inRange(y, m) && isValidDate(y, m, d)) cands.push(y);
  }
  if (!cands.length) return null;
  return cands.find(y => Date.UTC(y, m - 1, d) >= today) || cands[cands.length - 1];
}


// ---------------------------------------------------------------
//  投稿文の解析
// ---------------------------------------------------------------

function stripBullet(s) {
  return String(s).replace(/^[\s\u3000・･•●○◦▪*＊\-－−‐]+/, '');
}

// 全角→半角(1文字→1文字の変換なので、文字位置がずれない)
function normalize(s) {
  return String(s)
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/／/g, '/')
    .replace(/．/g, '.')
    .replace(/[－−‐–—]/g, '-')
    .replace(/\u3000/g, ' ');
}

// head=true は行頭用で「.」区切りも許可(文中の「3.5」などを日付と誤認しないため)
function dateRegex(head) {
  const ys = head ? '[\\/\\-.年]' : '[\\/\\-年]';
  const ms = head ? '[\\/\\-.月]' : '[\\/\\-月]';
  return new RegExp(
    (head ? '^\\s*' : '(?<!\\d)') +
    '(?:(\\d{4})\\s*' + ys + '\\s*)?(\\d{1,2})\\s*' + ms + '\\s*(\\d{1,2})\\s*日?' +
    '(?:\\s*[（(][日月火水木金土祝][）)])?(?!\\d)'
  );
}

function findDate(line) {
  const n = normalize(line);
  const mt = n.match(dateRegex(true)) || n.match(dateRegex(false));
  if (!mt) return null;
  return { index: mt.index, length: mt[0].length, y: mt[1], m: mt[2], d: mt[3], raw: mt[0].trim() };
}

function resolveDate(f) {
  const m = Number(f.m), d = Number(f.d);
  const y = f.y ? Number(f.y) : pickYear(m, d);
  if (!y || !isValidDate(y, m, d)) return { error: `${f.raw} は存在しない日付か、期間内に該当しません` };
  if (!inRange(y, m)) {
    return { error: `${f.raw}(${y}年${m}月)はカレンダーの期間外です(${START.y}年${START.m}月〜${END.y}年${END.m}月)` };
  }
  return { y, m, d };
}

function cleanText(s) {
  return stripBullet(s)
    .replace(/\s+/g, ' ')
    .replace(/^[\s:：、,，]+|[\s:：、,，]+$/g, '')
    .trim();
}

const BULLET_RE = /^[\s\u3000]*[・･•●○◦▪*＊\-－−‐]/;

// 投稿文 → { items: [{y,m,d,text}], errors: [文字列] }
//  ・日付の行(11/2 など)があれば、そのあとの行はその日の予定
//  ・日付と予定が同じ行でもOK(11/15 歯医者 / 会議 2027/1/20)
//  ・1つの投稿に複数の日付を書いてもOK
function parseMessage(content) {
  const items = [], errors = [];
  let cur = null;

  String(content).split('\n').forEach(rawLine => {
    const line = rawLine.replace(/\r/g, '');
    if (!line.trim()) return;

    let text;
    if (BULLET_RE.test(line) && cur) {
      text = cleanText(line);
    } else {
      const f = findDate(line);
      if (f) {
        const res = resolveDate(f);
        if (res.error) { errors.push(res.error); cur = { bad: true }; return; }
        cur = res;
        text = cleanText(line.slice(0, f.index) + ' ' + line.slice(f.index + f.length));
      } else if (cur) {
        text = cleanText(line);   // 「・」なしの行も、直前の日付の予定にする
      } else {
        errors.push('日付が読み取れません:' + line.trim());
        return;
      }
    }
    if (text && cur && !cur.bad) items.push({ y: cur.y, m: cur.m, d: cur.d, text });
  });

  return { items, errors };
}

// 1行目が del / delete / 削除 なら削除コマンド。残りの行が「消したい予定」
const DEL_RE = /^\s*(?:del|delete|削除)\s*$/i;

function splitCommand(content) {
  const lines = String(content).split('\n');
  const idx = lines.findIndex(l => l.trim());
  if (idx >= 0 && DEL_RE.test(normalize(lines[idx]))) {
    return { isDelete: true, body: lines.slice(idx + 1).join('\n') };
  }
  return { isDelete: false, body: String(content) };
}


// ---------------------------------------------------------------
//  追加・削除の処理
// ---------------------------------------------------------------

function handleAdd(data, parsed) {
  const added = [], dups = [];
  for (const ev of parsed.items) {
    const exists = data.events.some(e => e.op !== 'del' && sameEvent(e, ev));
    if (exists) { dups.push(ev); continue; }
    data.events.push({ seq: data.nextSeq++, ...ev });
    added.push(ev);
  }
  console.log(`  追加: 受付${added.length}件 / 重複${dups.length}件 / エラー${parsed.errors.length}件`);

  const emojis = [];
  if (added.length) emojis.push(REACT_OK);
  if (dups.length) emojis.push(REACT_DUP);
  if (parsed.errors.length || (!added.length && !dups.length)) emojis.push(REACT_ERR);
  return emojis;
}

function handleDelete(data, parsed) {
  const removed = [], notFound = [];
  for (const ev of parsed.items) {
    // GitHub上の記録から取り除く(まだシートに反映されていない予定なら、これで追加自体が無かったことになる)
    const before = data.events.length;
    data.events = data.events.filter(e => !(e.op !== 'del' && sameEvent(e, ev)));
    if (data.events.length < before) removed.push(ev); else notFound.push(ev);

    // シートからも消すため、削除の記録を残す(シートに手書きした予定も消せる)
    data.events.push({ seq: data.nextSeq++, op: 'del', ...ev });
  }
  console.log(`  削除: 記録あり${removed.length}件 / 記録なし${notFound.length}件 / エラー${parsed.errors.length}件`);

  const emojis = [];
  if (removed.length) emojis.push(REACT_OK);
  if (notFound.length) emojis.push(REACT_NOTFOUND);
  if (parsed.errors.length || (!removed.length && !notFound.length)) emojis.push(REACT_ERR);
  return emojis;
}


// ---------------------------------------------------------------
//  メイン
// ---------------------------------------------------------------

async function main() {
  const data = loadData();
  console.log('処理済みの位置: ' + (data.lastMessageId || '(なし)'));

  try {
    // 初回は「いまの最新の投稿」を基準にして、それ以降だけを処理する
    if (!data.lastMessageId && !READ_EXISTING_ON_FIRST_RUN) {
      const latest = await discord(`/channels/${CHANNEL}/messages?limit=1`);
      if (latest.length) {
        data.lastMessageId = latest[0].id;
        console.log('【初回】基準を記録しました。予定は、この後に新しく書き込んでください');
      } else {
        console.log('【初回】チャンネルに投稿がありません');
      }
      return;
    }

    const list = await discord(
      `/channels/${CHANNEL}/messages?limit=100` + (data.lastMessageId ? `&after=${data.lastMessageId}` : ''));

    // 古い順に並べ替え(IDは巨大な数なので文字列で比較)
    const messages = list.sort((a, b) =>
      a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    console.log(`新しい投稿: ${messages.length}件`);

    for (const msg of messages) {
      const isBot = !!(msg.author && msg.author.bot);
      const text = msg.content || '';
      console.log(`投稿 ${msg.id} / bot=${isBot} / 本文の長さ=${text.length}`);

      if (!isBot && text) {
        const cmd = splitCommand(text);
        const parsed = parseMessage(cmd.body);
        parsed.errors.forEach(e => console.log('  エラー内容: ' + e));

        const emojis = cmd.isDelete ? handleDelete(data, parsed) : handleAdd(data, parsed);
        await react(msg.id, emojis);
      } else if (!isBot) {
        const hasOther = (msg.attachments && msg.attachments.length) || (msg.embeds && msg.embeds.length);
        if (!hasOther) {
          console.warn('  本文が空です。Developer Portal の Message Content Intent がOFFの可能性があります');
          await react(msg.id, [REACT_ERR]);
        }
      }
      data.lastMessageId = msg.id;
    }
  } finally {
    saveData(data);   // 途中で失敗しても、ここまでの進捗は保存する
  }
}

main().catch(e => {
  console.error('失敗: ' + e.message);
  if (e.status === 401) console.warn('→ DISCORD_BOT_TOKEN が間違っています');
  if (e.status === 403 && /40333|1015/.test(e.body || '')) console.warn('→ 通信制限です。時間を置いて再実行してください');
  else if (e.status === 403) console.warn('→ Bot が #カレンダー追加 を見る権限を持っていません');
  if (e.status === 404) console.warn('→ DISCORD_CHANNEL_ID が間違っているか、Bot がサーバーに参加していません');
  process.exit(1);
});
