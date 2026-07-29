import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { createServer } from 'http';
import { BOSSES_DATA, TZ_OFFSET, LANG_LIST, t, bossName } from './translations.js';
import { initVoice, connectVoice, disconnectVoice, speak, speakDefeated, speakFromNotifLoop, speakSpawned, checkWorldBossTts, cleanupWorldBoss, getVoiceConnection } from './voice.js';
import { initNotifs, sendNotif, sendAllNotifsFn, removeBossReactionsFn, resetBossCycleFn, startNotifLoop } from './notifs.js';
import { initCommands, handleCommand, buildDetailedHelp, handleInteraction } from './commands.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.GuildVoiceStates],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

try {
  const serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT ||
    readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './service-account.json', 'utf8')
  );
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} catch (e) {
  console.error('Firebase init failed:', e.message);
  process.exit(1);
}
const db = admin.firestore();
const TZ = 'Asia/Tokyo';
const HISTORY_TTL_DAYS = 2;

let config = { channels: { en: null, ko: null, ja: null }, voice: null, voiceLang: 'en' };
let timers = {};
let notifMessageCache = new Map();
let sentSoonNotifs = new Set();
let sentSpawnedNotifs = new Set();
let ttsSpokenMinutes = new Map();

const TTS_SPAWN_IN = {
  en: (n, m) => `${n} will respawn in ${m} minute${m !== 1 ? 's' : ''}.`,
  ko: (n, m) => `${n}이(가) ${m}분 후에 출현합니다.`,
  ja: (n, m) => `${n}が${m}分後に出現します。`
};

const TTS_SPAWNED = {
  en: (n) => `${n} has respawned.`,
  ko: (n) => `${n}이(가) 출현했습니다.`,
  ja: (n) => `${n}が出現しました。`
};

const TTS_DEFEATED = {
  en: (n, t) => `${n} has been defeated. Next respawn ${t}.`,
  ko: (n, t) => `${n}이(가) 처치되었습니다. 다음 출현 ${t}.`,
  ja: (n, t) => `${n}が討伐されました。次の出現は${t}です。`
};

const WORLD_BOSS_TIMES = [
  { hour: 12, minute: 0 },
  { hour: 21, minute: 0 },
];

const TTS_WORLD_BOSS_IN = {
  en: (m) => `World Boss will spawn in ${m} minute${m !== 1 ? 's' : ''}.`,
  ko: (m) => `월드 보스가 ${m}분 후에 출현합니다.`,
  ja: (m) => `ワールドボスが${m}分後に出現します。`,
};

const TTS_WORLD_BOSS_SPAWNED = {
  en: 'World Boss has spawned.',
  ko: '월드 보스가 출현했습니다.',
  ja: 'ワールドボスが出現しました。',
};

const CMD_ALIAS = {
  kill: { en: 'kill', ko: '처치', ja: '討伐' },
  set: { en: 'set', ko: '설정', ja: '設定' },
  miss: { en: 'miss', ko: '놓침', ja: '逃し' },
  clear: { en: 'clear', ko: '초기화', ja: '解除' },
  bl: { en: 'bl', ko: '목록', ja: '一覧' },
  ut: { en: 'ut', ko: '곧', ja: 'まもなく' },
  reset_tracker: { en: 'reset_tracker', ko: '초기화_전체', ja: '全解除' }
};

let CMD_MAP = {};
for (const [id, aliases] of Object.entries(CMD_ALIAS)) {
  for (const [lang, word] of Object.entries(aliases)) {
    CMD_MAP[word.toLowerCase()] = { id, lang };
  }
}

// ─── Utility functions ──────────────────────────
function findBoss(query, lang = 'en') {
  const q = query.toLowerCase();
  for (const langKey of LANG_LIST) {
    const match = BOSSES_DATA.find(b => bossName(b.id, langKey).toLowerCase() === q || b.id.toLowerCase() === q);
    if (match) return match;
  }
  for (const langKey of LANG_LIST) {
    const match = BOSSES_DATA.find(b => bossName(b.id, langKey).toLowerCase().includes(q) || b.id.toLowerCase().includes(q));
    if (match) return match;
  }
  return null;
}

