import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState } from '@discordjs/voice';
import { getAudioBase64 } from 'google-tts-api';
import { Readable } from 'stream';
import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { createServer } from 'http';
import { BOSSES_DATA, TZ_OFFSET, LANG_LIST, t, bossName } from './translations.js';

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

let config = { channels: { en: null, ko: null, ja: null }, voice: { en: null, ko: null, ja: null }, voiceLang: 'en' };
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

let audioPlayer = null;
let voiceConnection = null;
let speakQueue = [];
let isSpeaking = false;
let idleTimer = null;

async function connectVoice() {
  const voiceId = config.voice?.en;
  if (!voiceId || voiceConnection) return;
  try {
    const channel = await client.channels.fetch(voiceId);
    if (!channel?.isVoiceBased()) return;
    const guild = channel.guild;
    audioPlayer = createAudioPlayer();
    audioPlayer.on('error', e => console.error('[VOICE] Error:', e.message));
    audioPlayer.on(AudioPlayerStatus.Idle, () => {
      isSpeaking = false;
      if (speakQueue.length) {
        const next = speakQueue.shift();
        speak(next);
      } else {
        idleTimer = setTimeout(() => disconnectVoice(), 600000);
      }
    });
    voiceConnection = joinVoiceChannel({
      channelId: voiceId, guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator
    });
    voiceConnection.on(VoiceConnectionStatus.Disconnected, async () => {
      try { await Promise.race([entersState(voiceConnection, VoiceConnectionStatus.Signalling, 5000), entersState(voiceConnection, VoiceConnectionStatus.Connecting, 5000)]); }
      catch { disconnectVoice(); }
    });
    voiceConnection.subscribe(audioPlayer);
  } catch (e) { console.error('[VOICE] Connect error:', e.message); }
}

function disconnectVoice() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (voiceConnection) { voiceConnection.destroy(); voiceConnection = null; }
  audioPlayer = null; isSpeaking = false; speakQueue = [];
}

async function speak(text) {
  if (!config.voice?.en) return;
  if (!voiceConnection) await connectVoice();
  if (!voiceConnection || !audioPlayer) return;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (isSpeaking || audioPlayer.state.status !== AudioPlayerStatus.Idle) {
    speakQueue.push(text);
    return;
  }
  isSpeaking = true;
  try {
    const lang = config.voiceLang || 'en';
    const base64 = await getAudioBase64(text, { lang, slow: false });
    const stream = Readable.from(Buffer.from(base64, 'base64'));
    audioPlayer.play(createAudioResource(stream));
  } catch (e) { console.error('[TTS] error:', e.message); isSpeaking = false; }
}

async function loadConfig() {
  const doc = await db.collection('config').doc('discordBot').get();
  if (doc.exists) config = { ...config, ...doc.data() };
}

async function saveConfig() {
  await db.collection('config').doc('discordBot').set(config, { merge: false });
}

async function loadTimers() {
  const doc = await db.collection('timers').doc('global').get();
  if (doc.exists) timers = doc.data().timers || {};
  else timers = {};
}

async function saveTimers() {
  await db.collection('timers').doc('global').set({ timers }, { merge: false });
}

async function addHistory(bossId, type, timestamp) {
  db.collection('history').add({ bossId, type, timestamp, killTime: timestamp }).catch(e => console.error('History err:', e));
}

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

function formatCountdown(ms) {
  if (ms <= 0) return '0m';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
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

function getChannel(lang) {
  const channelId = config.channels[lang];
  if (!channelId) return null;
  return client.channels.cache.get(channelId) || null;
}

async function sendNotif(lang, content, bossId, buttons = false) {
  const channel = getChannel(lang);
  if (!channel) return null;
  try {
    const components = buttons ? [new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder().setCustomId(`markdead_${bossId || '0'}`).setStyle(ButtonStyle.Danger).setLabel(t('markDeadBtn', lang)).setEmoji('💀'),
        new ButtonBuilder().setCustomId(`missed_${bossId || '0'}`).setStyle(ButtonStyle.Secondary).setLabel(t('missedBtn', lang)).setEmoji('⏰')
      )] : [];
    return await channel.send({ content, components });
  } catch (e) {
    return null;
  }
}

async function sendAllNotifs(contentEn, contentKo, contentJa, bossId, buttons = false) {
  const promises = [];
  const langs = [];
  if (config.channels.en) { promises.push(sendNotif('en', contentEn, bossId, buttons)); langs.push('en'); }
  if (config.channels.ko) { promises.push(sendNotif('ko', contentKo, bossId, buttons)); langs.push('ko'); }
  if (config.channels.ja) { promises.push(sendNotif('ja', contentJa, bossId, buttons)); langs.push('ja'); }
  const results = await Promise.all(promises);
  const msgs = {};
  results.forEach((msg, i) => { if (msg) msgs[langs[i]] = msg; });
  return msgs;
}

