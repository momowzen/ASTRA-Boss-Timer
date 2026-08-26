import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { createServer } from 'http';
import { BOSSES_DATA, TZ_OFFSET, LANG_LIST, t, bossName } from './translations.js';
import { initVoice, connectVoice, disconnectVoice, speak, speakDefeated, speakSet, speakMissed, speakFromNotifLoop, speakSpawned, checkWorldBossTts, cleanupWorldBoss, getVoiceConnection } from './voice.js';
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

let config = { channels: { en: null, ko: null, ja: null }, voice: null, voiceLang: 'en', pingHere: false };
let timers = {};
let notifMessageCache = new Map();
let sentSoonNotifs = new Set();
let sentSpawnedNotifs = new Set();
let ttsSpokenMinutes = new Map();

const TTS_SPAWN_IN = {
  en: (n, m) => `${n} spawns in ${m} minute${m !== 1 ? 's' : ''}.`,
  ko: (n, m) => `${n}가 ${m}분 후 출현합니다.`,
  ja: (n, m) => `${n}は${m}分後に出現します。`
};

const TTS_SPAWNED = {
  en: (n) => `${n} has spawned.`,
  ko: (n) => `${n}가 출현했습니다.`,
  ja: (n) => `${n}が出現しました。`
};

const TTS_DEFEATED = {
  en: (n, d, t) => `${n} defeated. Next spawn ${d} at ${t}.`,
  ko: (n, d, t) => `${n} 처치 완료. 다음 출현은 ${d} ${t}입니다.`,
  ja: (n, d, t) => `${n}討伐完了。次回出現は${d} ${t}です。`
};

const TTS_SET = {
  en: (n, d, t) => `${n} manually set. Next spawn ${d} at ${t}.`,
  ko: (n, d, t) => `${n} 수동 설정 완료. 다음 출현은 ${d} ${t}입니다.`,
  ja: (n, d, t) => `${n}手動設定完了。次回出現は${d} ${t}です。`
};

const TTS_MISSED = {
  en: (n, d, t) => `${n} missed. Next spawn ${d} at ${t}.`,
  ko: (n, d, t) => `${n} 놓침. 다음 출현은 ${d} ${t}입니다.`,
  ja: (n, d, t) => `${n}見逃し。次回出現は${d} ${t}です。`
};

const WORLD_BOSS_TIMES = [
  { hour: 12, minute: 0 },
  { hour: 21, minute: 0 },
];

const TTS_WORLD_BOSS_IN = {
  en: (m) => `World Boss spawns in ${m} minute${m !== 1 ? 's' : ''}.`,
  ko: (m) => `월드 보스가 ${m}분 후 출현합니다.`,
  ja: (m) => `ワールドボスは${m}分後に出現します。`,
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
  reset_tracker: { en: 'reset_tracker', ko: '초기화_전체', ja: '全解除' },
  rotation: { en: 'rotation', ko: '로테이션', ja: 'ローテーション' },
  guildnames: { en: 'guildnames', ko: '길드이름', ja: 'ギルド名' }
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
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
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

async function saveConfig() {
  await db.collection('config').doc('discordBot').set(config, { merge: false });
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
  TTS_SPAWN_IN, TTS_SPAWNED, TTS_DEFEATED, TTS_SET, TTS_MISSED,
  WORLD_BOSS_TIMES, TTS_WORLD_BOSS_IN, TTS_WORLD_BOSS_SPAWNED
});

initNotifs({
  client, config, db, timers, bossName, t, formatJST,
  LANG_LIST, BOSSES_DATA, getNextSpawn,
  notifMessageCache, sentSoonNotifs, sentSpawnedNotifs, ttsSpokenMinutes,
  speak: (text) => speak(text),
  speakFromNotifLoop: (bn, m) => speakFromNotifLoop(bn, m),
  speakSpawned: (bn) => speakSpawned(bn),
  saveConfig
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
  saveTimers, addHistory, saveConfig,
  speakDefeated: (bid, end) => speakDefeated(bid, end, BOSSES_DATA),
  speakSet: (bid, end) => speakSet(bid, end, BOSSES_DATA),
  speakMissed: (bid, end) => speakMissed(bid, end, BOSSES_DATA),
  notifMessageCache
});

// ─── Discord event handlers ─────────────────────
client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  const content = msg.content.trim().toLowerCase();
  if (!content) return;

  const allowedChannels = Object.values(config.channels).filter(Boolean);
  if (allowedChannels.length && !allowedChannels.includes(msg.channel.id)) return;

  if (content === 'astra help' || content === 'astra' || content.match(/^astra\s+help$/i)) {
    return msg.reply(buildDetailedHelp('en').slice(0, 2000));
  }
  if (content === '도움' || content === '도움말') {
    return msg.reply(buildDetailedHelp('ko').slice(0, 2000));
  }
  if (content === 'へるぷ') {
    return msg.reply(buildDetailedHelp('ja').slice(0, 2000));
  }

  if (content === '/setup' || content.startsWith('/setup ')) {
    return msg.reply('Use `/setup` with Discord slash commands:\n`/setup <en_channel> <ko_channel> <ja_channel> [voice_channel] [voice_lang]`');
  }

  const resolved = (function resolveCommand(raw) {
    const lower = raw.toLowerCase();
    return CMD_MAP[lower] || null;
  })(msg.content.trim().split(/\s+/)[0]);
  if (resolved || content === '/tracker_commands' || /\S/.test(msg.content.trim())) {
    try {
      await handleCommand(msg);
    } catch (e) {
      console.error('Command error:', e);
    }
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
  async function cleanupHistory() {
    try {
      const cutoff = new Date(Date.now() - HISTORY_TTL_DAYS * 86400000);
      const oldDocs = await db.collection('history').where('timestamp', '<', cutoff.getTime()).limit(500).get();
      const batch = db.batch();
      for (const doc of oldDocs.docs) batch.delete(doc.ref);
      await batch.commit();
      if (oldDocs.size > 0) console.log(`Cleaned up ${oldDocs.size} old history entries`);
    } catch (e) { console.error('History cleanup error:', e.message); }
  }
  await cleanupHistory();
  setInterval(cleanupHistory, 86400000);

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

  // Periodically prune old notification docs
  setInterval(async () => {
    try {
      const cutoff = Date.now() - 30 * 60 * 1000;
      const oldDocs = await db.collection('notifications').where('timestamp', '<', cutoff).limit(100).get();
      const batch = db.batch();
      let count = 0;
      for (const doc of oldDocs.docs) {
        const data = doc.data();
        const timer = timers[data.bossId];
        if (data.type === 'spawning' && timer && timer.endTime) continue;
        batch.delete(doc.ref);
        count++;
      }
      if (count > 0) { await batch.commit(); console.log(`Pruned ${count} old notification docs`); }
    } catch (e) { console.error('Notification prune error:', e.message); }
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
      },
      { name: 'ping_here', nameLocalizations: { ko: '여기_멘션', ja: 'ここメンション' }, description: '@here ping on spawn warnings', type: 5, required: false, descriptionLocalizations: { ko: '출현 알림 @here 멘션', ja: '出現通知で@hereメンション' } }
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

  client.user.setActivity('📖 Help: astra | 도움말 | へるぷ', { type: 0 });
});

const server = createServer((_, res) => { res.writeHead(200); res.end('OK'); });
const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log(`Health check server on port ${PORT}`));

client.login(process.env.DISCORD_TOKEN);




