import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, MessageFlags } from 'discord.js';

let config, timers, db, bossNameFn, tFn, formatJSTFn, BOSSES_DATA, TZ_OFFSET, LANG_LIST;
let findBossFn, getNextSpawnFn, formatSpawnTimeFn, formatRemainingFn, visualLen, padL, padC, padR, detectLang, CMD_ALIAS, CMD_MAP;
let sendAllNotifsFn, removeBossReactionsFn, resetBossCycleFn, saveTimersFn, addHistoryFn, speakDefeatedFn, speakSetFn, speakMissedFn;
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

const ANSI_RESET = '\u001b[0m';
const ANSI = {
  cyan: (s) => `\u001b[1;36m${s}${ANSI_RESET}`,
  gray: (s) => `\u001b[0;90m${s}${ANSI_RESET}`,
  white: (s) => `\u001b[0;37m${s}${ANSI_RESET}`,
  green: (s) => `\u001b[1;32m${s}${ANSI_RESET}`,
  yellow: (s) => `\u001b[1;33m${s}${ANSI_RESET}`
};

function buildTableBlocks(rows, title, lang) {
  const G = '   ', S = 12, R = 10, B = 20, total = S + G.length + R + G.length + B;
  const header = padL(tFn('colSpawn', lang), S) + G + padC(tFn('colRemaining', lang), R) + G + padR(tFn('colBoss', lang), B);
  const sep = '-'.repeat(total);
  const rowLines = rows.map(row => {
    const spawnStr = row.spawnMs ? formatSpawnTimeFn(row.spawnMs) : '---';
    const remMs = row.spawnMs ? row.spawnMs - Date.now() : null;
    const remStr = remMs !== null ? formatRemainingFn(remMs) : '---';
    return ANSI.white(padL(spawnStr, S)) + G + ANSI.green(padC(remStr, R)) + G + ANSI.yellow(padR(row.name, B));
  });
  const titleLines = [ANSI.cyan(title), ''];
  const headLines = [ANSI.cyan(header), ANSI.gray(sep)];
  const fence = (lines) => ['```ansi', ...lines, '```'].join('\n');
  const single = fence([...titleLines, ...headLines, ...rowLines]);
  if (single.length <= 2000) return [single];
  const blocks = [fence([...titleLines, ...headLines, ...rowLines.slice(0, 12)])];
  for (let i = 12; i < rowLines.length; i += 12) {
    blocks.push(fence([...headLines, ...rowLines.slice(i, i + 12)]));
  }
  return blocks;
}

