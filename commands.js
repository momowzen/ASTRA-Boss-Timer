import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, MessageFlags, EmbedBuilder } from 'discord.js';

let config, timers, db, bossNameFn, tFn, formatJSTFn, BOSSES_DATA, TZ_OFFSET, LANG_LIST;
let findBossFn, getNextSpawnFn, formatSpawnTimeFn, formatRemainingFn, visualLen, padL, padC, padR, detectLang, CMD_ALIAS, CMD_MAP;
let sendAllNotifsFn, removeBossReactionsFn, resetBossCycleFn, saveTimersFn, addHistoryFn, saveConfigFn, speakDefeatedFn, speakSetFn, speakMissedFn;
let notifMessageCache;

export function initCommands(deps) {
  config = deps.config;
  timers = deps.timers;
  db = deps.db;
  bossNameFn = deps.bossName;
  tFn = deps.t;
  formatJSTFn = deps.formatJST;
  BOSSES_DATA = deps.BOSSES_DATA;
  TZ_OFFSET = deps.TZ_OFFSET;
  LANG_LIST = deps.LANG_LIST;
  findBossFn = deps.findBoss;
  getNextSpawnFn = deps.getNextSpawn;
  formatSpawnTimeFn = deps.formatSpawnTime;
  formatRemainingFn = deps.formatRemaining;
  visualLen = deps.visualLen;
  padL = deps.padL;
  padC = deps.padC;
  padR = deps.padR;
  detectLang = deps.detectLang;
  CMD_ALIAS = deps.CMD_ALIAS;
  CMD_MAP = deps.CMD_MAP;
  sendAllNotifsFn = deps.sendAllNotifs;
  removeBossReactionsFn = deps.removeBossReactions;
  resetBossCycleFn = deps.resetBossCycle;
  saveTimersFn = deps.saveTimers;
  addHistoryFn = deps.addHistory;
  saveConfigFn = deps.saveConfig;
  speakDefeatedFn = deps.speakDefeated;
  speakSetFn = deps.speakSet;
  speakMissedFn = deps.speakMissed;
  notifMessageCache = deps.notifMessageCache;
}

const TAG = {
  defeated: { en: 'DEFEATED', ko: '처치', ja: '討伐' },
  manualSet: { en: 'SET', ko: '설정', ja: '設定' },
  missed: { en: 'MISSED', ko: '놓침', ja: '取り逃し' }
};
const KILL = { en: 'Kill', ko: '처치', ja: '討伐' };
const NEXT = { en: 'Next', ko: '다음', ja: '次回' };
const BY = { en: 'By', ko: '기록', ja: '記録' };

function buildEmbeds(rows, title, lang, color, guildNames) {
  if (!rows.length) return [];
  const W1 = 12;
  const pad = (s, w) => s + ' '.repeat(Math.max(0, w - visualLen(s)));
  const guildLabels = rows.map(r => r.guild != null ? (guildNames?.[String(r.guild)] || String(r.guild)) : '---');
  const W2 = Math.max(...guildLabels.map(g => visualLen(g)));
  const lines = [];
  for (let i = 0; i < rows.length; i++) {
    const spawnStr = rows[i].spawnMs ? formatSpawnTimeFn(rows[i].spawnMs) : '---';
    lines.push(`${pad(spawnStr, W1)}${pad(guildLabels[i], W2)}  ${rows[i].name}`);
  }
  const description = '```\n' + lines.join('\n') + '\n```';
  return [new EmbedBuilder().setTitle(title).setDescription(description).setColor(color)];
}

function buildGuildEmbeds(rows, title, color) {
  if (!rows.length) return [];
  const W1 = 12;
  const pad = (s, w) => s + ' '.repeat(Math.max(0, w - visualLen(s)));
  const lines = rows.map(r => {
    const spawnStr = r.spawnMs ? formatSpawnTimeFn(r.spawnMs) : '---';
    return `${pad(spawnStr, W1)}${r.name}`;
  });
  const description = '```\n' + lines.join('\n') + '\n```';
  return [new EmbedBuilder().setTitle(title).setDescription(description).setColor(color)];
}

async function sendDefeatNotification(bossId, killedAt, endTime, statusKey, user, timerEntry) {
  const nameEn = bossNameFn(bossId, 'en');
  const nameKo = bossNameFn(bossId, 'ko');
  const nameJa = bossNameFn(bossId, 'ja');
  const killEn = formatSpawnTimeFn(killedAt);
  const killKo = formatSpawnTimeFn(killedAt);
  const killJa = formatSpawnTimeFn(killedAt);
  const nextEn = formatSpawnTimeFn(endTime);
  const nextKo = formatSpawnTimeFn(endTime);
  const nextJa = formatSpawnTimeFn(endTime);
  await sendAllNotifsFn(
    `**[**\`${TAG[statusKey].en}\`**] ${nameEn}**\n${KILL.en}: ${killEn} | ${NEXT.en}: ${nextEn}\n${BY.en}: ${user}`,
    `**[**\`${TAG[statusKey].ko}\`**] ${nameKo}**\n${KILL.ko}: ${killKo} | ${NEXT.ko}: ${nextKo}\n${BY.ko}: ${user}`,
    `**[**\`${TAG[statusKey].ja}\`**] ${nameJa}**\n${KILL.ja}: ${killJa} | ${NEXT.ja}: ${nextJa}\n${BY.ja}: ${user}`,
    bossId
  );
}

