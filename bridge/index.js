/**
 * QQ 群 <-> Minecraft Realm 双向聊天桥
 *
 * Realms 侧没有任何网络出口（@minecraft/server-net 只在 BDS 存在），
 * 所以这里用一个真正的假人客户端连进 Realm，从协议层收发聊天包。
 *
 *   QQ群 <-> NapCat(OneBot v11 WS) <-> 本进程 <-> bedrock-protocol <-> Realm
 */
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { createClient } = require('bedrock-protocol');

const CFG_PATH = path.join(__dirname, 'config.json');
const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));

const log = (...a) => console.log(new Date().toLocaleTimeString('zh-CN'), ...a);

// 判断是不是机器人自己。cfg.bot.username 是"请求用的名字"，
// 但 Realms 里显示的是微软账号的 Xbox 名（bot.gamertag），两个都要认。
function isSelf(name) {
  if (!name) return false;
  return name === cfg.bot.username || (!!cfg.bot.gamertag && name === cfg.bot.gamertag);
}

// —— 回声抑制：自己注入游戏的消息会以 chat 包回来，不能再转给 QQ ——
const injected = [];
function markInjected(text) {
  injected.push({ text, at: Date.now() });
  if (injected.length > 50) injected.shift();
}
function wasInjected(text) {
  const now = Date.now();
  while (injected.length && now - injected[0].at > 8000) injected.shift();
  return injected.some(x => x.text === text);
}

function clean(s) {
  // OneBot 配置为 messagePostFormat=array 时，message 是分段数组，
  // 直接 String() 会得到 "[object Object]"，这里按段摊平
  if (Array.isArray(s)) {
    s = s.map(seg => {
      if (typeof seg === 'string') return seg;
      switch (seg && seg.type) {
        case 'text': return seg.data?.text ?? '';
        case 'at': return `@${seg.data?.qq ?? ''} `;
        case 'image': return '[图片]';
        case 'face': return '[表情]';
        case 'reply': return '';
        default: return '';
      }
    }).join('');
  }
  return String(s || '')
    .replace(/§./g, '')              // 去 Bedrock 颜色码 §a §r 之类
    .replace(/\[CQ:[^\]]*\]/g, '')   // 去 CQ 码（图片/表情/at）
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* =======================  QQ 侧  ======================= */
let ws = null;
let qqReady = false;
let qqRetry = 5000;
let echoSeq = 0;
const pending = new Map();

function connectQQ() {
  const url = cfg.qq.accessToken
    ? `${cfg.qq.ws}?access_token=${encodeURIComponent(cfg.qq.accessToken)}`
    : cfg.qq.ws;
  ws = new WebSocket(url);

  ws.on('open', () => {
    qqReady = true;
    qqRetry = 5000;
    log('[QQ] OneBot 已连接');
  });

  ws.on('message', raw => {
    let evt;
    try { evt = JSON.parse(raw.toString()); } catch { return; }
    if (evt.echo && pending.has(evt.echo)) { pending.delete(evt.echo); return; }
    onQQEvent(evt);
  });

  ws.on('close', () => {
    qqReady = false;
    log(`[QQ] 断开，${qqRetry / 1000}s 后重连`);
    setTimeout(connectQQ, qqRetry);
    qqRetry = Math.min(qqRetry * 2, 30000);
  });

  ws.on('error', e => log('[QQ] 错误:', e.message));
}

function sendQQ(action, params) {
  if (!qqReady) return log('[QQ] 未连接，丢弃:', action);
  const echo = `e${++echoSeq}`;
  pending.set(echo, Date.now());
  ws.send(JSON.stringify({ action, params, echo }));
}

function toQQ(text) {
  if (!cfg.qq.group) return;
  sendQQ('send_group_msg', { group_id: Number(cfg.qq.group), message: text });
}