async function removeBossReactions(bossId) {
  const cached = notifMessageCache.get(bossId);
  if (cached) {
    const tasks = [];
    for (const [lang, msg] of Object.entries(cached)) {
      if (msg) tasks.push(msg.edit({ components: [] }).catch(() => {}));
    }
    await Promise.all(tasks);
    notifMessageCache.delete(bossId);
    return;
  }
  const snapshot = await db.collection('notifications').where('bossId', '==', bossId).get();
  const allTasks = [];
  for (const doc of snapshot.docs) {
    const data = doc.data();
    for (const l of LANG_LIST) {
      const msgId = data[l];
      if (!msgId) continue;
      const channel = getChannel(l);
      if (!channel) continue;
      allTasks.push((async () => {
        try {
          const msg = await channel.messages.fetch(msgId);
          if (msg) { await msg.edit({ components: [] }); }
        } catch (e) {}
      })());
    }
  }
  await Promise.all(allTasks);
}

function resetBossCycle(bossId) {
  for (const key of [...sentSoonNotifs]) { if (key.startsWith(bossId + '_')) sentSoonNotifs.delete(key); }
  for (const key of [...sentSpawnedNotifs]) { if (key.startsWith(bossId + '_')) sentSpawnedNotifs.delete(key); }
  notifMessageCache.delete(bossId);
}

function speakDefeated(bossId, nextRespawnTime) {
  const boss = BOSSES_DATA.find(b => b.id === bossId);
  if (!boss) return;
  const fn = TTS_DEFEATED[config.voiceLang] || TTS_DEFEATED.en;
  const locales = { en: 'en-US', ko: 'ko-KR', ja: 'ja-JP' };
  const timeStr = new Date(nextRespawnTime).toLocaleString(locales[config.voiceLang] || 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: config.voiceLang !== 'ja', timeZone: TZ });
  speak(fn(bossName(bossId, config.voiceLang), timeStr));
}

const CMD_ALIAS = {
  kill: { en: 'kill', ko: '처치', ja: '討伐' },
  set: { en: 'set', ko: '설정', ja: '設定' },
  miss: { en: 'miss', ko: '놓침', ja: '逃し' },
  clear: { en: 'clear', ko: '초기화', ja: '解除' },
  bl: { en: 'bl', ko: '목록', ja: '一覧' },

  ut: { en: 'ut', ko: '곧', ja: 'まもなく' },
  reset_tracker: { en: 'reset_tracker', ko: '초기화_전체', ja: '全解除' }
};

const CMD_PARAMS = {
  kill: '<bossname>', set: '<bossname> <MM/DD> <HHMM>', miss: '<bossname>', clear: '<bossname>',
  ut: '', bl: '', reset_tracker: ''
};

const CMD_DESC = {
  kill: 'killDesc', set: 'setDesc', miss: 'missDesc', clear: 'clearDesc',
  ut: 'utDesc', bl: 'blDesc', reset_tracker: 'resetDesc'
};

let CMD_MAP = {};
for (const [id, aliases] of Object.entries(CMD_ALIAS)) {
  for (const [lang, word] of Object.entries(aliases)) {
    CMD_MAP[word.toLowerCase()] = { id, lang };
  }
}

function resolveCommand(raw) {
  const lower = raw.toLowerCase();
  return CMD_MAP[lower] || null;
}