function getUserName(author, member) {
  return member?.displayName || author?.displayName || author?.username || 'Unknown';
}

function parseBossTimeArgs(args) {
  if (!args.length) return null;
  const last = args[args.length - 1];
  if (!/^\d{4}$/.test(last)) return null;
  if (args.length >= 2 && /^\d{4}$/.test(args[args.length - 2])) {
    return { name: args.slice(0, args.length - 2).join(' '), date: args[args.length - 2], time: last };
  }
  return { name: args.slice(0, args.length - 1).join(' '), date: null, time: last };
}

function applySet(boss, dateStr, timeStr, user, lang) {
  const hour = parseInt(timeStr.slice(0, 2));
  const minute = parseInt(timeStr.slice(2, 4));
  if (isNaN(hour) || isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return tFn('invalidTime', lang);
  const now = Date.now();
  let killedAt;
  if (dateStr) {
    const month = parseInt(dateStr.slice(0, 2));
    const day = parseInt(dateStr.slice(2, 4));
    if (isNaN(month) || isNaN(day) || month < 1 || month > 12 || day < 1 || day > 31) return tFn('invalidDate', lang);
    const fullYear = new Date(now + TZ_OFFSET).getUTCFullYear();
    const dateProbe = new Date(Date.UTC(fullYear, month - 1, day));
    if (dateProbe.getUTCMonth() !== month - 1 || dateProbe.getUTCDate() !== day) return tFn('invalidDate', lang);
    killedAt = Date.UTC(fullYear, month - 1, day, hour - 9, minute);
  } else {
    const jstNow = new Date(now + TZ_OFFSET);
    killedAt = new Date(Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate(), hour, minute)).getTime() - TZ_OFFSET;
  }
  if (isNaN(killedAt)) return tFn('invalidDate', lang);
  if (killedAt > Date.now()) return tFn('futureTime', lang);
  const endTime = boss.respawn ? killedAt + boss.respawn * 1000 : killedAt;
  timers[boss.id] = { endTime, startedAt: killedAt };
  return { ok: true, killedAt, endTime };
}

const HELP_EN = [
  '**ASTRA Help | English**',
  '',
  '**Boss Kill**',
  '`kill <boss>` / `<boss> cut` → Record a boss kill using the current time.',
  '',
  '> `kill Venatus`',
  '> `Venatus cut`',
  '',
  '**Set Timer**',
  '`set <boss> [MMDD] <HHMM>` → Set a boss kill time manually.',
  '`<boss> <HHMM>` / `<boss> <MMDD> <HHMM>` → Shortcut for `set`.',
  '',
  '> `set Venatus 1430`',
  '> `set Venatus 0721 1430`',
  '> `Venatus 1430`',
  '> `Venatus 0721 1430`',
  '',
  '**Timer Control**',
  '`miss <boss>` → Mark a boss as missed. Kill time = spawn time + 5 min.',
  '`clear <boss>` → Remove the boss timer.',
  '',
  '> `miss Venatus`',
  '> `clear Venatus`',
  '',
  '**Boss Lists**',
  '`bl` → Show all boss timers. Not sorted.',
  '`ut` → Show bosses spawning within the next 24 hours.',
  '`ug` → Show upcoming bosses grouped by guild.',
  '',
  '**Tracker Management**',
  '`reset_tracker confirm` → Reset all interval boss timers.',
  '`/import` → Import boss timers.',
  '`/export` → Export boss timers.',
  '',
  '**Guild Rotation**',
  '`rotation setup guild1=Boss1,Boss2 guild2=Boss3` → Setup guild rotation.',
  '`rotation` → Show current rotation.',
  '`rotation clear` → Clear rotation.',
  '`guildnames 1=Name1 2=Name2` → Set guild display names.',
  '`guildnames` → Show guild names.',
  '`guildnames clear` → Clear guild names.',
  '',
  '**Notifications**',
  '`/setup` → Configure notification channels.',
  '`/setup ping_here:True` → Enable `@here` spawn notifications.',
  '',
  '**Help**',
  '`astra` / `astra help` / `/astra` → Show this help.',
].join('\n');

