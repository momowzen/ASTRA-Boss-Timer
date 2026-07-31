import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

let client, config, db, timers, bossNameFn, tFn, formatJSTFn, LANG_LIST, BOSSES_DATA;
let getNextSpawnFn, sendAllNotifs, removeBossReactions, resetBossCycle;

let notifMessageCache;
let sentSoonNotifs;
let sentSpawnedNotifs;
let ttsSpokenMinutes;
let notifInterval;
let speakFn, speakFromNotifLoopFn, speakSpawnedFn;

export function initNotifs(deps) {
  client = deps.client;
  config = deps.config;
  db = deps.db;
  timers = deps.timers;
  bossNameFn = deps.bossName;
  tFn = deps.t;
  formatJSTFn = deps.formatJST;
  LANG_LIST = deps.LANG_LIST;
  BOSSES_DATA = deps.BOSSES_DATA;
  getNextSpawnFn = deps.getNextSpawn;
  notifMessageCache = deps.notifMessageCache;
  sentSoonNotifs = deps.sentSoonNotifs;
  sentSpawnedNotifs = deps.sentSpawnedNotifs;
  ttsSpokenMinutes = deps.ttsSpokenMinutes;
  speakFn = deps.speak;
  speakFromNotifLoopFn = deps.speakFromNotifLoop;
  speakSpawnedFn = deps.speakSpawned;
}

function getChannel(lang) {
  const channelId = config.channels[lang];
  if (!channelId) return null;
  return client.channels.cache.get(channelId) || null;
}

export async function sendNotif(lang, content, bossId, buttons = false) {
  const channel = getChannel(lang);
  if (!channel) return null;
  try {
    const components = buttons ? [new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder().setCustomId(`markdead_${bossId || '0'}`).setStyle(ButtonStyle.Danger).setLabel(tFn('markDeadBtn', lang)).setEmoji('💀'),
        new ButtonBuilder().setCustomId(`missed_${bossId || '0'}`).setStyle(ButtonStyle.Secondary).setLabel(tFn('missedBtn', lang)).setEmoji('⏰')
      )] : [];
    return await channel.send({ content, components });
  } catch (e) {
    return null;
  }
}

export async function sendAllNotifsFn(contentEn, contentKo, contentJa, bossId, buttons = false) {
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

export async function removeBossReactionsFn(bossId, contents = null) {
  const cached = notifMessageCache.get(bossId);
  if (cached) {
    const tasks = [];
    for (const [lang, msg] of Object.entries(cached)) {
      if (msg) tasks.push(msg.edit({ content: contents?.[lang] || msg.content, components: [] }).catch(() => {}));
    }
    await Promise.all(tasks);
    notifMessageCache.delete(bossId);
    return true;
  }
  const snapshot = await db.collection('notifications').where('bossId', '==', bossId).get();
  if (snapshot.empty) return false;
  let anyEdited = false;
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
          if (msg) { await msg.edit({ content: contents?.[l] || msg.content, components: [] }); anyEdited = true; }
        } catch (e) {}
      })());
    }
  }
  await Promise.all(allTasks);
  return anyEdited;
}

export function resetBossCycleFn(bossId) {
  for (const key of [...sentSoonNotifs]) { if (key.startsWith(bossId + '_')) sentSoonNotifs.delete(key); }
  for (const key of [...sentSpawnedNotifs]) { if (key.startsWith(bossId + '_')) sentSpawnedNotifs.delete(key); }
  notifMessageCache.delete(bossId);
}

export async function startNotifLoop() {
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

        const remainingMs = info.endTime - now;
        if (!boss.respawn && remainingMs < -300000) {
          const next = getNextSpawnFn(boss);
          if (next) { timers[id] = { endTime: next.getTime(), startedAt: next.getTime(), weekly: true }; continue; }
        }

        const cycleKey = `${id}_${info.endTime}`;

        if (remainingMs > 0 && remainingMs <= 5 * 60 * 1000) {
          const minutesLeft = Math.ceil(remainingMs / 60000);
          const spokeKey = `${id}_${info.endTime}_${minutesLeft}`;
          if (!ttsSpokenMinutes.has(spokeKey)) {
            ttsSpokenMinutes.set(spokeKey, true);
            speakFromNotifLoopFn(bossNameFn(id, config.voiceLang), minutesLeft);
          }
        }

        if (remainingMs <= 5 * 60 * 1000 && remainingMs > 0 && !sentSoonNotifs.has(cycleKey)) {
          sentSoonNotifs.add(cycleKey);
          const notifId = `${id}_soon_${info.endTime}`;
          const prefix = config.pingHere ? '\n@here' : '';
          const msgs = await sendAllNotifsFn(
            `[SPAWNING] ${bossNameFn(id, 'en')}\nSpawn: ${formatJSTFn(info.endTime, 'en')}${prefix}`,
            `[출현 예정] ${bossNameFn(id, 'ko')}\n출현: ${formatJSTFn(info.endTime, 'ko')}${prefix}`,
            `[出現予定] ${bossNameFn(id, 'ja')}\n出現: ${formatJSTFn(info.endTime, 'ja')}${prefix}`,
            id, hasButtons
          );
          if (msgs.en || msgs.ko || msgs.ja) notifMessageCache.set(id, msgs);
          const data = { bossId: id, type: 'spawning', timestamp: now };
          for (const l of LANG_LIST) { if (msgs[l]) data[l] = msgs[l].id; }
          await db.collection('notifications').doc(notifId).set(data);
        }

        if (remainingMs <= 0 && !sentSpawnedNotifs.has(cycleKey)) {
          sentSpawnedNotifs.add(cycleKey);
          speakSpawnedFn(bossNameFn(id, config.voiceLang));
          
          const cached = notifMessageCache.get(id);
          if (cached) {
            const edits = [];
          if (cached.en) edits.push(cached.en.edit({ content: `[SPAWNED] ${bossNameFn(id, 'en')}`, components: cached.en.components }).catch(() => {}));
          if (cached.ko) edits.push(cached.ko.edit({ content: `[출현] ${bossNameFn(id, 'ko')}`, components: cached.ko.components }).catch(() => {}));
          if (cached.ja) edits.push(cached.ja.edit({ content: `[出現] ${bossNameFn(id, 'ja')}`, components: cached.ja.components }).catch(() => {}));
            await Promise.all(edits);
          } else {
            await sendAllNotifsFn(
              `[SPAWNED] ${bossNameFn(id, 'en')}`,
              `[출현] ${bossNameFn(id, 'ko')}`,
              `[出現] ${bossNameFn(id, 'ja')}`,
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
  setInterval(() => {
    const now = Date.now();
    for (const set of [sentSoonNotifs, sentSpawnedNotifs]) {
      for (const key of set) {
        const ts = parseInt(key.split('_').pop());
        if (ts && ts < now - 300000) set.delete(key);
      }
    }
    ttsSpokenMinutes.clear();
  }, 3600000);
}