async function sendDefeatNotification(bossId, killedAt, endTime, statusKey, user) {
  const nameEn = bossNameFn(bossId, 'en');
  const nameKo = bossNameFn(bossId, 'ko');
  const nameJa = bossNameFn(bossId, 'ja');
  const killEn = formatSpawnTimeFn(killedAt);
  const killKo = formatSpawnTimeFn(killedAt);
  const killJa = formatSpawnTimeFn(killedAt);
  const nextEn = formatSpawnTimeFn(endTime);
  const nextKo = formatSpawnTimeFn(endTime);
  const nextJa = formatSpawnTimeFn(endTime);
  removeBossReactionsFn(bossId).catch(() => {});
  await sendAllNotifsFn(
    `**[**\`${TAG[statusKey].en}\`**] ${nameEn}**\n${KILL.en}: ${killEn} | ${NEXT.en}: ${nextEn}\n${BY.en}: ${user}`,
    `**[**\`${TAG[statusKey].ko}\`**] ${nameKo}**\n${KILL.ko}: ${killKo} | ${NEXT.ko}: ${nextKo}\n${BY.ko}: ${user}`,
    `**[**\`${TAG[statusKey].ja}\`**] ${nameJa}**\n${KILL.ja}: ${killJa} | ${NEXT.ja}: ${nextJa}\n${BY.ja}: ${user}`,
    bossId
  );
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
  '**📖 ASTRA Help | 🇺🇸 English**',
  '',
  '**⏱ Boss Timer**',
  '`kill <bossname>` / `<bossname> x` → Record boss kill using current JST.',
  '> Examples: `kill Venatus` \u2022 `Venatus x`',
  '`set <bossname> [MMDD] <HHMM>` → Set kill time manually. Date is optional.',
  '`<bossname> <HHMM>` / `<bossname> <MMDD> <HHMM>` → Shortcut for the `set` command.',
  '> Examples: `set Venatus 1430` \u2022 `set Venatus 0721 1430` \u2022 `Venatus 1430` \u2022 `Venatus 0730 1430`',
  '`miss <bossname>` → Mark boss as missed. Requires an active timer (+5 min).',
  '> Example: `miss Venatus`',
  '`clear <bossname>` → Remove the boss timer.',
  '> Example: `clear Venatus`',
  '',
  '**📋 Lists**',
  '`bl` → Show all boss timers.',
  '`ut` → Show today\'s & tomorrow\'s bosses.',
  '',
  '**⚙️ Management**',
  '`reset_tracker confirm` → Reset all interval boss timers.',
  '',
  '**🛠️ Commands**',
  '`astra help` or `astra` → Show this help.',
  '`/setup` → Configure notification channels.',
  '`/setup ping_here:True` → Enable `@here` spawn notifications.',
  '`/astra` → Show this help.',
  '`/import` → Import boss timers.',
  '`/export` → Export boss timers.',
].join('\n');

const HELP_KO = [
  '**📖 ASTRA 도움말 | 🇰🇷 한국어**',
  '',
  '**⏱ 보스 타이머**',
  '`처치 <보스명>` / `<보스명> x` → 현재 JST 기준으로 보스 처치를 기록합니다.',
  '> 예시: `처치 베나투스` \u2022 `베나투스 x`',
  '`설정 <보스명> [월일] <시분>` → 수동으로 처치 시간을 설정합니다. 날짜는 생략할 수 있습니다.',
  '`<보스명> <시분>` / `<보스명> <월일> <시분>` → `설정` 명령의 단축 입력입니다.',
  '> 예시: `설정 베나투스 1430` \u2022 `설정 베나투스 0721 1430` \u2022 `베나투스 1430` \u2022 `베나투스 0730 1430`',
  '`놓침 <보스명>` → 보스를 놓친 것으로 기록합니다. 활성 타이머가 필요합니다 (+5분).',
  '> 예시: `놓침 베나투스`',
  '`초기화 <보스명>` → 보스 타이머를 삭제합니다.',
  '> 예시: `초기화 베나투스`',
  '',
  '**📋 목록**',
  '`목록` → 모든 보스 타이머를 표시합니다.',
  '`곧` → 오늘과 내일 출현하는 보스를 표시합니다.',
  '',
  '**⚙️ 관리**',
  '`초기화_전체 확인` → 모든 고정 주기 보스 타이머를 초기화합니다.',
  '',
  '**🛠️ 명령어**',
  '`도움` 또는 `도움말` → 도움말을 표시합니다.',
  '`/설정` → 알림 채널을 설정합니다.',
  '`/설정 ping_here:True` → `@here` 출현 알림을 활성화합니다.',
  '`/도움말` → 도움말을 표시합니다.',
  '`/가져오기` → 보스 타이머를 가져옵니다.',
  '`/내보내기` → 보스 타이머를 내보냅니다.',
].join('\n');

