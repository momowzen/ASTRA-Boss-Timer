import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

let client, config, db, bossNameFn, tFn, formatJSTFn, LANG_LIST, BOSSES_DATA;
let getNextSpawnFn, sendAllNotifs, removeBossReactions, resetBossCycle, saveConfigFn, saveTimersFn;

let mainCtx;
let allTrackerCtxsFn;
let notifInterval;
let cleanupInterval;
let speakFn, speakFromNotifLoopFn, speakSpawnedFn;

const TTS_MINUTES = new Set([10, 5, 4, 3, 2, 1]);

export function initNotifs(deps) {
  client = deps.client;
  config = deps.config;
  db = deps.db;
  bossNameFn = deps.bossName;
  tFn = deps.t;
  formatJSTFn = deps.formatJST;
  LANG_LIST = deps.LANG_LIST;
  BOSSES_DATA = deps.BOSSES_DATA;
  getNextSpawnFn = deps.getNextSpawn;
  mainCtx = deps.mainCtx;
  allTrackerCtxsFn = deps.allTrackerCtxs;
  speakFn = deps.speak;
  speakFromNotifLoopFn = deps.speakFromNotifLoop;
  speakSpawnedFn = deps.speakSpawned;
  saveConfigFn = deps.saveConfig;
  saveTimersFn = deps.saveTimers;
}

function getChannel(lang) {
  const channelId = config.channels[lang];
  if (!channelId) return null;
  return client.channels.cache.get(channelId) || null;
}

function channelFor(ctx, lang) {
  if (!ctx || ctx.id === 'main') return getChannel(lang);
  return ctx.channel ? client.channels.cache.get(ctx.channel) || null : null;
}

function getCurrentGuild(bossId) {
  const rot = config.rotation || {};
  return rot.bossGuild?.[bossId] || null;
}

async function sendToChannel(channel, lang, content, bossId, buttons = false) {
  if (!channel) return null;
  try {
    const components = buttons ? [new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder().setCustomId(`markdead_${bossId || '0'}`).setStyle(ButtonStyle.Danger).setLabel(tFn('markDeadBtn', lang)).setEmoji('💀'),
        new ButtonBuilder().setCustomId(`missed_${bossId || '0'}`).setStyle(ButtonStyle.Secondary).setLabel(tFn('missedBtn', lang)).setEmoji('⏰')
      )] : [];
    return await channel.send({ content, components });
  } catch (e) {
    console.error(`[NOTIF] send failed (${lang}, ${bossId || 'n/a'}):`, e.message);
    return null;
  }
}

export async function sendNotif(lang, content, bossId, buttons = false) {
  return sendToChannel(getChannel(lang), lang, content, bossId, buttons);
}