const HELP_KO = [
  '**ASTRA 도움말 | 한국어**',
  '',
  '**보스 처치**',
  '`처치 <보스명>` / `<보스명> 컷` → 현재 시간으로 보스 처치를 기록합니다.',
  '',
  '> `처치 베나투스`',
  '> `베나투스 컷`',
  '',
  '**타이머 설정**',
  '`설정 <보스명> [월일] <시분>` → 보스 처치 시간을 수동으로 설정합니다.',
  '`<보스명> <시분>` / `<보스명> <월일> <시분>` → `설정`의 단축 입력입니다.',
  '',
  '> `설정 베나투스 1430`',
  '> `설정 베나투스 0721 1430`',
  '> `베나투스 1430`',
  '> `베나투스 0721 1430`',
  '',
  '**타이머 관리**',
  '`놓침 <보스명>` → 보스를 놓친 것으로 기록합니다. 처치 시간 = 출현 시간 + 5분.',
  '`초기화 <보스명>` → 보스 타이머를 삭제합니다.',
  '',
  '> `놓침 베나투스`',
  '> `초기화 베나투스`',
  '',
  '**보스 목록**',
  '`목록` → 모든 보스 타이머를 표시합니다. 정렬되지 않습니다.',
  '`곧` → 앞으로 24시간 이내에 출현하는 보스를 표시합니다.',
  '`길드` → 길드별로 분류하여 출현 예정 보스를 표시합니다.',
  '',
  '**트래커 관리**',
  '`초기화_전체 확인` → 모든 고정 주기 보스 타이머를 초기화합니다.',
  '`/가져오기` → 보스 타이머를 가져옵니다.',
  '`/내보내기` → 보스 타이머를 내보냅니다.',
  '',
  '**길드 로테이션**',
  '`로테이션 setup guild1=보스1,보스2 guild2=보스3` → 길드 로테이션을 설정합니다.',
  '`로테이션` → 현재 로테이션을 표시합니다.',
  '`로테이션 clear` → 로테이션을 초기화합니다.',
  '`길드이름 1=이름1 2=이름2` → 길드 표시 이름을 설정합니다.',
  '`길드이름` → 길드 이름을 표시합니다.',
  '`길드이름 clear` → 길드 이름을 초기화합니다.',
  '',
  '**알림**',
  '`/설정` → 알림 채널을 설정합니다.',
  '`/설정 ping_here:True` → `@here` 출현 알림을 활성화합니다.',
  '',
  '**도움말**',
  '`도움` / `도움말` / `/도움말` → 도움말을 표시합니다.',
].join('\n');

const HELP_JA = [
  '**ASTRAヘルプ | 日本語**',
  '',
  '**ボス討伐**',
  '`討伐 <ボス名>` / `<ボス名> カット` → 現在時刻でボス討伐を記録します。',
  '',
  '> `討伐 ベナトゥス`',
  '> `ベナトゥス カット`',
  '',
  '**タイマー設定**',
  '`設定 <ボス名> [月日] <時分>` → ボス討伐時間を手動で設定します。',
  '`<ボス名> <時分>` / `<ボス名> <月日> <時分>` → `設定` の省略入力です。',
  '',
  '> `設定 ベナトゥス 1430`',
  '> `設定 ベナトゥス 0721 1430`',
  '> `ベナトゥス 1430`',
  '> `ベナトゥス 0721 1430`',
  '',
  '**タイマー管理**',
  '`逃し <ボス名>` → ボスを取り逃したとして記録します。討伐時間 = 出現時間 + 5分。',
  '`解除 <ボス名>` → ボスタイマーを削除します。',
  '',
  '> `逃し ベナトゥス`',
  '> `解除 ベナトゥス`',
  '',
  '**ボス一覧**',
  '`一覧` → すべてのボスタイマーを表示します。並び替えはありません。',
  '`まもなく` → 今後24時間以内に出現するボスを表示します。',
  '`ギルド` → ギルド別に分類した出現予定ボスを表示します。',
  '',
  '**トラッカー管理**',
  '`全解除 確認` → すべての固定周期ボスタイマーをリセットします。',
  '`/いんぽーと` → ボスタイマーをインポートします。',
  '`/エクスポート` → ボスタイマーをエクスポートします。',
  '',
  '**ギルドローテーション**',
  '`ローテーション setup guild1=ボス1,ボス2 guild2=ボス3` → ギルドローテーションを設定します。',
  '`ローテーション` → 現在のローテーションを表示します。',
  '`ローテーション clear` → ローテーションをクリアします。',
  '`ギルド名 1=名前1 2=名前2` → ギルド表示名を設定します。',
  '`ギルド名` → ギルド名を表示します。',
  '`ギルド名 clear` → ギルド名をクリアします。',
  '',
  '**通知**',
  '`/せってい` → 通知チャンネルを設定します。',
  '`/せってい ping_here:True` → `@here` 出現通知を有効にします。',
  '',
  '**ヘルプ**',
  '`へるぷ` / `/へるぷ` → ヘルプを表示します。',
].join('\n');

export function buildDetailedHelp(lang = 'en') {
  if (lang === 'ko') return HELP_KO;
  if (lang === 'ja') return HELP_JA;
  return HELP_EN;
}