async function handleCommand(msg) {
  const content = msg.content.trim();
  const lang = detectLang(content);
  const parts = content.split(/\s+/);
  const resolved = resolveCommand(parts[0]);
  if (!resolved) return;
  const cmd = resolved.id;
  if (resolved.lang === lang || resolved.lang === 'en' || parts[0].toLowerCase() === CMD_ALIAS[cmd]?.en) {
    // valid command for this language
  } else {
    return;
  }

  if (cmd === 'kill' && parts.length >= 2) {
    const query = parts.slice(1).join(' ');
    const boss = findBoss(query, lang);
    if (!boss) return msg.reply(`${t('bossNotFound', lang)} ${query}`);
    if (boss.weeklyRespawns) return msg.reply(t('scheduleOnly', lang));

    const now = Date.now();
    const endTime = now + boss.respawn * 1000;
    timers[boss.id] = { endTime, startedAt: now };
    resetBossCycle(boss.id);
    removeBossReactions(boss.id).catch(() => {});
    await saveTimers();
    await addHistory(boss.id, 'killed', now);
    const user = msg.author.toString();
    const nextStrEn = formatJST(endTime, 'en');
    const nextStrKo = formatJST(endTime, 'ko');
    const nextStrJa = formatJST(endTime, 'ja');
    await sendAllNotifs(
      `**${bossName(boss.id, 'en')}** ${t('defeated', 'en')}\n${t('killTime', 'en')}: ${formatJST(now, 'en')}\n${t('nextRespawn', 'en')}: ${nextStrEn}\n${t('byUser', 'en')} ${user}`,
      `**${bossName(boss.id, 'ko')}** ${t('defeated', 'ko')}\n${t('killTime', 'ko')}: ${formatJST(now, 'ko')}\n${t('nextRespawn', 'ko')}: ${nextStrKo}\n${t('byUser', 'ko')} ${user}`,
      `**${bossName(boss.id, 'ja')}** ${t('defeated', 'ja')}\n${t('killTime', 'ja')}: ${formatJST(now, 'ja')}\n${t('nextRespawn', 'ja')}: ${nextStrJa}\n${t('byUser', 'ja')} ${user}`,
      boss.id
    );
    speakDefeated(boss.id, endTime);
    return;
  }

  if (cmd === 'set' && parts.length >= 3) {
    const query = parts[1];
    let dateStr, timeStr;
    if (parts.length === 3) {
      dateStr = null;
      timeStr = parts[2];
    } else {
      dateStr = parts[2];
      timeStr = parts[3];
    }
    const boss = findBoss(query, lang);
    if (!boss) return msg.reply(`${t('bossNotFound', lang)} ${query}`);
    if (boss.weeklyRespawns) return msg.reply(t('scheduleOnly', lang));

    const hour = parseInt(timeStr.slice(0, 2));
    const minute = parseInt(timeStr.slice(2, 4));
    if (isNaN(hour) || isNaN(minute)) return msg.reply(t('invalidTime', lang));

    const now = new Date();
    let killedAt;
    if (dateStr) {
      const month = parseInt(dateStr.slice(0, 2));
      const day = parseInt(dateStr.slice(2, 4));
      killedAt = new Date(now.getFullYear(), month - 1, day, hour, minute).getTime();
    } else {
      const jstNow = new Date(now.getTime() + TZ_OFFSET);
      killedAt = new Date(Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate(), hour, minute)).getTime() - TZ_OFFSET;
    }
    if (isNaN(killedAt)) return msg.reply(t('invalidDate', lang));
    if (killedAt > Date.now()) return msg.reply(t('futureTime', lang));

    const endTime = boss.respawn ? killedAt + boss.respawn * 1000 : killedAt;
    timers[boss.id] = { endTime, startedAt: killedAt };
    resetBossCycle(boss.id);
    removeBossReactions(boss.id).catch(() => {});
    await saveTimers();
    await addHistory(boss.id, 'killed', killedAt);
    const user = msg.author.toString();
    const nextStrEn = formatJST(endTime, 'en');
    const nextStrKo = formatJST(endTime, 'ko');
    const nextStrJa = formatJST(endTime, 'ja');
    await sendAllNotifs(
      `**${bossName(boss.id, 'en')}** ${t('manualSet', 'en')}\n${t('killTime', 'en')}: ${formatJST(killedAt, 'en')}\n${t('nextRespawn', 'en')}: ${nextStrEn}\n${t('byUser', 'en')} ${user}`,
      `**${bossName(boss.id, 'ko')}** ${t('manualSet', 'ko')}\n${t('killTime', 'ko')}: ${formatJST(killedAt, 'ko')}\n${t('nextRespawn', 'ko')}: ${nextStrKo}\n${t('byUser', 'ko')} ${user}`,
      `**${bossName(boss.id, 'ja')}** ${t('manualSet', 'ja')}\n${t('killTime', 'ja')}: ${formatJST(killedAt, 'ja')}\n${t('nextRespawn', 'ja')}: ${nextStrJa}\n${t('byUser', 'ja')} ${user}`,
      boss.id
    );
    speakDefeated(boss.id, endTime);
    return;
  }

  if (cmd === 'miss' && parts.length >= 2) {
    const query = parts.slice(1).join(' ');
    const boss = findBoss(query, lang);
    if (!boss) return msg.reply(`${t('bossNotFound', lang)} ${query}`);
    if (boss.weeklyRespawns) return msg.reply(t('scheduleOnly', lang));

    const timer = timers[boss.id];
    if (!timer || !timer.endTime) return msg.reply(`${t('noTimer', lang)} ${bossName(boss.id, lang)}`);

    const killedAt = timer.endTime;
    const now = Date.now();
    const endTime = killedAt + 5 * 60 * 1000;
    timers[boss.id] = { endTime, startedAt: killedAt };
    resetBossCycle(boss.id);
    removeBossReactions(boss.id).catch(() => {});
    await saveTimers();
    await addHistory(boss.id, 'missed', now);
    const user = msg.author.toString();
    const nextStrEn = formatJST(endTime, 'en');
    const nextStrKo = formatJST(endTime, 'ko');
    const nextStrJa = formatJST(endTime, 'ja');
    await sendAllNotifs(
      `**${bossName(boss.id, 'en')}** ${t('missed', 'en')}\n${t('killTime', 'en')}: ${formatJST(killedAt, 'en')}\n${t('nextRespawn', 'en')}: ${nextStrEn}\n${t('byUser', 'en')} ${user}`,
      `**${bossName(boss.id, 'ko')}** ${t('missed', 'ko')}\n${t('killTime', 'ko')}: ${formatJST(killedAt, 'ko')}\n${t('nextRespawn', 'ko')}: ${nextStrKo}\n${t('byUser', 'ko')} ${user}`,
      `**${bossName(boss.id, 'ja')}** ${t('missed', 'ja')}\n${t('killTime', 'ja')}: ${formatJST(killedAt, 'ja')}\n${t('nextRespawn', 'ja')}: ${nextStrJa}\n${t('byUser', 'ja')} ${user}`,
      boss.id
    );
    return;
  }

  if (cmd === 'clear' && parts.length >= 2) {
    const query = parts.slice(1).join(' ');
    const boss = findBoss(query, lang);
    if (!boss) return msg.reply(`${t('bossNotFound', lang)} ${query}`);
    if (boss.weeklyRespawns) return msg.reply(t('scheduleOnly', lang));

    removeBossReactions(boss.id).catch(() => {});
    delete timers[boss.id];
    await saveTimers();
    const user = msg.author.toString();
    await sendAllNotifs(
      `**${bossName(boss.id, 'en')}** ${t('cleared', 'en')} ${t('byUser', 'en')} ${user}`,
      `**${bossName(boss.id, 'ko')}** ${t('cleared', 'ko')} ${t('byUser', 'ko')} ${user}`,
      `**${bossName(boss.id, 'ja')}** ${t('cleared', 'ja')} ${t('byUser', 'ja')} ${user}`
    );
    return;
  }