const HELP_JA = [
  '**📖 ASTRAヘルプ | 🇯🇵 日本語**',
  '',
  '**⏱ ボスタイマー**',
  '`討伐 <ボス名>` / `<ボス名> x` → 現在のJSTでボス討伐を記録します。',
  '> 例: `討伐 ベナトゥス` \u2022 `ベナトゥス x`',
  '`設定 <ボス名> [月日] <時分>` → 手動で討伐時間を設定します。日付は省略できます。',
  '`<ボス名> <時分>` / `<ボス名> <月日> <時分>` → `設定` コマンドの省略入力です。',
  '> 例: `設定 ベナトゥス 1430` \u2022 `設定 ベナトゥス 0721 1430` \u2022 `ベナトゥス 1430` \u2022 `ベナトゥス 0730 1430`',
  '`逃し <ボス名>` → ボスを取り逃したとして記録します。アクティブなタイマーが必要です（+5分）。',
  '> 例: `逃し ベナトゥス`',
  '`解除 <ボス名>` → ボスタイマーを削除します。',
  '> 例: `解除 ベナトゥス`',
  '',
  '**📋 一覧**',
  '`一覧` → すべてのボスタイマーを表示します。',
  '`まもなく` → 今日と明日出現するボスを表示します。',
  '',
  '**⚙️ 管理**',
  '`全解除 確認` → すべての固定周期ボスタイマーをリセットします。',
  '',
  '**🛠️ コマンド**',
  '`へるぷ` → ヘルプを表示します。',
  '`/せってい` → 通知チャンネルを設定します。',
  '`/せってい ping_here:True` → `@here` 出現通知を有効にします。',
  '`/へるぷ` → ヘルプを表示します。',
  '`/いんぽーと` → ボスタイマーをインポートします。',
  '`/エクスポート` → ボスタイマーをエクスポートします。',
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
    if (boss.weeklyRespawns) return msg.reply(tFn('scheduleOnly', lang));
    const now = Date.now();
    const endTime = now + boss.respawn * 1000;
    timers[boss.id] = { endTime, startedAt: now };
    resetBossCycleFn(boss.id);
    await sendDefeatNotification(boss.id, now, endTime, 'defeated', msg.author.toString());
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
    if (boss.weeklyRespawns) return msg.reply(tFn('scheduleOnly', lang));
    const result = applySet(boss, parsed.date, parsed.time, msg.author, lang);
    if (typeof result === 'string') return msg.reply(result);
    timers[boss.id] = { endTime: result.endTime, startedAt: result.killedAt };
    resetBossCycleFn(boss.id);
    await sendDefeatNotification(boss.id, result.killedAt, result.endTime, 'manualSet', msg.author.toString());
    await saveTimersFn();
    await addHistoryFn(boss.id, 'killed', result.killedAt);
    speakSetFn(boss.id, result.endTime);
    return;
  }

  if (cmd === 'miss' && parts.length >= 2) {
    const query = parts.slice(1).join(' ');
    const boss = findBossFn(query, lang);
    if (!boss) return msg.reply(`${tFn('bossNotFound', lang)} ${query}`);
    if (boss.weeklyRespawns) return msg.reply(tFn('scheduleOnly', lang));
    const timer = timers[boss.id];
    if (!timer || !timer.endTime) return msg.reply(`${tFn('noTimer', lang)} ${bossNameFn(boss.id, lang)}`);
    const now = Date.now();
    const endTime = Math.max(timer.endTime, now) + 5 * 60 * 1000;
    timers[boss.id] = { endTime, startedAt: timer.endTime };
    resetBossCycleFn(boss.id);
    await sendDefeatNotification(boss.id, timer.endTime, endTime, 'missed', msg.author.toString());
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
    const user = msg.author.toString();
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
    const toRow = (boss) => {
      const next = getNextSpawnFn(boss);
      return { spawnMs: next ? next.getTime() : null, name: bossNameFn(boss.id, lang) };
    };
    for (const block of buildTableBlocks(schedule.map(toRow), tFn('fixSchedule', lang).toUpperCase(), lang)) {
      await msg.reply(block);
    }
    for (const block of buildTableBlocks(interval.map(toRow), tFn('fixInterval', lang).toUpperCase(), lang)) {
      await msg.reply(block);
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
    const blocks = buildTableBlocks(bosses.slice(0, 10).map(({ boss, time }) => ({ spawnMs: time, name: bossNameFn(boss.id, lang) })), tFn('upcomingField', lang).toUpperCase(), lang);
    for (const block of blocks) await msg.reply(block);
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
    await saveTimersFn();
    const user = msg.author.toString();
    await sendAllNotifsFn(
      `**[**\`RESET\`**] Boss Tracker**\nAll interval timers reset.\n${BY.en}: ${user}`,
      `**[**\`초기화\`**] 보스 타이머**\n모든 고정 주기 타이머가 초기화되었습니다.\n${BY.ko}: ${user}`,
      `**[**\`リセット\`**] ボスタイマー**\nすべての固定周期タイマーをリセットしました。\n${BY.ja}: ${user}`
    );
    return;
  }

  if (cmd === 'astra' || cmd === 'tracker_commands' || content.toLowerCase() === '/tracker_commands') {
    const help = ['**ASTRA BOSS TIMER Commands**'];
    for (const [id, aliases] of Object.entries(CMD_ALIAS)) {
      const word = aliases[lang] || aliases.en;
      const paramKeys = { kill: 'kill', set: 'set', miss: 'miss', clear: 'clear', ut: 'ut', bl: 'bl', reset_tracker: 'reset_tracker' };
      const paramDescs = { kill: 'killDesc', set: 'setDesc', miss: 'missDesc', clear: 'clearDesc', ut: 'utDesc', bl: 'blDesc', reset_tracker: 'resetDesc' };
      const params = { kill: '<bossname>', set: '<bossname> <MM/DD> <HHMM>', miss: '<bossname>', clear: '<bossname>', ut: '', bl: '', reset_tracker: '' };
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
      if (boss.weeklyRespawns) return msg.reply(tFn('scheduleOnly', lang));
      const result = applySet(boss, parsed.date, parsed.time, msg.author, lang);
      if (typeof result === 'string') return msg.reply(result);
      timers[boss.id] = { endTime: result.endTime, startedAt: result.killedAt };
      resetBossCycleFn(boss.id);
      await sendDefeatNotification(boss.id, result.killedAt, result.endTime, 'manualSet', msg.author.toString());
      await saveTimersFn();
      await addHistoryFn(boss.id, 'killed', result.killedAt);
      speakSetFn(boss.id, result.endTime);
      return;
    }

    const last = parts[parts.length - 1].toLowerCase();
    if (last === 'x') {
      const query = parts.slice(0, -1).join(' ');
      const boss = findBossFn(query, lang);
      if (!boss) return msg.reply(`${tFn('bossNotFound', lang)} ${query}`);
      if (boss.weeklyRespawns) return msg.reply(tFn('scheduleOnly', lang));
      const now = Date.now();
      const endTime = now + boss.respawn * 1000;
      timers[boss.id] = { endTime, startedAt: now };
      resetBossCycleFn(boss.id);
      await sendDefeatNotification(boss.id, now, endTime, 'defeated', msg.author.toString());
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
    timers[boss.id] = { endTime, startedAt: now };
    resetBossCycleFn(boss.id);
    await sendDefeatNotification(bossId, now, endTime, 'defeated', interaction.user.toString());
    await saveTimersFn();
    await addHistoryFn(boss.id, 'killed', now);
    speakDefeatedFn(bossId, endTime);
    return;
  }

  if (action === 'missed') {
    interaction.deferUpdate().catch(() => {});
    const timer = timers[boss.id];
    const killedAt = timer?.endTime || now;
    const endTime = killedAt + 5 * 60 * 1000;
    if (timers[boss.id] && timers[boss.id].endTime && Math.abs(timers[boss.id].endTime - endTime) < 2000) return;
    timers[boss.id] = { endTime, startedAt: killedAt };
    resetBossCycleFn(boss.id);
    await sendDefeatNotification(bossId, killedAt, endTime, 'missed', interaction.user.toString());
    await saveTimersFn();
    await addHistoryFn(boss.id, 'missed', now);
    speakMissedFn(bossId, endTime);
    return;
  }
}