export async function sendAllNotifsFn(contentEn, contentKo, contentJa, bossId, buttons = false, ctx = mainCtx) {
  if (ctx && ctx.id !== 'main') {
    const byLang = { en: contentEn, ko: contentKo, ja: contentJa };
    const msg = await sendToChannel(channelFor(ctx, ctx.lang), ctx.lang, byLang[ctx.lang] ?? contentEn, bossId, buttons);
    return msg ? { [ctx.lang]: msg } : {};
  }
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

export async function removeBossReactionsFn(bossId, contents = null, ctx = mainCtx) {
  const c = ctx || mainCtx;
  const cached = c.notifCache.get(bossId);
  const cached10 = c.notifCache10 ? c.notifCache10.get(bossId) : null;
  if (cached || cached10) {
    let anyEdited = false;
    const tasks = [];
    for (const set of [cached, cached10]) {
      if (!set) continue;
      for (const [lang, msg] of Object.entries(set)) {
        if (msg) tasks.push((async () => {
          try { await msg.edit({ content: contents?.[lang] || msg.content, components: [] }); anyEdited = true; } catch (e) { console.warn(`[NOTIF] edit failed (${lang}, ${bossId}):`, e.message); }
        })());
      }
    }
    await Promise.all(tasks);
    c.notifCache.delete(bossId);
    if (c.notifCache10) c.notifCache10.delete(bossId);
    return anyEdited;
  }
  const snapshot = await db.collection('notifications').where('bossId', '==', bossId).get();
  if (snapshot.empty) return false;
  const matched = snapshot.docs.filter(d => (d.data().tracker || 'main') === c.id);
  if (matched.length === 0) return false;
  const langs = c.id === 'main' ? LANG_LIST : [c.lang];
  let anyEdited = false;
  const allTasks = [];
  for (const doc of matched) {
    const data = doc.data();
    for (const l of langs) {
      const msgId = data[l];
      if (!msgId) continue;
      const channel = channelFor(c, l);
      if (!channel) continue;
      allTasks.push((async () => {
        try {
          const msg = await channel.messages.fetch(msgId);
          if (msg) { await msg.edit({ content: contents?.[l] || msg.content, components: [] }); anyEdited = true; }
        } catch (e) { console.warn(`[NOTIF] edit failed (${l}, ${bossId}):`, e.message); }
      })());
    }
  }
  await Promise.all(allTasks);
  for (const doc of matched) {
    try { await doc.ref.delete(); } catch (e) { console.warn(`[NOTIF] doc delete failed (${bossId}):`, e.message); }
  }
  return anyEdited;
}

export function resetBossCycleFn(bossId, ctx = mainCtx) {
  const c = ctx || mainCtx;
  for (const key of [...c.sentSoon]) { if (key.startsWith(bossId + '_')) c.sentSoon.delete(key); }
  for (const key of [...c.sentSoon10]) { if (key.startsWith(bossId + '_')) c.sentSoon10.delete(key); }
  for (const key of [...c.sentSpawned]) { if (key.startsWith(bossId + '_')) c.sentSpawned.delete(key); }
  c.notifCache.delete(bossId);
  c.notifCache10.delete(bossId);
}

async function runNotifCycle(ctx) {
  const now = Date.now();
  const timers = ctx.timers;
  for (const [id, info] of Object.entries(timers)) {
    try {
    if (!info || !info.endTime) continue;
    if (timers[id] !== info) continue;
    const boss = BOSSES_DATA.find(b => b.id === id);
    if (!boss) continue;
    const hasButtons = !!boss.respawn;

    const remainingMs = info.endTime - now;
    if (!boss.respawn && remainingMs < -300000) {
      const next = getNextSpawnFn(boss, ctx.timers);
      if (next) {
        timers[id] = { endTime: next.getTime(), startedAt: next.getTime(), weekly: true };
        await saveTimersFn(ctx);
        continue;
      }
    }

    const cycleKey = `${id}_${info.endTime}`;

    if (ctx.id === 'main' && remainingMs > 0 && remainingMs <= 10 * 60 * 1000) {
      const minutesLeft = Math.ceil(remainingMs / 60000);
      const spokeKey = `${id}_${info.endTime}_${minutesLeft}`;
      if (TTS_MINUTES.has(minutesLeft) && !ctx.ttsSpoken.has(spokeKey)) {
        ctx.ttsSpoken.set(spokeKey, true);
        console.log(`[TTS] ${id} minute ${minutesLeft} spokeKey=${spokeKey}`);
        speakFromNotifLoopFn(bossNameFn(id, config.voiceLang), minutesLeft, ctx.id);
      }
    }

    if (remainingMs <= 10 * 60 * 1000 && remainingMs > 0 && !ctx.sentSoon10.has(cycleKey)) {
      ctx.sentSoon10.add(cycleKey);
      console.log(`[NOTIF] ${id} SOON cycleKey=${cycleKey} tracker=${ctx.id}`);
      const trackerPrefix = ctx.id === 'main' ? '' : `${ctx.id}_`;
      const notifId = `${trackerPrefix}${id}_soon10_${info.endTime}`;
      const prefix = ctx.id === 'main' && config.pingHere ? '\n@here' : '';
      const guild = getCurrentGuild(id);
      let guildLine = '';
      if (guild != null) {
        guildLine = `\n${tFn('assignedTo', 'en')}: ${guild}`;
      }
      const msgs = await sendAllNotifsFn(
        `**[**\`SOON\`**] ${bossNameFn(id, 'en')}**\nSpawn: ${formatJSTFn(info.endTime, 'en')}${guildLine}${prefix}`,
        `**[**\`출현 임박\`**] ${bossNameFn(id, 'ko')}**\n출현: ${formatJSTFn(info.endTime, 'ko')}${guild ? `\n${tFn('assignedTo', 'ko')}: ${guild}` : ''}${prefix}`,
        `**[**\`出現間近\`**] ${bossNameFn(id, 'ja')}**\n出現: ${formatJSTFn(info.endTime, 'ja')}${guild ? `\n${tFn('assignedTo', 'ja')}: ${guild}` : ''}${prefix}`,
        id, hasButtons, ctx
      );
      if (timers[id] !== info) continue;
      if (Object.keys(msgs).length > 0) ctx.notifCache10.set(id, msgs);
      const data = { bossId: id, type: 'soon10', timestamp: now, tracker: ctx.id };
      for (const l of LANG_LIST) { if (msgs[l]) data[l] = msgs[l].id; }
      await db.collection('notifications').doc(notifId).set(data);
    }

    if (remainingMs <= 5 * 60 * 1000 && remainingMs > 0 && !ctx.sentSoon.has(cycleKey)) {
      ctx.sentSoon.add(cycleKey);
      console.log(`[NOTIF] ${id} spawning soon cycleKey=${cycleKey} tracker=${ctx.id}`);
      const trackerPrefix = ctx.id === 'main' ? '' : `${ctx.id}_`;
      const notifId = `${trackerPrefix}${id}_soon_${info.endTime}`;
      const prefix = ctx.id === 'main' && config.pingHere ? '\n@here' : '';
      const guild = getCurrentGuild(id);
      let guildLine = '';
      if (guild != null) {
        guildLine = `\n${tFn('assignedTo', 'en')}: ${guild}`;
      }
      const msgs = await sendAllNotifsFn(
        `**[**\`SPAWNING\`**] ${bossNameFn(id, 'en')}**\nSpawn: ${formatJSTFn(info.endTime, 'en')}${guildLine}${prefix}`,
        `**[**\`출현 예정\`**] ${bossNameFn(id, 'ko')}**\n출현: ${formatJSTFn(info.endTime, 'ko')}${guild ? `\n${tFn('assignedTo', 'ko')}: ${guild}` : ''}${prefix}`,
        `**[**\`出現予定\`**] ${bossNameFn(id, 'ja')}**\n出現: ${formatJSTFn(info.endTime, 'ja')}${guild ? `\n${tFn('assignedTo', 'ja')}: ${guild}` : ''}${prefix}`,
        id, hasButtons, ctx
      );
      if (timers[id] !== info) continue;
      if (Object.keys(msgs).length > 0) ctx.notifCache.set(id, msgs);
      const data = { bossId: id, type: 'spawning', timestamp: now, tracker: ctx.id };
      for (const l of LANG_LIST) { if (msgs[l]) data[l] = msgs[l].id; }
      await db.collection('notifications').doc(notifId).set(data);
    }

    if (remainingMs <= 0 && remainingMs > -300000 && !ctx.sentSpawned.has(cycleKey)) {
      if (timers[id] !== info) continue;
      ctx.sentSpawned.add(cycleKey);
      console.log(`[SPAWNED] ${id} cycleKey=${cycleKey} tracker=${ctx.id}`);
      speakSpawnedFn(bossNameFn(id, config.voiceLang), ctx.id);

      const guild = getCurrentGuild(id);
      let guildLine = '';
      if (guild != null) {
        guildLine = `\n${tFn('assignedTo', 'en')}: ${guild}`;
      }
      const cached = ctx.notifCache.get(id);
      const cached10 = ctx.notifCache10.get(id);
      if (cached || cached10) {
        const edits = [];
        const pushEdits = (set) => {
          if (!set) return;
          if (set.en) edits.push(set.en.edit({ content: `**[**\`SPAWNED\`**] ${bossNameFn(id, 'en')}**${guildLine}`, components: set.en.components }).catch(() => {}));
          if (set.ko) edits.push(set.ko.edit({ content: `**[**\`출현\`**] ${bossNameFn(id, 'ko')}**${guild ? `\n${tFn('assignedTo', 'ko')}: ${guild}` : ''}`, components: set.ko.components }).catch(() => {}));
          if (set.ja) edits.push(set.ja.edit({ content: `**[**\`出現\`**] ${bossNameFn(id, 'ja')}**${guild ? `\n${tFn('assignedTo', 'ja')}: ${guild}` : ''}`, components: set.ja.components }).catch(() => {}));
        };
        pushEdits(cached);
        pushEdits(cached10);
        await Promise.all(edits);
      } else {
        await sendAllNotifsFn(
          `**[**\`SPAWNED\`**] ${bossNameFn(id, 'en')}**${guildLine}`,
          `**[**\`출현\`**] ${bossNameFn(id, 'ko')}**${guild ? `\n${tFn('assignedTo', 'ko')}: ${guild}` : ''}`,
          `**[**\`出現\`**] ${bossNameFn(id, 'ja')}**${guild ? `\n${tFn('assignedTo', 'ja')}: ${guild}` : ''}`,
          id, false, ctx
        );
      }
      ctx.notifCache.delete(id);
      ctx.notifCache10.delete(id);
    }
    } catch (e) { console.error(`[NOTIF] loop error for ${id} (${ctx.id}):`, e); }
  }
}

export function startNotifLoop() {
  if (notifInterval) clearInterval(notifInterval);
  if (cleanupInterval) clearInterval(cleanupInterval);
  notifInterval = setInterval(async () => {
    for (const ctx of allTrackerCtxsFn()) {
      try {
        await runNotifCycle(ctx);
      } catch (e) {
        console.error(`[NOTIF] cycle error (${ctx.id}):`, e);
      }
    }
  }, 3000);
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const ctx of allTrackerCtxsFn()) {
      for (const set of [ctx.sentSoon, ctx.sentSoon10, ctx.sentSpawned]) {
        for (const key of set) {
          const ts = parseInt(key.split('_').pop());
          if (ts && ts < now - 300000) set.delete(key);
        }
      }
      for (const [key] of ctx.ttsSpoken) {
        const parts = key.split('_');
        const ts = parseInt(parts[1]);
        if (ts && ts < now - 3600000) ctx.ttsSpoken.delete(key);
      }
    }
  }, 3600000);
}