if (cmd === 'bl') {
    const schedule = BOSSES_DATA.filter(b => b.weeklyRespawns);
    const interval = BOSSES_DATA.filter(b => b.respawn);

    function buildList(list, title) {
      const G = '   ', S = 12, R = 10, B = 20, total = S + G.length + R + G.length + B;
      const header = padL(t('colSpawn', lang), S) + G + padC(t('colRemaining', lang), R) + G + padR(t('colBoss', lang), B);
      const sep = '-'.repeat(total);
      const lines = ['**' + title + '**', '```', header, sep];
      for (const boss of list) {
        const next = getNextSpawn(boss);
        const remaining = next ? formatRemaining(next.getTime() - Date.now()) : '---';
        const spawnStr = next ? formatSpawnTime(next.getTime()) : '---';
        lines.push(padL(spawnStr, S) + G + padC(remaining, R) + G + padR(bossName(boss.id, lang), B));
      }
      lines.push('```');
      return lines.join('\n');
    }

    await msg.reply(buildList(schedule, t('fixSchedule', lang)));
    return msg.reply(buildList(interval, t('fixInterval', lang)));
  }

  if (cmd === 'ut') {
    const now = Date.now();
    const cutoff24h = now + 86400000;

    const bosses = [];
    for (const boss of BOSSES_DATA) {
      const next = getNextSpawn(boss);
      if (next) {
        const time = next.getTime();
        if (time >= now && time <= cutoff24h) bosses.push({ boss, time });
      }
    }
    if (bosses.length === 0) return msg.reply(t('noActiveBosses', lang));
    bosses.sort((a, b) => a.time - b.time);
    const G = '   ', S = 12, R = 10, B = 20, total = S + G.length + R + G.length + B;
    const header = padL(t('colSpawn', lang), S) + G + padC(t('colRemaining', lang), R) + G + padR(t('colBoss', lang), B);
    const sep = '-'.repeat(total);
    const lines = ['**📅 ' + t('upcomingField', lang) + '**', '```', header, sep];
    for (const { boss, time } of bosses) {
      const remaining = formatRemaining(time - now);
      lines.push(padL(formatSpawnTime(time), S) + G + padC(remaining, R) + G + padR(bossName(boss.id, lang), B));
    }
    lines.push('```');
    return msg.reply(lines.join('\n'));
  }

  if (cmd === 'reset_tracker') {
    for (const boss of BOSSES_DATA) {
      if (boss.respawn) { delete timers[boss.id]; await removeBossReactions(boss.id).catch(() => {}); }
    }
    await saveTimers();
    const user = msg.author.toString();
    await sendAllNotifs(
      `**Tracker Reset** — ${t('allReset', 'en')} ${t('byUser', 'en')} ${user}`,
      `**트래커 초기화** — ${t('allReset', 'ko')} ${t('byUser', 'ko')} ${user}`,
      `**トラッカーリセット** — ${t('allReset', 'ja')} ${t('byUser', 'ja')} ${user}`
    );
    return;
  }

  if (cmd === 'astra' || cmd === 'tracker_commands' || content.toLowerCase() === '/tracker_commands') {
    const help = ['**ASTRA BOSS TIMER Commands**'];
    for (const [id, aliases] of Object.entries(CMD_ALIAS)) {
      const word = aliases[lang] || aliases.en;
      help.push(`\`${word} ${CMD_PARAMS[id]}\` — ${t(CMD_DESC[id], lang)}`);
    }
    help.push(`\`/setup\` — ${t('setupDesc', lang)}`);
    return msg.reply(help.join('\n').slice(0, 1900));
  }
}