function onQQEvent(evt) {
  if (evt.post_type !== 'message' || evt.message_type !== 'group') return;
  if (String(evt.group_id) !== String(cfg.qq.group)) return;
  if (!cfg.switch.qq_to_mc) return;
  if (cfg.switch.qqSelfId && Number(evt.user_id) === Number(cfg.switch.qqSelfId)) return;

  let text = clean(evt.message ?? evt.raw_message);
  if (!text) return;

  // —— QQ 指令：查看在线玩家（支持 #在线 / !在线 / 在线 / 谁在线 / 人数 等）——
  const cmd = text.replace(/^[#!！/]/, '').trim();
  if (/^(在线|在线玩家|在线人数|谁在线|人数|玩家列表|list)$/i.test(cmd)) {
    replyOnline();
    return;
  }

  if (cfg.filter.blockPrefixes.some(p => text.startsWith(p))) return;
  if (cfg.filter.blockWords.some(w => text.includes(w))) return;

  const who = evt.sender?.card || evt.sender?.nickname || String(evt.user_id);
  let line = `${who}: ${text}`;
  if (line.length > cfg.qq.maxLength) line = line.slice(0, cfg.qq.maxLength) + '…';

  pushToMC(line);
}

/* =======================  Minecraft 侧  ======================= */
let mc = null;
let mcReady = false;
let mcRetry = 3000;

// —— 在线玩家名单（来自 player_list 包的 add/remove）——
const online = new Map();   // uuid -> { name, xuid }
let listInited = false;     // 首次同步不刷上线提醒，否则会一次性刷一屏
let selfUuid = null;        // 机器人自己的 uuid，不列入名单

function replyOnline() {
  const names = [...online.values()].map(v => v.name);
  const list = names.length ? names.join('、') : '（没有人）';
  toQQ(`[${cfg.realm.serverLabel}] 在线 ${names.length} 人: ${list}`);
  log('[QQ] 回复在线名单，共', names.length, '人');
}

function connectMC() {
  log('[MC] 正在连接 Realm…');
  online.clear();
  listInited = false;
  selfUuid = null;
  const opts = {
    // Realms 分支：realms 里给 realmInvite / realmId / pickRealm 任一即可
    realms: cfg.realm.invite
      ? { realmInvite: cfg.realm.invite, pickRealm: realms => realms[0] }
      : { pickRealm: realms => realms.find(r => r.name === cfg.realm.pickRealm) || realms[0] },
    username: cfg.bot.username,
    profilesFolder: cfg.bot.profilesFolder,
    // raknet-native 需要 C++ 编译环境；这里用纯 JS 实现，聊天机器人足够
    raknetBackend: 'jsp-raknet',
    conLog: null,
    onMsaCode: data => {
      log('================ 需要登录微软账号 ================');
      log(` 打开 ${data.verification_uri}  输入代码: ${data.user_code}`);
      log(' 登录一次后 token 会缓存到 auth/ 目录，以后自动复用');
      log('=================================================');
    }
  };

  if (cfg.bot.authTitle) opts.authTitle = cfg.bot.authTitle;  // 留空则用库默认通道

  try {
    mc = createClient(opts);
  } catch (e) {
    log('[MC] 建连失败:', e.message);
    return setTimeout(connectMC, mcRetry);
  }

  mc.on('spawn', () => {
    mcReady = true;
    mcRetry = 3000;
    log('[MC] 已进入 Realm');
    // 名单包通常在 spawn 前就发完了，这里延时锁定，之后的变化才算上下线
    setTimeout(() => {
      if (!listInited) {
        listInited = true;
        log('[MC] 在线名单已同步:', online.size, '人');
      }
    }, 5000);
  });

  mc.on('text', packet => {
    if (packet.type !== 'chat') return;          // 只转发玩家聊天，忽略 tip/system/popup
    if (!cfg.switch.mc_to_qq) return;
    const name = clean(packet.source_name);
    const msg = clean(packet.message);
    if (!msg) return;
    if (isSelf(name)) return;                     // 自己说的不往回转
    if (wasInjected(msg)) return;                // 自己刚灌进去的，不回声
    toQQ(`[${cfg.realm.serverLabel}] <${name}> ${msg}`);
    log('[MC->QQ]', name, ':', msg);
  });

  // —— 玩家上下线：player_list 的 add/remove 就是进出服信号 ——
  mc.on('player_list', p => {
    const recs = Array.isArray(p.records) ? p.records
      : Array.isArray(p.records?.records) ? p.records.records
        : [];

    for (const r of recs) {
      if (r.type === 'add') {
        if (isSelf(r.username)) { selfUuid = r.uuid; continue; }   // 自己不列入在线名单
        const known = online.has(r.uuid);
        const name = clean(r.username);
        online.set(r.uuid, { name, xuid: clean(r.xbox_user_id) });
        if (listInited && !known && !selfUuid) {
          toQQ(`[${cfg.realm.serverLabel}] 🟢 ${name} 上线了（在线 ${online.size} 人）`);
          log('[MC] 上线:', name);
        }
      } else if (r.type === 'remove') {
        const info = online.get(r.uuid);
        if (!info) { if (r.uuid === selfUuid) selfUuid = null; continue; }
        online.delete(r.uuid);
        if (listInited) {
          toQQ(`[${cfg.realm.serverLabel}] 🔴 ${info.name} 下线了（在线 ${online.size} 人）`);
          log('[MC] 下线:', info.name);
        }
      }
    }

    if (!listInited && mcReady) {
      listInited = true;
      log('[MC] 在线名单已同步:', online.size, '人');
    }
  });

  mc.on('kick', p => log('[MC] 被踢:', p?.message));
  mc.on('error', e => log('[MC] 错误:', e.message));
  mc.on('close', () => {
    // 以前这里 if(!mcReady) return，导致"没进服就断开"（登录失败、503、被封）
    // 之后永远不再重试，桥接就静默卡死了。进没进过服都要重连。
    log(mcReady ? '[MC] 连接断开，重新连' : '[MC] 未进服就断开，重新连');
    mcReady = false;
    setTimeout(connectMC, mcRetry);
    mcRetry = Math.min(mcRetry * 2, 60000);
  });
}

let lastPush = 0;
function pushToMC(line) {
  if (!mcReady || !mc) return log('[MC] 未在游戏内，丢弃:', line);
  // QQ 群闲聊节奏比游戏快得多，不限流会把游戏内聊天刷爆
  if (Date.now() - lastPush < 1500) return log('[MC] 限流丢弃:', line);
  lastPush = Date.now();
  markInjected(line);
  try {
    // 1.26 协议新增 category 与 has_filtered_message，少一个服务器会踢。
    // has_filtered_message 必须 false + filtered_message 空串：
    // 实测设 true 会被服务端判定非法包直接踢（且踢人提示为空）。
    // 中文被客户端打成 #### 是 Realm 的文本过滤导致的，见下面说明。
    mc.queue('text', {
      needs_translation: false,
      category: 'authored',
      type: 'chat',
      source_name: cfg.bot.username,
      message: line,
      parameters: [],
      xuid: '',
      platform_chat_id: '',
      has_filtered_message: false,
      filtered_message: ''
    });
    log('[MC<-QQ]', line);
  } catch (e) {
    log('[MC] 发送失败:', e.message);
  }
}

/* =======================  启动  ======================= */
if (!cfg.qq.group) log('⚠️  config.json 里 qq.group 还是 0，QQ 消息不会转发');
if (!/^https:\/\/realms\.gg\//.test(cfg.realm.invite || '') && !cfg.realm.pickRealm)
  log('⚠️  config.json 里 realm.invite 没填，将按 pickRealm 匹配');

connectQQ();
connectMC();

process.on('SIGINT', () => { log('退出'); process.exit(0); });