function getNextSpawn(boss) {
  const timer = timers[boss.id];
  if (boss.respawn) {
    if (timer && timer.endTime) return new Date(timer.endTime);
    return null;
  }
  if (boss.weeklyRespawns) {
    const now = Date.now();
    const base = new Date(now + TZ_OFFSET);
    let soonest = null;
    for (const { day, hour, minute } of boss.weeklyRespawns) {
      const candidate = new Date(base);
      const delta = (day + 7 - base.getUTCDay()) % 7;
      candidate.setUTCDate(base.getUTCDate() + delta);
      candidate.setUTCHours(hour, minute, 0, 0);
      let result = candidate.getTime() - TZ_OFFSET;
      if (result < now) result += 7 * 86400000;
      if (!soonest || result < soonest) soonest = result;
    }
    return soonest ? new Date(soonest) : null;
  }
  return null;
}

function formatJST(ms, lang = 'en') {
  const locales = { en: 'en-US', ko: 'ko-KR', ja: 'ja-JP' };
  return new Date(ms).toLocaleString(locales[lang] || 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: lang !== 'ja', timeZone: TZ });
}

function formatSpawnTime(ms) {
  const d = new Date(ms + TZ_OFFSET);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function formatRemaining(ms) {
  if (ms <= 0) return '00h00m';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d${String(h).padStart(2, '0')}h${String(m).padStart(2, '0')}m`;
  return `${String(h).padStart(2, '0')}h${String(m).padStart(2, '0')}m`;
}

function visualLen(str) {
  let len = 0;
  for (const c of str) len += /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uffef\u4e00-\u9faf\uac00-\ud7af]/.test(c) ? 2 : 1;
  return len;
}
function padL(str, w) { return ' '.repeat(Math.max(0, w - visualLen(str))) + str; }
function padR(str, w) { return str + ' '.repeat(Math.max(0, w - visualLen(str))); }
function padC(str, w) { const p = Math.max(0, w - visualLen(str)), l = Math.floor(p / 2); return ' '.repeat(l) + str + ' '.repeat(p - l); }

function detectLang(content) {
  const korean = (content.match(/[가-힣]/g) || []).length;
  const japanese = (content.match(/[ぁ-んァ-ン一-龯]/g) || []).length;
  if (japanese > korean) return 'ja';
  if (korean > 0) return 'ko';
  return 'en';
}

// ─── Config & Timer persistence ─────────────────
async function loadConfig() {
  const doc = await db.collection('config').doc('discordBot').get();
  if (doc.exists) {
    const data = doc.data();
    for (const key of Object.keys(config)) delete config[key];
    Object.assign(config, { channels: { en: null, ko: null, ja: null }, voice: null, voiceLang: 'en' }, data);
    if (config.voice && typeof config.voice === 'object') config.voice = config.voice.en || null;
  }
}

async function loadTimers() {
  const doc = await db.collection('timers').doc('global').get();
  const fresh = doc.exists ? (doc.data().timers || {}) : {};
  for (const key of Object.keys(timers)) delete timers[key];
  Object.assign(timers, fresh);
}

async function saveTimers() {
  await db.collection('timers').doc('global').set({ timers }, { merge: false });
}

async function addHistory(bossId, type, timestamp) {
  try {
    await db.collection('history').add({
      bossId, type, timestamp,
      expiresAt: new Date(timestamp + HISTORY_TTL_DAYS * 86400000)
    });
  } catch (e) { console.error('History err:', e); }
}

// ─── Initialize modules ─────────────────────────
initVoice({
  client, config, bossName, TZ, TZ_OFFSET,
  TTS_SPAWN_IN, TTS_SPAWNED, TTS_DEFEATED,
  WORLD_BOSS_TIMES, TTS_WORLD_BOSS_IN, TTS_WORLD_BOSS_SPAWNED
});

initNotifs({
  client, config, db, timers, bossName, t, formatJST,
  LANG_LIST, BOSSES_DATA, getNextSpawn,
  notifMessageCache, sentSoonNotifs, sentSpawnedNotifs, ttsSpokenMinutes,
  speak: (text) => speak(text),
  speakFromNotifLoop: (bn, m) => speakFromNotifLoop(bn, m),
  speakSpawned: (bn) => speakSpawned(bn)
});

const sendAllNotifs = sendAllNotifsFn;
const removeBossReactions = removeBossReactionsFn;
const resetBossCycle = resetBossCycleFn;

initCommands({
  config, timers, db, bossName, t, formatJST,
  BOSSES_DATA, TZ_OFFSET, LANG_LIST,
  findBoss, getNextSpawn, formatSpawnTime, formatRemaining,
  visualLen, padL, padC, padR, detectLang,
  CMD_ALIAS, CMD_MAP,
  sendAllNotifs, removeBossReactions, resetBossCycle,
  saveTimers, addHistory,
  speakDefeated: (bid, end) => speakDefeated(bid, end, BOSSES_DATA),
  notifMessageCache
});

// ─── Discord event handlers ─────────────────────
client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  const content = msg.content.trim().toLowerCase();
  if (!content) return;

  const allowedChannels = Object.values(config.channels).filter(Boolean);
  if (allowedChannels.length && !allowedChannels.includes(msg.channel.id)) return;

  if (content === 'astra help' || content === 'astra' || content === '도움' || content === '도움말' || content.match(/^astra\s+help$/i)) {
    return msg.reply(buildDetailedHelp().slice(0, 2000));
  }

  if (content === '/setup' || content.startsWith('/setup ')) {
    return msg.reply('Use `/setup` with Discord slash commands:\n`/setup <en_channel> <ko_channel> <ja_channel> [voice_channel] [voice_lang]`');
  }

  const resolved = (function resolveCommand(raw) {
    const lower = raw.toLowerCase();
    return CMD_MAP[lower] || null;
  })(msg.content.trim().split(/\s+/)[0]);
  if (resolved || content === '/tracker_commands') {
    await handleCommand(msg);
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    await handleInteraction(interaction);
  } catch (e) {
    console.error('Interaction error:', e);
  }
});

client.once('clientReady', async () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  await loadConfig();
  await loadTimers();

  // Clean up old history entries
  try {
    const cutoff = new Date(Date.now() - HISTORY_TTL_DAYS * 86400000);
    const oldDocs = await db.collection('history').where('timestamp', '<', cutoff.getTime()).limit(500).get();
    const batch = db.batch();
    for (const doc of oldDocs.docs) batch.delete(doc.ref);
    await batch.commit();
    if (oldDocs.size > 0) console.log(`Cleaned up ${oldDocs.size} old history entries`);
  } catch (e) { console.error('History cleanup error:', e.message); }

  try {
    const snapshot = await db.collection('notifications').where('type', '==', 'spawning').get();
    for (const doc of snapshot.docs) {
      const data = doc.data();
      const timer = timers[data.bossId];
      const docEndTime = parseInt(doc.id.split('_').pop());
      if (!docEndTime) continue;
      if (timer && timer.endTime === docEndTime) {
        const msgs = {};
        for (const l of LANG_LIST) {
          if (data[l] && config.channels[l]) {
            const channel = client.channels.cache.get(config.channels[l]);
            if (channel) {
              try { msgs[l] = await channel.messages.fetch(data[l]); } catch {}
            }
          }
        }
        if (msgs.en || msgs.ko || msgs.ja) {
          notifMessageCache.set(data.bossId, msgs);
          sentSoonNotifs.add(`${data.bossId}_${docEndTime}`);
        }
      } else {
        for (const l of LANG_LIST) {
          if (data[l] && config.channels[l]) {
            const channel = client.channels.cache.get(config.channels[l]);
            if (channel) {
              try {
                const msg = await channel.messages.fetch(data[l]);
                await msg.edit({ components: [] });
              } catch {}
            }
          }
        }
        await doc.ref.delete();
      }
    }
  } catch (e) {
    console.error('Notification cleanup error:', e);
  }

  startNotifLoop();

  // World boss TTS check
  setInterval(() => {
    checkWorldBossTts(Date.now());
  }, 3000);

  // World boss cleanup
  setInterval(() => {
    cleanupWorldBoss();
  }, 3600000);

  const commands = [{
    name: 'setup',
    nameLocalizations: { ko: '설정', ja: 'せってい' },
    description: 'Configure notification channels',
    descriptionLocalizations: { ko: '알림 채널 설정', ja: '通知チャンネルを設定' },
    options: [
      { name: 'english_channel', nameLocalizations: { ko: '영어_채널', ja: '英語チャンネル' }, description: 'English notification channel', type: 7, required: false, descriptionLocalizations: { ko: '영어 알림 채널', ja: '英語通知チャンネル' } },
      { name: 'korean_channel', nameLocalizations: { ko: '한국어_채널', ja: '韓国語チャンネル' }, description: 'Korean notification channel', type: 7, required: false, descriptionLocalizations: { ko: '한국어 알림 채널', ja: '韓国語通知チャンネル' } },
      { name: 'japanese_channel', nameLocalizations: { ko: '일본어_채널', ja: '日本語チャンネル' }, description: 'Japanese notification channel', type: 7, required: false, descriptionLocalizations: { ko: '일본어 알림 채널', ja: '日本語通知チャンネル' } },
      { name: 'voice_channel', nameLocalizations: { ko: '음성_채널', ja: '音声チャンネル' }, description: 'Voice channel (optional)', type: 7, required: false, descriptionLocalizations: { ko: '음성 채널 (선택)', ja: '音声チャンネル（任意）' } },
      { name: 'voice_language', nameLocalizations: { ko: '음성_언어', ja: '音声言語' }, description: 'Voice language', type: 3, required: false,
        descriptionLocalizations: { ko: '음성 언어', ja: '音声言語' },
        choices: [
          { name: 'English', value: 'en' },
          { name: 'Korean', value: 'ko' },
          { name: 'Japanese', value: 'ja' }
        ]
      }
    ]
  }, {
    name: 'astra',
    nameLocalizations: { ko: '도움말', ja: 'へるぷ' },
    description: 'Show all tracker commands with detailed guide',
    descriptionLocalizations: { ko: '모든 명령어와 상세 가이드 표시', ja: '全コマンドと詳細ガイドを表示' }
  }, {
    name: 'import',
    nameLocalizations: { ko: '가져오기', ja: 'いんぽーと' },
    description: 'Import boss timers from paste data',
    descriptionLocalizations: { ko: '붙여넣기 데이터에서 보스 타이머 가져오기', ja: '貼り付けデータからボスタイマーをインポート' }
  }, {
    name: 'export',
    nameLocalizations: { ko: '내보내기', ja: 'エクスポート' },
    description: 'Export all boss timers as text',
    descriptionLocalizations: { ko: '모든 보스 타이머를 텍스트로 내보내기', ja: '全ボスタイマーをテキストでエクスポート' }
  }];

  try {
    await client.application.commands.set(commands);
    console.log('✅ Slash commands registered');
  } catch (e) {
    console.error('Slash command registration error:', e);
  }

  client.user.setActivity('astra / 도움 / へるぷ — Show help / 도움말 표시 / ヘルプを表示', { type: 0 });
});

const server = createServer((_, res) => { res.writeHead(200); res.end('OK'); });
const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log(`Health check server on port ${PORT}`));

client.login(process.env.DISCORD_TOKEN);