let notifInterval = null;

function startNotifLoop() {
  if (notifInterval) clearInterval(notifInterval);
  notifInterval = setInterval(async () => {
    try {
      const now = Date.now();
      for (const [id, info] of Object.entries(timers)) {
        try {
        if (!info || !info.endTime) continue;
        const boss = BOSSES_DATA.find(b => b.id === id);
        if (!boss) continue;
        const hasButtons = !!boss.respawn;

        // Auto-advance schedule bosses that are way past spawn (e.g. on restart)
        const remainingMs = info.endTime - now;
        if (!boss.respawn && remainingMs < -300000) {
          const next = getNextSpawn(boss);
          if (next) { timers[id] = { endTime: next.getTime(), startedAt: next.getTime(), weekly: true }; continue; }
        }

        const cycleKey = `${id}_${info.endTime}`;

        // TTS countdown: speak every minute from 5 down to 1
        if (remainingMs > 0 && remainingMs <= 5 * 60 * 1000) {
          const minutesLeft = Math.ceil(remainingMs / 60000);
          const spokeKey = `${id}_${info.endTime}_${minutesLeft}`;
          if (!ttsSpokenMinutes.has(spokeKey)) {
            ttsSpokenMinutes.set(spokeKey, true);
            const ttsFn = TTS_SPAWN_IN[config.voiceLang] || TTS_SPAWN_IN.en;
            speak(ttsFn(bossName(id, config.voiceLang), minutesLeft));
          }
        }

        if (remainingMs <= 5 * 60 * 1000 && remainingMs > 0 && !sentSoonNotifs.has(cycleKey)) {
          sentSoonNotifs.add(cycleKey);
          const notifId = `${id}_soon_${info.endTime}`;
          const msgs = await sendAllNotifs(
            `**${bossName(id, 'en')}** ${t('spawning', 'en')}\n${t('spawnTime', 'en')}: ${formatJST(info.endTime, 'en')}`,
            `**${bossName(id, 'ko')}** ${t('spawning', 'ko')}\n${t('spawnTime', 'ko')}: ${formatJST(info.endTime, 'ko')}`,
            `**${bossName(id, 'ja')}** ${t('spawning', 'ja')}\n${t('spawnTime', 'ja')}: ${formatJST(info.endTime, 'ja')}`,
            id, hasButtons
          );
          if (msgs.en || msgs.ko || msgs.ja) notifMessageCache.set(id, msgs);
          const data = { bossId: id, type: 'spawning', timestamp: now };
          for (const l of LANG_LIST) { if (msgs[l]) data[l] = msgs[l].id; }
          await db.collection('notifications').doc(notifId).set(data);
        }

        if (remainingMs <= 0 && !sentSpawnedNotifs.has(cycleKey)) {
          sentSpawnedNotifs.add(cycleKey);
          const spawnFn = TTS_SPAWNED[config.voiceLang] || TTS_SPAWNED.en;
          speak(spawnFn(bossName(id, config.voiceLang)));
          
          const cached = notifMessageCache.get(id);
          if (cached) {
            const edits = [];
            if (cached.en) edits.push(cached.en.edit({ content: `**${bossName(id, 'en')}** ${t('spawned', 'en')}`, components: cached.en.components }).catch(() => {}));
            if (cached.ko) edits.push(cached.ko.edit({ content: `**${bossName(id, 'ko')}** ${t('spawned', 'ko')}`, components: cached.ko.components }).catch(() => {}));
            if (cached.ja) edits.push(cached.ja.edit({ content: `**${bossName(id, 'ja')}** ${t('spawned', 'ja')}`, components: cached.ja.components }).catch(() => {}));
            await Promise.all(edits);
          } else {
            await sendAllNotifs(
              `**${bossName(id, 'en')}** ${t('spawned', 'en')}`,
              `**${bossName(id, 'ko')}** ${t('spawned', 'ko')}`,
              `**${bossName(id, 'ja')}** ${t('spawned', 'ja')}`,
              false
            );
          }
          notifMessageCache.delete(id);
        }
        } catch (e) { /* skip failed boss, continue loop */ }
      }
    } catch (e) {
      console.error('Notif loop error:', e);
    }
  }, 3000);
  setInterval(() => { sentSoonNotifs.clear(); sentSpawnedNotifs.clear(); ttsSpokenMinutes.clear(); }, 3600000);
}

