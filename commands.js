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

// ─── Rotation helper functions ──────────────────

function getCurrentGuild(bossId) {
  const rot = config.rotation || {};
  return rot.bossGuild?.[bossId] || null;
}

function getGuildDisplayName(guildName) {
  const gn = config.guildNames || {};
  return gn[guildName] || guildName;
}

function cycleGuild() {
  const rot = config.rotation || {};
  const order = rot.order || [];
  if (order.length < 2) return;
  rot.activeIdx = ((rot.activeIdx || 0) + 1) % order.length;
  const newGuild = order[rot.activeIdx];
  if (rot.bossGuild) {
    for (const bossId of Object.keys(rot.bossGuild)) {
      rot.bossGuild[bossId] = newGuild;
    }
  }
  config.rotation = rot;
}

async function handleRotationOnKill(bossId) {
  const rot = config.rotation || {};
  if (!rot.type || !rot.order || rot.order.length < 2) return;
  if (!rot.bossGuild) rot.bossGuild = {};

  const currentGuild = rot.order[rot.activeIdx || 0];
  rot.bossGuild[bossId] = currentGuild;

  if (rot.type === 'kill') {
    cycleGuild();
  }
  await saveConfigFn();
}

// ─── Existing helpers ───────────────────────────

const TAG = {
  defeated: { en: 'DEFEATED', ko: '처치', ja: '討伐' },
  manualSet: { en: 'SET', ko: '설정', ja: '設定' },
  missed: { en: 'MISSED', ko: '놓침', ja: '取り逃し' }
};
const KILL = { en: 'Kill', ko: '처치', ja: '討伐' };
const NEXT = { en: 'Next', ko: '다음', ja: '次回' };
const BY = { en: 'By', ko: '기록', ja: '記録' };