export async function handleCommand(msg) {
  const content = msg.content.trim();
  const lang = detectLang(content);
  const parts = content.split(/\s+/);
  const resolved = (function resolveCommand(raw) {
    const lower = raw.toLowerCase();
    return CMD_MAP[lower] || null;
  })(parts[0]);

  if (resolved && (resolved.lang === lang || resolved.lang === 'en' || parts[0].toLowerCase() === CMD_ALIAS[resolved.id]?.en)) {
    const cmd = resolved.id;

  if (cmd === 'kill' && parts.length >= 2) {
    const query = parts.slice(1).join(' ');
    const boss = findBossFn(query, lang);
    if (!boss) return msg.reply(`${tFn('bossNotFound', lang)} ${query}`);
    const now = Date.now();
    const endTime = boss.weeklyRespawns ? getNextSpawnFn(boss)?.getTime() : now + boss.respawn * 1000;
    const alreadyRotated = timers[boss.id]?.rotated === true;
    const timerEntry = { endTime, startedAt: now };
    const rotation = config.rotation || {};
    if (rotation[boss.id] !== undefined && !alreadyRotated && !boss.weeklyRespawns) {
      timerEntry.guild = rotation[boss.id];
      rotation[boss.id] = rotation[boss.id] === 1 ? 2 : 1;
      config.rotation = rotation;
      await saveConfigFn();
    }
    timers[boss.id] = timerEntry;
    await removeBossReactionsFn(boss.id);
    resetBossCycleFn(boss.id);
    await sendDefeatNotification(boss.id, now, endTime, 'defeated', getUserName(msg.author, msg.member), timerEntry);
    await saveTimersFn();
    await addHistoryFn(boss.id, 'killed', now);
    speakDefeatedFn(boss.id, endTime);
    return;
  }

  if (cmd === 'set') {
    const parsed = parseBossTimeArgs(parts.slice(1));
    if (!parsed) return msg.reply(tFn('invalidTime', lang));
    const boss = findBossFn(parsed.name, lang);
    if (!boss) return msg.reply(`${tFn('bossNotFound', lang)} ${parsed.name}`);
    const result = applySet(boss, parsed.date, parsed.time, msg.author, lang);
    if (typeof result === 'string') return msg.reply(result);
    let endTime = result.endTime;
    if (boss.weeklyRespawns) {
      const next = getNextSpawnFn(boss);
      if (next) endTime = next.getTime();
    }
    const alreadyRotated = timers[boss.id]?.rotated === true;
    const timerEntry = { endTime, startedAt: result.killedAt };
    const rotation = config.rotation || {};
    if (rotation[boss.id] !== undefined && !alreadyRotated && !boss.weeklyRespawns) {
      timerEntry.guild = rotation[boss.id];
      rotation[boss.id] = rotation[boss.id] === 1 ? 2 : 1;
      config.rotation = rotation;
      await saveConfigFn();
    }
    timers[boss.id] = timerEntry;
    await removeBossReactionsFn(boss.id);
    resetBossCycleFn(boss.id);
    await sendDefeatNotification(boss.id, result.killedAt, endTime, 'manualSet', getUserName(msg.author, msg.member), timerEntry);
    await saveTimersFn();
    await addHistoryFn(boss.id, 'killed', result.killedAt);
    speakSetFn(boss.id, endTime);
    return;
  }

  if (cmd === 'miss' && parts.length >= 2) {
    const query = parts.slice(1).join(' ');
    const boss = findBossFn(query, lang);
    if (!boss) return msg.reply(`${tFn('bossNotFound', lang)} ${query}`);
    const timer = timers[boss.id];
    if (!timer || !timer.endTime) return msg.reply(`${tFn('noTimer', lang)} ${bossNameFn(boss.id, lang)}`);
    const now = Date.now();
    const killedAt = timer.endTime + 2 * 60 * 1000;
    const endTime = boss.weeklyRespawns ? getNextSpawnFn(boss)?.getTime() : killedAt + boss.respawn * 1000;
    const alreadyRotated = timers[boss.id]?.rotated === true;
    const timerEntry = { endTime, startedAt: killedAt };
    const rotation = config.rotation || {};
    if (rotation[boss.id] !== undefined && !alreadyRotated && !boss.weeklyRespawns) {
      timerEntry.guild = rotation[boss.id];
      rotation[boss.id] = rotation[boss.id] === 1 ? 2 : 1;
      config.rotation = rotation;
      await saveConfigFn();
    }
    timers[boss.id] = timerEntry;
    await removeBossReactionsFn(boss.id);
    resetBossCycleFn(boss.id);
    await sendDefeatNotification(boss.id, killedAt, endTime, 'missed', getUserName(msg.author, msg.member), timerEntry);
    await saveTimersFn();
    await addHistoryFn(boss.id, 'missed', now);
    speakMissedFn(boss.id, endTime);
    return;
  }

  if (cmd === 'clear' && parts.length >= 2) {
    const query = parts.slice(1).join(' ');
    const boss = findBossFn(query, lang);
    if (!boss) return msg.reply(`${tFn('bossNotFound', lang)} ${query}`);
    if (boss.weeklyRespawns) return msg.reply(tFn('scheduleOnly', lang));
    removeBossReactionsFn(boss.id).catch(() => {});
    delete timers[boss.id];
    await saveTimersFn();
    const user = getUserName(msg.author, msg.member);
    await sendAllNotifsFn(
      `**[**\`CLEARED\`**] ${bossNameFn(boss.id, 'en')}**\n${BY.en}: ${user}`,
      `**[**\`삭제\`**] ${bossNameFn(boss.id, 'ko')}**\n${BY.ko}: ${user}`,
      `**[**\`解除\`**] ${bossNameFn(boss.id, 'ja')}**\n${BY.ja}: ${user}`
    );
    return;
  }

  if (cmd === 'bl') {
    const schedule = BOSSES_DATA.filter(b => b.weeklyRespawns && b.id !== 'Test');
    const interval = BOSSES_DATA.filter(b => b.respawn && b.id !== 'Test');
    const gn = config.guildNames || {};
    const rotation = config.rotation || {};
    const toRow = (boss) => {
      const next = getNextSpawnFn(boss);
      const timer = timers[boss.id];
      const guild = rotation[boss.id] ?? timer?.guild ?? null;
      return { spawnMs: next ? next.getTime() : null, name: bossNameFn(boss.id, lang), guild };
    };
    for (const embed of buildEmbeds(schedule.map(toRow), tFn('fixSchedule', lang).toUpperCase(), lang, 0x9B59B6, gn)) {
      await msg.reply({ embeds: [embed] });
    }
    for (const embed of buildEmbeds(interval.map(toRow), tFn('fixInterval', lang).toUpperCase(), lang, 0x3498DB, gn)) {
      await msg.reply({ embeds: [embed] });
    }
    return;
  }

  if (cmd === 'ut') {
    const now = Date.now();
    const cutoff24h = now + 86400000;
    const bosses = [];
    for (const boss of BOSSES_DATA) {
      if (boss.id === 'Test') continue;
      const next = getNextSpawnFn(boss);
      if (next) {
        const time = next.getTime();
        if (time >= now && time <= cutoff24h) bosses.push({ boss, time });
      }
    }
    if (bosses.length === 0) return msg.reply(tFn('noActiveBosses', lang));
    bosses.sort((a, b) => a.time - b.time);
    const gn = config.guildNames || {};
    const rotation = config.rotation || {};
    const embeds = buildEmbeds(bosses.map(({ boss, time }) => ({ spawnMs: time, name: bossNameFn(boss.id, lang), guild: rotation[boss.id] ?? timers[boss.id]?.guild ?? null })), tFn('upcomingField', lang).toUpperCase(), lang, 0x2ECC71, gn);
    for (const embed of embeds) await msg.reply({ embeds: [embed] });
    return;
  }

  if (cmd === 'ug') {
    const now = Date.now();
    const cutoff24h = now + 86400000;
    const bosses = [];
    for (const boss of BOSSES_DATA) {
      if (boss.id === 'Test') continue;
      const next = getNextSpawnFn(boss);
      if (next) {
        const time = next.getTime();
        if (time >= now && time <= cutoff24h) bosses.push({ boss, time });
      }
    }
    if (bosses.length === 0) return msg.reply(tFn('noActiveBosses', lang));
    const gn = config.guildNames || {};
    const rotation = config.rotation || {};
    const groups = { 1: [], 2: [], null: [] };
    for (const { boss, time } of bosses) {
      const guild = rotation[boss.id] ?? timers[boss.id]?.guild ?? null;
      const key = guild === 1 ? 1 : guild === 2 ? 2 : null;
      groups[key].push({ spawnMs: time, name: bossNameFn(boss.id, lang) });
    }
    for (const key of [1, 2, null]) {
      groups[key].sort((a, b) => a.spawnMs - b.spawnMs);
    }
    if (groups[1].length) {
      const gName = gn['1'] || 'Guild 1';
      for (const embed of buildGuildEmbeds(groups[1], gName, 0x2ECC71)) await msg.reply({ embeds: [embed] });
    }
    if (groups[2].length) {
      const gName = gn['2'] || 'Guild 2';
      for (const embed of buildGuildEmbeds(groups[2], gName, 0x2ECC71)) await msg.reply({ embeds: [embed] });
    }
    if (groups[null].length) {
      for (const embed of buildGuildEmbeds(groups[null], tFn('unassigned', lang), 0x2ECC71)) await msg.reply({ embeds: [embed] });
    }
    return;
  }

  if (cmd === 'reset_tracker') {
    const msgContent = parts.slice(1).join(' ').toLowerCase();
    if (!['confirm', '확인', '確認'].includes(msgContent)) {
      return msg.reply(tFn('resetConfirm', lang) || `**WARNING:** This will clear all interval boss timers permanently. Type \`reset_tracker confirm\` to proceed.`);
    }
    for (const boss of BOSSES_DATA) {
      if (boss.respawn) { delete timers[boss.id]; await removeBossReactionsFn(boss.id).catch(() => {}); }
    }
    config.rotation = {};
    config.guildNames = {};
    await saveConfigFn();
    await saveTimersFn();
    const user = getUserName(msg.author, msg.member);
    await sendAllNotifsFn(
      `**[**\`RESET\`**] Boss Tracker**\nAll interval timers reset.\n${BY.en}: ${user}`,
      `**[**\`초기화\`**] 보스 타이머**\n모든 고정 주기 타이머가 초기화되었습니다.\n${BY.ko}: ${user}`,
      `**[**\`リセット\`**] ボスタイマー**\nすべての固定周期タイマーをリセットしました。\n${BY.ja}: ${user}`
    );
    return;
  }

  if (cmd === 'guildnames') {
    const args = parts.slice(1).join(' ');
    if (!args) {
      const gn = config.guildNames || {};
      const lines = [tFn('guildNamesTitle', lang) + ':'];
      for (const [g, name] of Object.entries(gn)) lines.push(`${g} = ${name}`);
      if (lines.length === 1) lines.push(tFn('rotationEmpty', lang));
      return msg.reply(lines.join('\n'));
    }
    if (args.toLowerCase() === 'clear') {
      config.guildNames = {};
      await saveConfigFn();
      return msg.reply(tFn('guildNamesCleared', lang));
    }
    const gn = {};
    const parts2 = args.split(/\s+/);
    for (const part of parts2) {
      const m = part.match(/^(\d+)=(.+)$/);
      if (m) gn[m[1]] = m[2];
    }
    if (Object.keys(gn).length === 0) {
      return msg.reply(`Usage: \`guildnames 1=Name1 2=Name2\``);
    }
    config.guildNames = gn;
    await saveConfigFn();
    return msg.reply(tFn('guildNamesSet', lang));
  }

  if (cmd === 'rotation') {
    const args = parts.slice(1).join(' ');
    const rotation = config.rotation || {};
    if (!args) {
      const lines = [tFn('rotationTitle', lang) + ':'];
      const grouped = {};
      for (const [bossId, guild] of Object.entries(rotation)) {
        if (!grouped[guild]) grouped[guild] = [];
        grouped[guild].push(bossNameFn(bossId, lang));
      }
      const gn = config.guildNames || {};
      for (const [g, bosses] of Object.entries(grouped)) {
        const gName = gn[g] || g;
        lines.push(`\n${gName}: ${bosses.join(', ')}`);
      }
      if (lines.length === 1) lines.push(tFn('rotationEmpty', lang));
      return msg.reply(lines.join('\n'));
    }
    if (args.toLowerCase() === 'clear') {
      config.rotation = {};
      await saveConfigFn();
      return msg.reply(tFn('rotationCleared', lang));
    }
    const setupMatch = args.match(/^setup\s+(.+)$/i);
    if (!setupMatch) {
      return msg.reply(`Usage: \`rotation setup guild1=Boss1,Boss2 guild2=Boss3\``);
    }
    const setupArgs = setupMatch[1];
    const newRotation = {};
    const warnings = [];
    const chunks = setupArgs.split(/\s+/);
    for (const chunk of chunks) {
      const m = chunk.match(/^guild(\d+)=(.+)$/i);
      if (!m) continue;
      const guildNum = parseInt(m[1]);
      const bossNames = m[2].split(',');
      for (const bName of bossNames) {
        const boss = findBossFn(bName.trim(), lang);
        if (!boss) { warnings.push(`Boss not found: ${bName.trim()}`); continue; }
        newRotation[boss.id] = guildNum;
      }
    }
    if (Object.keys(newRotation).length === 0) {
      return msg.reply(`Usage: \`rotation setup guild1=Boss1,Boss2 guild2=Boss3\``);
    }
    config.rotation = newRotation;
    await saveConfigFn();
    const user = getUserName(msg.author, msg.member);
    const reply = [tFn('rotationSetup', lang), `${BY[lang]}: ${user}`];
    if (warnings.length) reply.push(warnings.join('\n'));
    return msg.reply(reply.join('\n'));
  }

  if (cmd === 'astra' || cmd === 'tracker_commands' || content.toLowerCase() === '/tracker_commands') {
    const help = ['**ASTRA BOSS TIMER Commands**'];
    for (const [id, aliases] of Object.entries(CMD_ALIAS)) {
      const word = aliases[lang] || aliases.en;
      const paramKeys = { kill: 'kill', set: 'set', miss: 'miss', clear: 'clear', ut: 'ut', ug: 'ug', bl: 'bl', reset_tracker: 'reset_tracker', rotation: 'rotation', guildnames: 'guildnames' };
      const paramDescs = { kill: 'killDesc', set: 'setDesc', miss: 'missDesc', clear: 'clearDesc', ut: 'utDesc', ug: 'ugDesc', bl: 'blDesc', reset_tracker: 'resetDesc', rotation: 'rotationDesc', guildnames: 'guildnamesDesc' };
      const params = { kill: '<bossname>', set: '<bossname> <MM/DD> <HHMM>', miss: '<bossname>', clear: '<bossname>', ut: '', ug: '', bl: '', reset_tracker: '', rotation: 'setup guild1=Boss1,Boss2 guild2=Boss3', guildnames: '1=Name1 2=Name2' };
      help.push(`\`${word} ${params[id]}\` — ${tFn(paramDescs[id], lang)}`);
    }
    help.push(`\`/setup\` — ${tFn('setupDesc', lang)}`);
    return msg.reply(help.join('\n').slice(0, 1900));
  }
  }

  if (!resolved && parts.length >= 2 && !parts[0].startsWith('/')) {
    const parsed = parseBossTimeArgs(parts);
    if (parsed) {
      const boss = findBossFn(parsed.name, lang);
      if (!boss) return msg.reply(`${tFn('bossNotFound', lang)} ${parsed.name}`);
      const result = applySet(boss, parsed.date, parsed.time, msg.author, lang);
      if (typeof result === 'string') return msg.reply(result);
      let endTime = result.endTime;
      if (boss.weeklyRespawns) {
        const next = getNextSpawnFn(boss);
        if (next) endTime = next.getTime();
      }
      const alreadyRotated = timers[boss.id]?.rotated === true;
      const timerEntry = { endTime, startedAt: result.killedAt };
      const rotation = config.rotation || {};
      if (rotation[boss.id] !== undefined && !alreadyRotated && !boss.weeklyRespawns) {
        timerEntry.guild = rotation[boss.id];
        rotation[boss.id] = rotation[boss.id] === 1 ? 2 : 1;
        config.rotation = rotation;
        await saveConfigFn();
      }
      timers[boss.id] = timerEntry;
      await removeBossReactionsFn(boss.id);
      resetBossCycleFn(boss.id);
      await sendDefeatNotification(boss.id, result.killedAt, endTime, 'manualSet', getUserName(msg.author, msg.member), timerEntry);
      await saveTimersFn();
      await addHistoryFn(boss.id, 'killed', result.killedAt);
      speakSetFn(boss.id, endTime);
      return;
    }

    const last = parts[parts.length - 1].toLowerCase();
    if (last === 'cut' || last === '컷' || last === 'カット') {
      const query = parts.slice(0, -1).join(' ');
      const boss = findBossFn(query, lang);
      if (!boss) return msg.reply(`${tFn('bossNotFound', lang)} ${query}`);
      const now = Date.now();
      const endTime = boss.weeklyRespawns ? getNextSpawnFn(boss)?.getTime() : now + boss.respawn * 1000;
      const alreadyRotated = timers[boss.id]?.rotated === true;
      const timerEntry = { endTime, startedAt: now };
      const rotation = config.rotation || {};
      if (rotation[boss.id] !== undefined && !alreadyRotated && !boss.weeklyRespawns) {
        timerEntry.guild = rotation[boss.id];
        rotation[boss.id] = rotation[boss.id] === 1 ? 2 : 1;
        config.rotation = rotation;
        await saveConfigFn();
      }
      timers[boss.id] = timerEntry;
      await removeBossReactionsFn(boss.id);
      resetBossCycleFn(boss.id);
      await sendDefeatNotification(boss.id, now, endTime, 'defeated', getUserName(msg.author, msg.member), timerEntry);
      await saveTimersFn();
      await addHistoryFn(boss.id, 'killed', now);
      speakDefeatedFn(boss.id, endTime);
      return;
    }
  }
}