function buildDetailedHelp() {
  return [
    '__**ASTRA BOSS TIMER — 모든 명령어 / 全コマンド / All Commands**__',
    '',
    '**🇺🇸 English**',
    '`kill <bossname>` — Mark boss dead. Records current JST time as kill time.',
    '`set <bossname> [MMDD] <HHMM>` — Manual kill time. Date optional. Ex: `set Venatus 0721 1430` or `set Venatus 1430`',
    '`miss <bossname>` — Mark missed. Only works with active timer. Adds 5 min penalty.',
    '`clear <bossname>` — Clear boss timer.',
    '`bl` — Boss list. Shows all bosses with remaining time and spawn date/time.',
    '`ut` — Today & tomorrow bosses sorted by remaining time.',
    '`reset_tracker` — Reset all interval boss timers.',
    '`astra help` — Show this help (or just `astra`).',
    '`/setup` — Configure notification channels.',
    '`/astra` — Show this help (slash version).',
    '`/import` — Import boss timers from paste data.',
    '',
    '**🇰🇷 한국어**',
    '`처치 <보스명>` — 보스 처치 기록. 현재 JST 시간을 처치 시간으로 저장.',
    '`설정 <보스명> [월일] <시분>` — 수동 처치 시간. 날짜 생략 가능. 예: `설정 베나투스 0721 1430` 또는 `설정 베나투스 1430`',
    '`놓침 <보스명>` — 보스 놓침. 활성 타이머 있을 때만 동작. 5분 패널티.',
    '`초기화 <보스명>` — 보스 타이머 초기화.',
    '`목록` — 전체 보스 목록. 남은 시간과 출현 시간 표시.',
    '`곧` — 오늘과 내일 출현 보스를 남은 시간순으로 표시.',
    '`초기화_전체` — 모든 고정 주기 보스 타이머 초기화.',
    '`도움` or `도움말` — 도움말 표시.',
    '`/설정` — 알림 채널을 설정합니다.',
    '`/도움말` — 모든 명령어 도움말을 표시합니다.',
    '`/가져오기` — 붙여넣기 데이터에서 보스 타이머를 가져옵니다.',
    '',
    '**🇯🇵 日本語**',
    '`討伐 <ボス名>` — ボス討伐記録。現在のJST時間を討伐時間として保存。',
    '`設定 <ボス名> [月日] <時分>` — 手動討伐時間。日付省略可。例: `設定 ベナトゥス 0721 1430` 又は `設定 ベナトゥス 1430`',
    '`逃し <ボス名>` — 取り逃し記録。アクティブタイマー必須。5分ペナルティ。',
    '`解除 <ボス名>` — ボスタイマーをクリア。',
    '`一覧` — 全ボス一覧。残り時間と出現時間を表示。',
    '`まもなく` — 今日と明日の出現ボスを残り時間順に表示。',
    '`全解除` — 全固定周期ボスタイマーをリセット。',
    '`へるぷ` — ヘルプを表示。',
    '`/せってい` — 通知チャンネルを設定します。',
    '`/へるぷ` — 全コマンドヘルプを表示します。',
    '`/いんぽーと` — 貼り付けデータからボスタイマーをインポートします。',
    '',
    '**💡 Tips / 팁 / ヒント**',
    '• All times JST | 모든 시간 JST | 全時間 JST',
    '• Date: MMDD (0721=Jul 21) | 월일 (0721=7월21일) | 月日 (0721=7月21日)',
    '• Time: HHMM=24h (1430=2:30PM) | 24시간제 (1430=오후2:30) | 24時間制 (1430=14:30)',
    '• Auto-detect language | 언어 자동 감지 | 言語自動検出',
    '• `set` date optional, defaults to today | `설정` 날짜 생략 시 오늘 | `設定` 日付省略で今日',
    '• Notifications have react buttons | 알림 반응 버튼 있음 | 通知にリアクションボタン付き',
    '• Action on any channel hides all buttons | 모든 채널 버튼 동시 숨김 | 全チャンネル同時非表示',
    '• `/import` to batch import timers | `/가져오기` 일괄 가져오기 | `/いんぽーと` 一括インポート',
  ].join('\n');
}

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

  const resolved = resolveCommand(msg.content.trim().split(/\s+/)[0]);
  if (resolved || content === '/tracker_commands') {
    await handleCommand(msg);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isModalSubmit() && interaction.customId === 'importModal') {
    const text = interaction.fields.getTextInputValue('importData');
    const lines = text.split('\n');
    const updatedBosses = new Set();
    const jstNow = new Date(Date.now() + TZ_OFFSET);
    const todayStart = new Date(Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate())).getTime() - TZ_OFFSET;
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const lower = trimmed.toLowerCase();
      if (lower.startsWith('fix schedule') || lower.startsWith('fix interval') || trimmed.includes('스케줄') || trimmed.includes('고정 주기') || trimmed.includes('インターバル') || trimmed.includes('スケジュール')) continue;
      const match = trimmed.match(/^(.+?)\s+-\s+(\d+)h\s+(\d+)m\s+(\d+)\/(\d+),\s+(\d+):(\d+)\s+JST$/);
      if (!match) continue;
      const [, bossNameStr, , , month, day, hour, minute] = match;
      const boss = findBoss(bossNameStr.trim());
      if (!boss) continue;
      const y = jstNow.getUTCFullYear();
      const spawnTime = Date.UTC(y, parseInt(month) - 1, parseInt(day), parseInt(hour) - 9, parseInt(minute));
      if (!isNaN(spawnTime)) {
        if (boss.respawn) {
          timers[boss.id] = { endTime: spawnTime, startedAt: spawnTime - boss.respawn * 1000 };
        } else {
          timers[boss.id] = { endTime: spawnTime, startedAt: spawnTime, weekly: true };
        }
        updatedBosses.add(boss.id);
      }
    }
    for (const id of updatedBosses) removeBossReactions(id).catch(() => {});
    await saveTimers();
    return interaction.reply({ content: t('importSuccess', interaction.locale?.startsWith('ko') ? 'ko' : interaction.locale?.startsWith('ja') ? 'ja' : 'en'), ephemeral: true });
  }

  if (interaction.isCommand()) {
    const cmdName = interaction.commandName;
    const isSetup = cmdName === 'setup' || cmdName === '설정' || cmdName === 'せってい';
    const isHelp = cmdName === 'astra' || cmdName === 'tracker_commands' || cmdName === '도움말' || cmdName === 'へるぷ';
    const isImport = cmdName === 'import' || cmdName === '가져오기' || cmdName === 'いんぽーと';

    if (isImport) {
      const modal = new ModalBuilder()
        .setCustomId('importModal')
        .setTitle('Import Boss Timers / ボスタイマーをインポート / 보스 타이머 가져오기');
      const input = new TextInputBuilder()
        .setCustomId('importData')
        .setLabel('Paste boss timer data')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }

    if (isSetup) {
        const enCh = interaction.options.getChannel('english_channel');
        const koCh = interaction.options.getChannel('korean_channel');
        const jaCh = interaction.options.getChannel('japanese_channel');
        const voiceCh = interaction.options.getChannel('voice_channel');
        const voiceLang = interaction.options.getString('voice_language') || config.voiceLang || 'en';

        if (enCh) config.channels.en = enCh.id;
        if (koCh) config.channels.ko = koCh.id;
        if (jaCh) config.channels.ja = jaCh.id;
        if (voiceCh) { config.voice.en = voiceCh.id; config.voice.ko = voiceCh.id; config.voice.ja = voiceCh.id; }
        config.voiceLang = voiceLang;
        await saveConfig();
        await interaction.deferReply({ ephemeral: true });
        return interaction.editReply({ content: t('setupSuccess', voiceLang) });
      }
      if (isHelp) {
        return interaction.reply({ content: buildDetailedHelp().slice(0, 2000), ephemeral: true });
      }
    return;
  }

  const lang = detectLang(interaction.message.content);
  const customId = interaction.customId;
  const parts = customId.split('_');
  const action = parts[0];
  const bossId = parts.slice(1).join('_');

  if (!bossId) { interaction.deferUpdate().catch(() => {}); return; }
  const boss = BOSSES_DATA.find(b => b.id === bossId);
  if (!boss || !boss.respawn) { interaction.deferUpdate().catch(() => {}); return; }

  const now = Date.now();

  if (action === 'markdead') {
    interaction.deferUpdate().catch(() => {});
    const endTime = now + boss.respawn * 1000;
    timers[boss.id] = { endTime, startedAt: now };
    resetBossCycle(boss.id);
    await removeBossReactions(boss.id).catch(() => {});
    await saveTimers();
    await addHistory(boss.id, 'killed', now);
    const user = interaction.user.toString();
    const nextStrEn = formatJST(endTime, 'en');
    const nextStrKo = formatJST(endTime, 'ko');
    const nextStrJa = formatJST(endTime, 'ja');
    await sendAllNotifs(
      `**${bossName(bossId, 'en')}** ${t('defeated', 'en')}\n${t('killTime', 'en')}: ${formatJST(now, 'en')}\n${t('nextRespawn', 'en')}: ${nextStrEn}\n${t('byUser', 'en')} ${user}`,
      `**${bossName(bossId, 'ko')}** ${t('defeated', 'ko')}\n${t('killTime', 'ko')}: ${formatJST(now, 'ko')}\n${t('nextRespawn', 'ko')}: ${nextStrKo}\n${t('byUser', 'ko')} ${user}`,
      `**${bossName(bossId, 'ja')}** ${t('defeated', 'ja')}\n${t('killTime', 'ja')}: ${formatJST(now, 'ja')}\n${t('nextRespawn', 'ja')}: ${nextStrJa}\n${t('byUser', 'ja')} ${user}`,
      bossId
    );
    speakDefeated(bossId, endTime);
    return;
  }

  if (action === 'missed') {
    interaction.deferUpdate().catch(() => {});
    const timer = timers[boss.id];
    const killedAt = timer?.endTime || now;
    const endTime = killedAt + 5 * 60 * 1000;
    timers[boss.id] = { endTime, startedAt: killedAt };
    resetBossCycle(boss.id);
    await removeBossReactions(boss.id).catch(() => {});
    await saveTimers();
    await addHistory(boss.id, 'missed', now);
    const user = interaction.user.toString();
    const nextStrEn = formatJST(endTime, 'en');
    const nextStrKo = formatJST(endTime, 'ko');
    const nextStrJa = formatJST(endTime, 'ja');
    await sendAllNotifs(
      `**${bossName(bossId, 'en')}** ${t('missed', 'en')}\n${t('killTime', 'en')}: ${formatJST(killedAt, 'en')}\n${t('nextRespawn', 'en')}: ${nextStrEn}\n${t('byUser', 'en')} ${user}`,
      `**${bossName(bossId, 'ko')}** ${t('missed', 'ko')}\n${t('killTime', 'ko')}: ${formatJST(killedAt, 'ko')}\n${t('nextRespawn', 'ko')}: ${nextStrKo}\n${t('byUser', 'ko')} ${user}`,
      `**${bossName(bossId, 'ja')}** ${t('missed', 'ja')}\n${t('killTime', 'ja')}: ${formatJST(killedAt, 'ja')}\n${t('nextRespawn', 'ja')}: ${nextStrJa}\n${t('byUser', 'ja')} ${user}`,
      bossId
    );
    return;
  }
});