function buildEmbeds(rows, title, lang, color) {
  if (!rows.length) return [];
  const W1 = 12;
  const pad = (s, w) => s + ' '.repeat(Math.max(0, w - visualLen(s)));
  const guildLabels = rows.map(r => r.guild != null ? r.guild : '---');
  const W2 = Math.max(...guildLabels.map(g => visualLen(g)), 4);
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
  const assignedGuild = timerEntry.guild ? getGuildDisplayName(timerEntry.guild) : null;
  const assignedEn = assignedGuild ? `\n${tFn('assignedTo', 'en')}: ${assignedGuild}` : '';
  const assignedKo = assignedGuild ? `\n${tFn('assignedTo', 'ko')}: ${assignedGuild}` : '';
  const assignedJa = assignedGuild ? `\n${tFn('assignedTo', 'ja')}: ${assignedGuild}` : '';
  await sendAllNotifsFn(
    `**[**\`${TAG[statusKey].en}\`**] ${nameEn}**\n${KILL.en}: ${killEn} | ${NEXT.en}: ${nextEn}${assignedEn}\n${BY.en}: ${user}`,
    `**[**\`${TAG[statusKey].ko}\`**] ${nameKo}**\n${KILL.ko}: ${killKo} | ${NEXT.ko}: ${nextKo}${assignedKo}\n${BY.ko}: ${user}`,
    `**[**\`${TAG[statusKey].ja}\`**] ${nameJa}**\n${KILL.ja}: ${killJa} | ${NEXT.ja}: ${nextJa}${assignedJa}\n${BY.ja}: ${user}`,
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
  '`/rotation kill` → Enable per-kill rotation (flips on each kill/set/miss).',
  '`/rotation weekly` → Enable weekly rotation (flips on schedule).',
  '`/rotation flipday <day> <HH:MM>` → Set weekly flip schedule (UTC).',
  '`/rotation none` → Disable rotation.',
  '`/rotation clear` → Clear all rotation data.',
  '',
  '**Guild Management**',
  '`/addguild <name1> <name2>...` → Register guilds for rotation.',
  '`/addguild remove <name>` → Remove a guild.',
  '`/addguild clear` → Clear all guilds.',
  '`/assignboss <guild>` → Assign bosses to a guild (opens modal).',
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
  '`/로테이션 kill` → 킬별 로테이션 활성화 (처치/설정/놓침 시 전환).',
  '`/로테이션 weekly` → 주간 로테이션 활성화 (스케줄에 따라 전환).',
  '`/로테이션 flipday <요일> <HH:MM>` → 주간 전환 일정 설정 (UTC).',
  '`/로테이션 none` → 로테이션 비활성화.',
  '`/로테이션 clear` → 모든 로테이션 데이터 삭제.',
  '',
  '**길드 관리**',
  '`/길드추가 <이름1> <이름2>...` → 로테이션용 길드 등록.',
  '`/길드추가 remove <이름>` → 길드 제거.',
  '`/길드추가 clear` → 모든 길드 삭제.',
  '`/보스배정 <길드>` → 길드에 보스 배정 (모달 열림).',
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
  '`/ローテーション kill` → キル毎ローテーション有効化（討伐/設定/逃しで切替）。',
  '`/ローテーション weekly` → 週間ローテーション有効化（スケジュールで切替）。',
  '`/ローテーション flipday <曜日> <HH:MM>` → 週間切替スケジュール設定（UTC）。',
  '`/ローテーション none` → ローテーション無効化。',
  '`/ローテーション clear` → ローテーションデータをすべてクリア。',
  '',
  '**ギルド管理**',
  '`/ギルド追加 <名前1> <名前2>...` → ローテーション用ギルド登録。',
  '`/ギルド追加 remove <名前>` → ギルド削除。',
  '`/ギルド追加 clear` → すべてのギルドをクリア。',
  '`/ボス割当 <ギルド>` → ギルドにボスを割り当て（モーダル表示）。',
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
    await handleRotationOnKill(boss.id);
    const timerEntry = { endTime, startedAt: now, guild: getCurrentGuild(boss.id) };
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
    await handleRotationOnKill(boss.id);
    const timerEntry = { endTime, startedAt: result.killedAt, guild: getCurrentGuild(boss.id) };
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
    await handleRotationOnKill(boss.id);
    const timerEntry = { endTime, startedAt: killedAt, guild: getCurrentGuild(boss.id) };
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
    const toRow = (boss) => {
      const next = getNextSpawnFn(boss);
      const guild = getCurrentGuild(boss.id);
      return { spawnMs: next ? next.getTime() : null, name: bossNameFn(boss.id, lang), guild };
    };
    for (const embed of buildEmbeds(schedule.map(toRow), tFn('fixSchedule', lang).toUpperCase(), lang, 0x9B59B6)) {
      await msg.reply({ embeds: [embed] });
    }
    for (const embed of buildEmbeds(interval.map(toRow), tFn('fixInterval', lang).toUpperCase(), lang, 0x3498DB)) {
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
    const embeds = buildEmbeds(bosses.map(({ boss, time }) => ({
      spawnMs: time,
      name: bossNameFn(boss.id, lang),
      guild: getCurrentGuild(boss.id)
    })), tFn('upcomingField', lang).toUpperCase(), lang, 0x2ECC71);
    for (const embed of embeds) await msg.reply({ embeds: [embed] });
    return;
  }

  if (cmd === 'ug') {
    const now = Date.now();
    const bosses = [];
    for (const boss of BOSSES_DATA) {
      if (boss.id === 'Test') continue;
      const next = getNextSpawnFn(boss);
      if (next) {
        const time = next.getTime();
        if (time >= now) bosses.push({ boss, time });
      }
    }
    if (bosses.length === 0) return msg.reply(tFn('noActiveBosses', lang));

    const rot = config.rotation || {};
    const order = rot.order || [];
    const groups = {};
    for (const g of order) groups[g] = [];
    groups[null] = [];

    for (const { boss, time } of bosses) {
      const guild = getCurrentGuild(boss.id);
      const key = guild && groups[guild] ? guild : null;
      groups[key].push({ spawnMs: time, name: bossNameFn(boss.id, lang) });
    }

    for (const [gName, entries] of Object.entries(groups)) {
      entries.sort((a, b) => a.spawnMs - b.spawnMs);
      if (entries.length > 0) {
        const displayName = gName ? getGuildDisplayName(gName) : tFn('unassigned', lang);
        for (const embed of buildGuildEmbeds(entries, displayName, 0x2ECC71)) {
          await msg.reply({ embeds: [embed] });
        }
      }
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
    config.rotation = { type: null, order: [], activeIdx: 0, bossGuild: {}, lastRotatedAt: 0, flipDay: null, flipHour: null, flipMinute: null };
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
      for (const [name, displayName] of Object.entries(gn)) {
        lines.push(`${name} = ${displayName}`);
      }
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
      const m = part.match(/^([^=]+)=(.+)$/);
      if (m) gn[m[1]] = m[2];
    }
    if (Object.keys(gn).length === 0) {
      return msg.reply(`Usage: \`guildnames GuildName=DisplayName ...\``);
    }
    config.guildNames = gn;
    await saveConfigFn();
    return msg.reply(tFn('guildNamesSet', lang));
  }

  if (cmd === 'rotation') {
    const args = parts.slice(1).join(' ');
    const rot = config.rotation || {};

    if (!args) {
      const lines = [tFn('rotationTitle', lang) + ':'];
      lines.push(`${tFn('rotationTypeSet', lang)} ${rot.type ? rot.type.toUpperCase() : tFn('rotationTypeNone', lang)}`);

      if (rot.type && rot.order?.length) {
        const currentGuild = rot.order[rot.activeIdx || 0];
        lines.push(`${tFn('rotationCurrentGuild', lang)} ${getGuildDisplayName(currentGuild)}`);

        if (rot.type === 'weekly' && rot.flipDay != null) {
          const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
          const dayName = days[rot.flipDay] || rot.flipDay;
          const hh = String(rot.flipHour || 0).padStart(2, '0');
          const mm = String(rot.flipMinute || 0).padStart(2, '0');
          lines.push(`${tFn('weeklyFlipSchedule', lang)} ${dayName} ${hh}:${mm} UTC`);
        }

        lines.push(`\n${tFn('guildListTitle', lang)}:`);
        for (let i = 0; i < rot.order.length; i++) {
          const marker = i === (rot.activeIdx || 0) ? ' ← ' + tFn('rotationCurrentGuild', lang) : '';
          lines.push(`${i + 1}. ${getGuildDisplayName(rot.order[i])}${marker}`);
        }
      }

      const bossGuild = rot.bossGuild || {};
      if (Object.keys(bossGuild).length > 0) {
        lines.push(`\n${tFn('bossAssigned', lang)}:`);
        const grouped = {};
        for (const [bossId, guild] of Object.entries(bossGuild)) {
          if (!grouped[guild]) grouped[guild] = [];
          grouped[guild].push(bossNameFn(bossId, lang));
        }
        for (const [guild, bosses] of Object.entries(grouped)) {
          lines.push(`${getGuildDisplayName(guild)}: ${bosses.join(', ')}`);
        }
      }

      if (lines.length === 1) lines.push(tFn('rotationEmpty', lang));
      return msg.reply(lines.join('\n').slice(0, 1900));
    }

    if (args.toLowerCase() === 'clear') {
      config.rotation = { type: null, order: [], activeIdx: 0, bossGuild: {}, lastRotatedAt: 0, flipDay: null, flipHour: null, flipMinute: null };
      await saveConfigFn();
      return msg.reply(tFn('rotationCleared', lang));
    }

    const typeMatch = args.match(/^(kill|weekly|none)$/i);
    if (typeMatch) {
      const newType = typeMatch[1].toLowerCase() === 'none' ? null : typeMatch[1].toLowerCase();
      const rot = config.rotation || {};
      rot.type = newType;

      if (newType === 'weekly' && rot.flipDay == null) {
        rot.flipDay = 0;
        rot.flipHour = 0;
        rot.flipMinute = 0;
      }

      if (newType && (!rot.order || rot.order.length < 2)) {
        return msg.reply(tFn('rotationNeedsGuilds', lang));
      }

      if (newType && rot.order?.length >= 2) {
        const currentGuild = rot.order[rot.activeIdx || 0];
        if (!rot.bossGuild) rot.bossGuild = {};
        for (const boss of BOSSES_DATA) {
          if (boss.id !== 'Test' && !rot.bossGuild[boss.id]) {
            rot.bossGuild[boss.id] = currentGuild;
          }
        }
      }

      config.rotation = rot;
      await saveConfigFn();

      const typeName = newType === 'kill' ? tFn('rotationTypeKill', lang)
        : newType === 'weekly' ? tFn('rotationTypeWeekly', lang)
        : tFn('rotationTypeNone', lang);
      return msg.reply(`${tFn('rotationTypeSet', lang)} ${typeName}`);
    }

    const flipMatch = args.match(/^flipday\s+(\w+)\s+(\d{1,2}):(\d{2})$/i);
    if (flipMatch) {
      const dayMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
      const dayInput = flipMatch[1].toLowerCase();
      const day = dayMap[dayInput];
      if (day === undefined) {
        return msg.reply('Invalid day. Use: sun, mon, tue, wed, thu, fri, sat');
      }
      const hour = parseInt(flipMatch[2]);
      const minute = parseInt(flipMatch[3]);
      if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        return msg.reply('Invalid time. Hour: 0-23, Minute: 0-59');
      }
      const rot = config.rotation || {};
      rot.flipDay = day;
      rot.flipHour = hour;
      rot.flipMinute = minute;
      config.rotation = rot;
      await saveConfigFn();

      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      return msg.reply(`${tFn('rotationFlipSet', lang)} ${days[day]} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} UTC`);
    }

    return msg.reply(`Usage:\n\`rotation kill\` — Per-kill rotation\n\`rotation weekly\` — Weekly rotation\n\`rotation flipday <day> <HH:MM>\` — Set weekly flip schedule\n\`rotation none\` — Disable rotation\n\`rotation clear\` — Clear all rotation data`);
  }

  if (cmd === 'addguild') {
    const args = parts.slice(1).join(' ');
    const rot = config.rotation || {};

    if (!args) {
      const order = rot.order || [];
      if (order.length === 0) return msg.reply(tFn('noGuilds', lang));
      const lines = [`${tFn('guildListTitle', lang)}:`, ''];
      for (let i = 0; i < order.length; i++) {
        const displayName = getGuildDisplayName(order[i]);
        const marker = rot.type && i === (rot.activeIdx || 0) ? ' ← active' : '';
        const bossCount = Object.values(rot.bossGuild || {}).filter(g => g === order[i]).length;
        lines.push(`${i + 1}. ${displayName}${marker} (${bossCount} boss${bossCount !== 1 ? 'es' : ''})`);
      }
      return msg.reply(lines.join('\n'));
    }

    if (args.toLowerCase() === 'clear') {
      config.rotation = { ...rot, order: [], activeIdx: 0, bossGuild: {} };
      config.guildNames = {};
      await saveConfigFn();
      return msg.reply(tFn('guildCleared', lang));
    }

    const removeMatch = args.match(/^remove\s+(.+)$/i);
    if (removeMatch) {
      const name = removeMatch[1].trim();
      const order = rot.order || [];
      const idx = order.indexOf(name);
      if (idx === -1) return msg.reply(`${tFn('guildNotFound', lang)} ${name}`);
      order.splice(idx, 1);
      if (rot.activeIdx >= order.length) rot.activeIdx = 0;
      if (order.length > 0 && rot.bossGuild) {
        const fallback = order[0];
        for (const [bossId, guild] of Object.entries(rot.bossGuild)) {
          if (guild === name) rot.bossGuild[bossId] = fallback;
        }
      }
      if (config.guildNames) delete config.guildNames[name];
      config.rotation = { ...rot, order };
      await saveConfigFn();
      return msg.reply(`${tFn('guildRemoved', lang)} ${name}`);
    }

    const names = parts.slice(1);
    if (names.length === 0) return msg.reply(tFn('noGuilds', lang));

    const order = rot.order || [];
    for (const name of names) {
      if (!order.includes(name)) {
        order.push(name);
      }
    }

    const currentGuild = order[rot.activeIdx || 0];
    if (!rot.bossGuild) rot.bossGuild = {};
    for (const boss of BOSSES_DATA) {
      if (boss.id !== 'Test' && !rot.bossGuild[boss.id]) {
        rot.bossGuild[boss.id] = currentGuild;
      }
    }

    config.rotation = { ...rot, order };
    await saveConfigFn();

    return msg.reply(`${tFn('guildAdded', lang)} ${names.join(', ')}\n${tFn('guildListTitle', lang)}: ${order.map((n, i) => `${i + 1}. ${getGuildDisplayName(n)}`).join(', ')}`);
  }

  if (cmd === 'assignboss') {
    const rot = config.rotation || {};
    const order = rot.order || [];
    if (order.length === 0) {
      return msg.reply(tFn('noGuilds', lang));
    }
    const guildName = parts.slice(1).join(' ');
    if (!guildName) {
      return msg.reply(`${tFn('guildListTitle', lang)}: ${order.join(', ')}\nUsage: \`assignboss <guild name>\``);
    }
    if (!order.includes(guildName)) {
      return msg.reply(`${tFn('guildNotFound', lang)} ${guildName}\n${tFn('guildListTitle', lang)}: ${order.join(', ')}`);
    }
    const bossGuild = rot.bossGuild || {};
    const currentBosses = Object.entries(bossGuild)
      .filter(([_, g]) => g === guildName)
      .map(([id]) => bossNameFn(id, lang));
    const currentStr = currentBosses.length > 0 ? `\n${tFn('bossAssigned', lang)}: ${currentBosses.join(', ')}` : '';
    return msg.reply(`${tFn('bossAssigned', lang)} ${guildName}${currentStr}\nUse \`/assignboss ${guildName}\` slash command to open the assignment modal.`);
  }

  if (cmd === 'astra' || cmd === 'tracker_commands' || content.toLowerCase() === '/tracker_commands') {
    const help = ['**ASTRA BOSS TIMER Commands**'];
    for (const [id, aliases] of Object.entries(CMD_ALIAS)) {
      const word = aliases[lang] || aliases.en;
      const params = { kill: '<bossname>', set: '<bossname> <MM/DD> <HHMM>', miss: '<bossname>', clear: '<bossname>', ut: '', ug: '', bl: '', reset_tracker: '', rotation: '[kill/weekly/none]', guildnames: 'GuildName=DisplayName', addguild: '[name1] [name2]...', assignboss: '<guild name>' };
      const paramDescs = { kill: 'killDesc', set: 'setDesc', miss: 'missDesc', clear: 'clearDesc', ut: 'utDesc', ug: 'ugDesc', bl: 'blDesc', reset_tracker: 'resetDesc', rotation: 'rotationDesc', guildnames: 'guildnamesDesc', addguild: 'addguildDesc', assignboss: 'assignbossDesc' };
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
      await handleRotationOnKill(boss.id);
      const timerEntry = { endTime, startedAt: result.killedAt, guild: getCurrentGuild(boss.id) };
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
      await handleRotationOnKill(boss.id);
      const timerEntry = { endTime, startedAt: now, guild: getCurrentGuild(boss.id) };
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

  if (interaction.isModalSubmit() && interaction.customId.startsWith('assignbossModal_')) {
    const guildName = interaction.customId.replace('assignbossModal_', '');
    const text = interaction.fields.getTextInputValue('bossNames');
    const lang = interaction.locale?.startsWith('ko') ? 'ko' : interaction.locale?.startsWith('ja') ? 'ja' : 'en';

    const rot = config.rotation || {};
    const order = rot.order || [];
    if (!order.includes(guildName)) {
      return interaction.reply({ content: tFn('guildNotFound', lang), flags: MessageFlags.Ephemeral });
    }

    if (!rot.bossGuild) rot.bossGuild = {};

    const names = text.split(',').map(s => s.trim()).filter(Boolean);
    const assigned = [];
    const warnings = [];

    for (const name of names) {
      const boss = findBossFn(name, lang);
      if (!boss) {
        warnings.push(`${tFn('bossNotFound', lang)} ${name}`);
        continue;
      }
      rot.bossGuild[boss.id] = guildName;
      assigned.push(bossNameFn(boss.id, lang));
    }

    config.rotation = rot;
    await saveConfigFn();

    let reply = `${tFn('bossAssigned', lang)} ${getGuildDisplayName(guildName)}: ${assigned.join(', ')}`;
    if (warnings.length) reply += '\n' + warnings.join('\n');
    return interaction.reply({ content: reply, flags: MessageFlags.Ephemeral });
  }

  if (interaction.isCommand()) {
    const cmdName = interaction.commandName;
    const isSetup = cmdName === 'setup' || cmdName === '설정' || cmdName === 'せってい';
    const helpLang = interaction.locale?.startsWith('ko') ? 'ko' : interaction.locale?.startsWith('ja') ? 'ja' : 'en';
    const isHelp = cmdName === 'astra' || cmdName === 'tracker_commands' || cmdName === '도움말' || cmdName === 'へるぷ';
    const isImport = cmdName === 'import' || cmdName === '가져오기' || cmdName === 'いんぽーと';
    const isExport = cmdName === 'export' || cmdName === '내보내기' || cmdName === 'エクスポート';
    const isRotation = cmdName === 'rotation' || cmdName === '로테이션' || cmdName === 'ローテーション';
    const isAddguild = cmdName === 'addguild' || cmdName === '길드추가' || cmdName === 'ギルド追加';
    const isAssignboss = cmdName === 'assignboss' || cmdName === '보스배정' || cmdName === 'ボス割当';

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

    if (isRotation) {
      const rot = config.rotation || {};
      const type = interaction.options.getString('type');

      if (!type) {
        const lines = [tFn('rotationTitle', helpLang) + ':'];
        lines.push(`${tFn('rotationTypeSet', helpLang)} ${rot.type ? rot.type.toUpperCase() : tFn('rotationTypeNone', helpLang)}`);

        if (rot.type && rot.order?.length) {
          const currentGuild = rot.order[rot.activeIdx || 0];
          lines.push(`${tFn('rotationCurrentGuild', helpLang)} ${getGuildDisplayName(currentGuild)}`);

          if (rot.type === 'weekly' && rot.flipDay != null) {
            const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            const dayName = days[rot.flipDay] || rot.flipDay;
            const hh = String(rot.flipHour || 0).padStart(2, '0');
            const mm = String(rot.flipMinute || 0).padStart(2, '0');
            lines.push(`${tFn('weeklyFlipSchedule', helpLang)} ${dayName} ${hh}:${mm} UTC`);
          }

          lines.push(`\n${tFn('guildListTitle', helpLang)}:`);
          for (let i = 0; i < rot.order.length; i++) {
            const marker = i === (rot.activeIdx || 0) ? ' ← ' + tFn('rotationCurrentGuild', helpLang) : '';
            lines.push(`${i + 1}. ${getGuildDisplayName(rot.order[i])}${marker}`);
          }
        }

        const bossGuild = rot.bossGuild || {};
        if (Object.keys(bossGuild).length > 0) {
          lines.push(`\n${tFn('bossAssigned', helpLang)}:`);
          const grouped = {};
          for (const [bossId, guild] of Object.entries(bossGuild)) {
            if (!grouped[guild]) grouped[guild] = [];
            grouped[guild].push(bossNameFn(bossId, helpLang));
          }
          for (const [guild, bosses] of Object.entries(grouped)) {
            lines.push(`${getGuildDisplayName(guild)}: ${bosses.join(', ')}`);
          }
        }

        return interaction.reply({ content: lines.join('\n').slice(0, 2000), flags: MessageFlags.Ephemeral });
      }

      const newType = type === 'none' ? null : type;
      rot.type = newType;

      if (newType === 'weekly' && rot.flipDay == null) {
        rot.flipDay = 0;
        rot.flipHour = 0;
        rot.flipMinute = 0;
      }

      if (newType && (!rot.order || rot.order.length < 2)) {
        return interaction.reply({ content: tFn('rotationNeedsGuilds', helpLang), flags: MessageFlags.Ephemeral });
      }

      if (newType && rot.order?.length >= 2) {
        const currentGuild = rot.order[rot.activeIdx || 0];
        if (!rot.bossGuild) rot.bossGuild = {};
        for (const boss of BOSSES_DATA) {
          if (boss.id !== 'Test' && !rot.bossGuild[boss.id]) {
            rot.bossGuild[boss.id] = currentGuild;
          }
        }
      }

      config.rotation = rot;
      await db.collection('config').doc('discordBot').set(config, { merge: false });

      const typeName = newType === 'kill' ? tFn('rotationTypeKill', helpLang)
        : newType === 'weekly' ? tFn('rotationTypeWeekly', helpLang)
        : tFn('rotationTypeNone', helpLang);
      return interaction.reply({ content: `${tFn('rotationTypeSet', helpLang)} ${typeName}`, flags: MessageFlags.Ephemeral });
    }

    if (isAddguild) {
      const rot = config.rotation || {};
      const guildNames = interaction.options.getString('guild_names');

      if (!guildNames) {
        const order = rot.order || [];
        if (order.length === 0) {
          return interaction.reply({ content: tFn('noGuilds', helpLang), flags: MessageFlags.Ephemeral });
        }
        const lines = [`${tFn('guildListTitle', helpLang)}:`, ''];
        for (let i = 0; i < order.length; i++) {
          const displayName = getGuildDisplayName(order[i]);
          const marker = rot.type && i === (rot.activeIdx || 0) ? ' ← active' : '';
          const bossCount = Object.values(rot.bossGuild || {}).filter(g => g === order[i]).length;
          lines.push(`${i + 1}. ${displayName}${marker} (${bossCount} boss${bossCount !== 1 ? 'es' : ''})`);
        }
        return interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
      }

      const names = guildNames.split(/\s+/).filter(Boolean);
      const order = rot.order || [];
      for (const name of names) {
        if (!order.includes(name)) {
          order.push(name);
        }
      }

      const currentGuild = order[rot.activeIdx || 0];
      if (!rot.bossGuild) rot.bossGuild = {};
      for (const boss of BOSSES_DATA) {
        if (boss.id !== 'Test' && !rot.bossGuild[boss.id]) {
          rot.bossGuild[boss.id] = currentGuild;
        }
      }

      config.rotation = { ...rot, order };
      await db.collection('config').doc('discordBot').set(config, { merge: false });

      return interaction.reply({
        content: `${tFn('guildAdded', helpLang)} ${names.join(', ')}\n${tFn('guildListTitle', helpLang)}: ${order.map((n, i) => `${i + 1}. ${getGuildDisplayName(n)}`).join(', ')}`,
        flags: MessageFlags.Ephemeral
      });
    }

    if (isAssignboss) {
      const rot = config.rotation || {};
      const order = rot.order || [];
      if (order.length === 0) {
        return interaction.reply({ content: tFn('noGuilds', helpLang), flags: MessageFlags.Ephemeral });
      }

      const guildName = interaction.options.getString('guild');
      if (!order.includes(guildName)) {
        return interaction.reply({
          content: `${tFn('guildNotFound', helpLang)} ${guildName}\n${tFn('guildListTitle', helpLang)}: ${order.join(', ')}`,
          flags: MessageFlags.Ephemeral
        });
      }

      const modal = new ModalBuilder()
        .setCustomId(`assignbossModal_${guildName}`)
        .setTitle(`Assign Bosses to ${guildName}`);

      const input = new TextInputBuilder()
        .setCustomId('bossNames')
        .setLabel('Boss names (comma-separated)')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Venatus, Viorent, Ego')
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
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
    await handleRotationOnKill(boss.id);
    const timerEntry = { endTime, startedAt: now, guild: getCurrentGuild(boss.id) };
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
    await handleRotationOnKill(boss.id);
    const timerEntry = { endTime, startedAt: killedAt, guild: getCurrentGuild(boss.id) };
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