export async function handleInteraction(interaction) {
  if (interaction.isModalSubmit() && interaction.customId === 'importModal') {
    const text = interaction.fields.getTextInputValue('importData');
    const lines = text.split('\n');
    const updatedBosses = new Set();
    const jstNow = new Date(Date.now() + TZ_OFFSET);
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const lower = trimmed.toLowerCase();
      if (lower.startsWith('fix schedule') || lower.startsWith('fix interval') || trimmed.includes('스케줄') || trimmed.includes('고정 주기') || trimmed.includes('インターバル') || trimmed.includes('スケジュール')) continue;
      const match = trimmed.match(/^(.+?)\s+-\s+(\d+)h\s+(\d+)m\s+(\d+)\/(\d+),\s+(\d+):(\d+)\s+JST$/);
      if (!match) continue;
      const [, bossNameStr, , , month, day, hour, minute] = match;
      const boss = findBossFn(bossNameStr.trim());
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
    for (const id of updatedBosses) removeBossReactionsFn(id).catch(() => {});
    await saveTimersFn();
    return interaction.reply({ content: tFn('importSuccess', interaction.locale?.startsWith('ko') ? 'ko' : interaction.locale?.startsWith('ja') ? 'ja' : 'en'), flags: MessageFlags.Ephemeral });
  }

  if (interaction.isCommand()) {
    const cmdName = interaction.commandName;
    const isSetup = cmdName === 'setup' || cmdName === '설정' || cmdName === 'せってい';
    const helpLang = interaction.locale?.startsWith('ko') ? 'ko' : interaction.locale?.startsWith('ja') ? 'ja' : 'en';
    const isHelp = cmdName === 'astra' || cmdName === 'tracker_commands' || cmdName === '도움말' || cmdName === 'へるぷ';
    const isImport = cmdName === 'import' || cmdName === '가져오기' || cmdName === 'いんぽーと';
    const isExport = cmdName === 'export' || cmdName === '내보내기' || cmdName === 'エクスポート';

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

    if (isExport) {
      const now = Date.now();
      const lines = [];
      for (const boss of BOSSES_DATA) {
        const info = timers[boss.id];
        let spawnTime = info?.endTime;
        if (!spawnTime && boss.weeklyRespawns) {
          const next = getNextSpawnFn(boss);
          if (next) spawnTime = next.getTime();
        }
        if (!spawnTime) continue;
        const remainingMs = spawnTime - now;
        const s = Math.max(0, Math.floor(remainingMs / 1000));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const d = new Date(spawnTime + TZ_OFFSET);
        const dateStr = `${d.getUTCMonth() + 1}/${d.getUTCDate()}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
        lines.push(`${bossNameFn(boss.id, 'en')} - ${h}h ${m}m ${dateStr} JST`);
      }
      const content = lines.length ? `\`\`\`\n${lines.join('\n')}\n\`\`\`` : tFn('noActiveBosses', 'en');
      return interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }

    if (isSetup) {
        const enCh = interaction.options.getChannel('english_channel');
        const koCh = interaction.options.getChannel('korean_channel');
        const jaCh = interaction.options.getChannel('japanese_channel');
        const voiceCh = interaction.options.getChannel('voice_channel');
        const voiceLang = interaction.options.getString('voice_language') || config.voiceLang || 'en';
        const pingHere = interaction.options.getBoolean('ping_here') ?? config.pingHere;
        if (enCh) config.channels.en = enCh.id;
        if (koCh) config.channels.ko = koCh.id;
        if (jaCh) config.channels.ja = jaCh.id;
        if (voiceCh) { config.voice = voiceCh.id; }
        config.voiceLang = voiceLang;
        config.pingHere = pingHere;
        await db.collection('config').doc('discordBot').set(config, { merge: false });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const pingStatus = pingHere ? ` | @here: ${pingHere}` : '';
        return interaction.editReply({ content: tFn('setupSuccess', voiceLang) + pingStatus });
      }
      if (isHelp) {
        return interaction.reply({ content: buildDetailedHelp(helpLang).slice(0, 2000), flags: MessageFlags.Ephemeral });
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
    if (timers[boss.id] && Math.abs(timers[boss.id].endTime - endTime) < 2000) return;
    const alreadyRotated = timers[boss.id]?.rotated === true;
    const timerEntry = { endTime, startedAt: now };
    const rotation = config.rotation || {};
    if (rotation[boss.id] !== undefined && !alreadyRotated) {
      timerEntry.guild = rotation[boss.id];
      rotation[boss.id] = rotation[boss.id] === 1 ? 2 : 1;
      config.rotation = rotation;
      await saveConfigFn();
    }
    timers[boss.id] = timerEntry;
    await removeBossReactionsFn(boss.id);
    resetBossCycleFn(boss.id);
    await sendDefeatNotification(bossId, now, endTime, 'defeated', getUserName(interaction.user, interaction.member), timerEntry);
    await saveTimersFn();
    await addHistoryFn(boss.id, 'killed', now);
    speakDefeatedFn(bossId, endTime);
    return;
  }

  if (action === 'missed') {
    interaction.deferUpdate().catch(() => {});
    const timer = timers[boss.id];
    const killedAt = timer?.endTime + 2 * 60 * 1000 || now;
    const endTime = killedAt + boss.respawn * 1000;
    if (timers[boss.id] && timers[boss.id].endTime && Math.abs(timers[boss.id].endTime - endTime) < 2000) return;
    const alreadyRotated = timers[boss.id]?.rotated === true;
    const timerEntry = { endTime, startedAt: killedAt };
    const rotation = config.rotation || {};
    if (rotation[boss.id] !== undefined && !alreadyRotated) {
      timerEntry.guild = rotation[boss.id];
      rotation[boss.id] = rotation[boss.id] === 1 ? 2 : 1;
      config.rotation = rotation;
      await saveConfigFn();
    }
    timers[boss.id] = timerEntry;
    await removeBossReactionsFn(boss.id);
    resetBossCycleFn(boss.id);
    await sendDefeatNotification(bossId, killedAt, endTime, 'missed', getUserName(interaction.user, interaction.member), timerEntry);
    await saveTimersFn();
    await addHistoryFn(boss.id, 'missed', now);
    speakMissedFn(bossId, endTime);
    return;
  }
}