client.once('ready', async () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  await loadConfig();
  await loadTimers();

  // Clean up orphaned notifications from previous sessions
  try {
    const snapshot = await db.collection('notifications').where('type', '==', 'spawning').get();
    for (const doc of snapshot.docs) {
      const data = doc.data();
      const timer = timers[data.bossId];
      const docEndTime = parseInt(doc.id.split('_').pop());
      if (!docEndTime) continue;
      if (timer && timer.endTime === docEndTime) {
        // Still active — repopulate cache
        const msgs = {};
        for (const l of LANG_LIST) {
          if (data[l] && config.channels[l]) {
            const channel = client.channels.cache.get(config.channels[l]);
            if (channel) {
              try { msgs[l] = await channel.messages.fetch(data[l]); } catch {}
            }
          }
        }
        if (msgs.en || msgs.ko || msgs.ja) notifMessageCache.set(data.bossId, msgs);
      } else {
        // Orphan — remove buttons
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
  }];

  try {
    await client.application.commands.set(commands);
    console.log('✅ Slash commands registered');
  } catch (e) {
    console.error('Slash command registration error:', e);
  }

});

const server = createServer((_, res) => { res.writeHead(200); res.end('OK'); });
const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log(`Health check server on port ${PORT}`));

client.login(process.env.DISCORD_TOKEN);



