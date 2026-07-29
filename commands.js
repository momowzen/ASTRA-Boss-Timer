import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, MessageFlags } from 'discord.js';

let config, timers, db, bossNameFn, tFn, formatJSTFn, BOSSES_DATA, TZ_OFFSET, LANG_LIST;
let findBossFn, getNextSpawnFn, formatSpawnTimeFn, formatRemainingFn, visualLen, padL, padC, padR, detectLang, CMD_ALIAS, CMD_MAP;
let sendAllNotifsFn, removeBossReactionsFn, resetBossCycleFn, saveTimersFn, addHistoryFn, speakDefeatedFn;
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
  notifMessageCache = deps.notifMessageCache;
}

export function buildDetailedHelp() {
  return [
    '**🇺🇸 English**',
    '**kill <bossname>** — Mark boss dead. Records current JST time as kill time.',
    '**set <bossname> [MMDD] <HHMM>** — Manual kill time. Date optional. Ex: `set Venatus 0721 1430` or `set Venatus 1430`',
    '**miss <bossname>** — Mark missed. Only works with active timer. Adds 5 min penalty.',
    '**clear <bossname>** — Clear boss timer.',
    '**bl** — Boss list. Shows all bosses with remaining time and spawn date/time.',
    '**ut** — Today & tomorrow bosses sorted by remaining time.',
    '**reset_tracker confirm** — Reset all interval boss timers.',
    '**astra help** — Show this help (or just `astra`).',
    '**/setup** — Configure notification channels.',
    '**/astra** — Show this help (slash version).',
    '**/import** — Import boss timers from paste data.',
    '**/export** — Export all boss timers as text.',
    '',
    '**🇰🇷 한국어**',
    '**처치 <보스명>** — 보스 처치 기록. 현재 JST 시간을 처치 시간으로 저장.',
    '**설정 <보스명> [월일] <시분>** — 수동 처치 시간. 날짜 생략 가능. 예: `설정 베나투스 0721 1430` 또는 `설정 베나투스 1430`',
    '**놓침 <보스명>** — 보스 놓침. 활성 타이머 있을 때만 동작. 5분 패널티.',
    '**초기화 <보스명>** — 보스 타이머 초기화.',
    '**목록** — 전체 보스 목록. 남은 시간과 출현 시간 표시.',
    '**곧** — 오늘과 내일 출현 보스를 남은 시간순으로 표시.',
    '**초기화_전체 확인** — 모든 고정 주기 보스 타이머 초기화.',
    '**도움** or **도움말** — 도움말 표시.',
    '**/설정** — 알림 채널을 설정합니다.',
    '**/도움말** — 모든 명령어 도움말을 표시합니다.',
    '**/가져오기** — 붙여넣기 데이터에서 보스 타이머를 가져옵니다.',
    '**/내보내기** — 모든 보스 타이머를 텍스트로 내보냅니다.',
    '',
    '**🇯🇵 日本語**',
    '**討伐 <ボス名>** — ボス討伐記録。現在のJST時間を討伐時間として保存。',
    '**設定 <ボス名> [月日] <時分>** — 手動討伐時間。日付省略可。例: `設定 ベナトゥス 0721 1430` 又は `設定 ベナトゥス 1430`',
    '**逃し <ボス名>** — 取り逃し記録。アクティブタイマー必須。5分ペナルティ。',
    '**解除 <ボス名>** — ボスタイマーをクリア。',
    '**一覧** — 全ボス一覧。残り時間と出現時間を表示。',
    '**まもなく** — 今日と明日の出現ボスを残り時間順に表示。',
    '**全解除 確認** — 全固定周期ボスタイマーをリセット。',
    '**へるぷ** — ヘルプを表示。',
    '**/せってい** — 通知チャンネルを設定します。',
    '**/へるぷ** — 全コマンドヘルプを表示します。',
    '**/いんぽーと** — 貼り付けデータからボスタイマーをインポートします。',
    '**/エクスポート** — 全ボスタイマーをテキストでエクスポートします。',
  ].join('\n');
}

export async function handleCommand(msg) {
  const content = msg.content.trim();
  const lang = detectLang(content);
  const parts = content.split(/\s+/);
  const resolved = (function resolveCommand(raw) {
    const lower = raw.toLowerCase();
    return CMD_MAP[lower] || null;
  })(parts[0]);
  if (!resolved) return;
  const cmd = resolved.id;
  if (!(resolved.lang === lang || resolved.lang === 'en' || parts[0].toLowerCase() === CMD_ALIAS[cmd]?.en)) return;

  if (cmd === 'kill' && parts.length >= 2) {
    const query = parts.slice(1).join(' ');
    const boss = findBossFn(query, lang);
    if (!boss) return msg.reply(`${tFn('bossNotFound', lang)} ${query}`);
    if (boss.weeklyRespawns) return msg.reply(tFn('scheduleOnly', lang));
    const now = Date.now();
    const endTime = now + boss.respawn * 1000;
    timers[boss.id] = { endTime, startedAt: now };
    resetBossCycleFn(boss.id);
    removeBossReactionsFn(boss.id).catch(() => {});
    await saveTimersFn();
    await addHistoryFn(boss.id, 'killed', now);
    const user = msg.author.toString();
    const nextStrEn = formatJSTFn(endTime, 'en');
    const nextStrKo = formatJSTFn(endTime, 'ko');
    const nextStrJa = formatJSTFn(endTime, 'ja');
    await sendAllNotifsFn(
      `**${bossNameFn(boss.id, 'en')}** ${tFn('defeated', 'en')}\n${tFn('killTime', 'en')}: ${formatJSTFn(now, 'en')}\n${tFn('nextRespawn', 'en')}: ${nextStrEn}\n${tFn('byUser', 'en')} ${user}`,
      `**${bossNameFn(boss.id, 'ko')}** ${tFn('defeated', 'ko')}\n${tFn('killTime', 'ko')}: ${formatJSTFn(now, 'ko')}\n${tFn('nextRespawn', 'ko')}: ${nextStrKo}\n${tFn('byUser', 'ko')} ${user}`,
      `**${bossNameFn(boss.id, 'ja')}** ${tFn('defeated', 'ja')}\n${tFn('killTime', 'ja')}: ${formatJSTFn(now, 'ja')}\n${tFn('nextRespawn', 'ja')}: ${nextStrJa}\n${tFn('byUser', 'ja')} ${user}`,
      boss.id
    );
    speakDefeatedFn(boss.id, endTime);
    return;
  }

  if (cmd === 'set' && parts.length >= 3) {
    const query = parts[1];
    let dateStr, timeStr;
    if (parts.length === 3) { dateStr = null; timeStr = parts[2]; }
    else { dateStr = parts[2]; timeStr = parts[3]; }
    const boss = findBossFn(query, lang);
    if (!boss) return msg.reply(`${tFn('bossNotFound', lang)} ${query}`);
    if (boss.weeklyRespawns) return msg.reply(tFn('scheduleOnly', lang));
    const hour = parseInt(timeStr.slice(0, 2));
    const minute = parseInt(timeStr.slice(2, 4));
    if (isNaN(hour) || isNaN(minute)) return msg.reply(tFn('invalidTime', lang));
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
    if (isNaN(killedAt)) return msg.reply(tFn('invalidDate', lang));
    if (killedAt > Date.now()) return msg.reply(tFn('futureTime', lang));
    const endTime = boss.respawn ? killedAt + boss.respawn * 1000 : killedAt;
    timers[boss.id] = { endTime, startedAt: killedAt };
    resetBossCycleFn(boss.id);
    removeBossReactionsFn(boss.id).catch(() => {});
    await saveTimersFn();
    await addHistoryFn(boss.id, 'killed', killedAt);
    const user = msg.author.toString();
    const nextStrEn = formatJSTFn(endTime, 'en');
    const nextStrKo = formatJSTFn(endTime, 'ko');
    const nextStrJa = formatJSTFn(endTime, 'ja');
    await sendAllNotifsFn(
      `**${bossNameFn(boss.id, 'en')}** ${tFn('manualSet', 'en')}\n${tFn('killTime', 'en')}: ${formatJSTFn(killedAt, 'en')}\n${tFn('nextRespawn', 'en')}: ${nextStrEn}\n${tFn('byUser', 'en')} ${user}`,
      `**${bossNameFn(boss.id, 'ko')}** ${tFn('manualSet', 'ko')}\n${tFn('killTime', 'ko')}: ${formatJSTFn(killedAt, 'ko')}\n${tFn('nextRespawn', 'ko')}: ${nextStrKo}\n${tFn('byUser', 'ko')} ${user}`,
      `**${bossNameFn(boss.id, 'ja')}** ${tFn('manualSet', 'ja')}\n${tFn('killTime', 'ja')}: ${formatJSTFn(killedAt, 'ja')}\n${tFn('nextRespawn', 'ja')}: ${nextStrJa}\n${tFn('byUser', 'ja')} ${user}`,
      boss.id
    );
    speakDefeatedFn(boss.id, endTime);
    return;
  }

  if (cmd === 'miss' && parts.length >= 2) {
    const query = parts.slice(1).join(' ');
    const boss = findBossFn(query, lang);
    if (!boss) return msg.reply(`${tFn('bossNotFound', lang)} ${query}`);
    if (boss.weeklyRespawns) return msg.reply(tFn('scheduleOnly', lang));
    const timer = timers[boss.id];
    if (!timer || !timer.endTime) return msg.reply(`${tFn('noTimer', lang)} ${bossNameFn(boss.id, lang)}`);
    const killedAt = timer.endTime;
    const now = Date.now();
    const endTime = killedAt + 5 * 60 * 1000;
    timers[boss.id] = { endTime, startedAt: killedAt };
    resetBossCycleFn(boss.id);
    removeBossReactionsFn(boss.id).catch(() => {});
    await saveTimersFn();
    await addHistoryFn(boss.id, 'missed', now);
    const user = msg.author.toString();
    const nextStrEn = formatJSTFn(endTime, 'en');
    const nextStrKo = formatJSTFn(endTime, 'ko');
    const nextStrJa = formatJSTFn(endTime, 'ja');
    await sendAllNotifsFn(
      `**${bossNameFn(boss.id, 'en')}** ${tFn('missed', 'en')}\n${tFn('killTime', 'en')}: ${formatJSTFn(killedAt, 'en')}\n${tFn('nextRespawn', 'en')}: ${nextStrEn}\n${tFn('byUser', 'en')} ${user}`,
      `**${bossNameFn(boss.id, 'ko')}** ${tFn('missed', 'ko')}\n${tFn('killTime', 'ko')}: ${formatJSTFn(killedAt, 'ko')}\n${tFn('nextRespawn', 'ko')}: ${nextStrKo}\n${tFn('byUser', 'ko')} ${user}`,
      `**${bossNameFn(boss.id, 'ja')}** ${tFn('missed', 'ja')}\n${tFn('killTime', 'ja')}: ${formatJSTFn(killedAt, 'ja')}\n${tFn('nextRespawn', 'ja')}: ${nextStrJa}\n${tFn('byUser', 'ja')} ${user}`,
      boss.id
    );
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
      `**${bossNameFn(boss.id, 'en')}** ${tFn('cleared', 'en')} ${tFn('byUser', 'en')} ${user}`,
      `**${bossNameFn(boss.id, 'ko')}** ${tFn('cleared', 'ko')} ${tFn('byUser', 'ko')} ${user}`,
      `**${bossNameFn(boss.id, 'ja')}** ${tFn('cleared', 'ja')} ${tFn('byUser', 'ja')} ${user}`
    );
    return;
  }

  if (cmd === 'bl') {
    const schedule = BOSSES_DATA.filter(b => b.weeklyRespawns);
    const interval = BOSSES_DATA.filter(b => b.respawn);

    function buildList(list, title) {
      const G = '   ', S = 12, R = 10, B = 20, total = S + G.length + R + G.length + B;
      const header = padL(tFn('colSpawn', lang), S) + G + padC(tFn('colRemaining', lang), R) + G + padR(tFn('colBoss', lang), B);
      const sep = '-'.repeat(total);
      const lines = ['**' + title + '**', '```', header, sep];
      for (const boss of list) {
        const next = getNextSpawnFn(boss);
        const remaining = next ? formatRemainingFn(next.getTime() - Date.now()) : '---';
        const spawnStr = next ? formatSpawnTimeFn(next.getTime()) : '---';
        lines.push(padL(spawnStr, S) + G + padC(remaining, R) + G + padR(bossNameFn(boss.id, lang), B));
      }
      lines.push('```');
      return lines.join('\n');
    }

    await msg.reply(buildList(schedule, tFn('fixSchedule', lang)));
    return msg.reply(buildList(interval, tFn('fixInterval', lang)));
  }

  if (cmd === 'ut') {
    const now = Date.now();
    const cutoff24h = now + 86400000;
    const bosses = [];
    for (const boss of BOSSES_DATA) {
      const next = getNextSpawnFn(boss);
      if (next) {
        const time = next.getTime();
        if (time >= now && time <= cutoff24h) bosses.push({ boss, time });
      }
    }
    if (bosses.length === 0) return msg.reply(tFn('noActiveBosses', lang));
    bosses.sort((a, b) => a.time - b.time);
    const G = '   ', S = 12, R = 10, B = 20, total = S + G.length + R + G.length + B;
    const header = padL(tFn('colSpawn', lang), S) + G + padC(tFn('colRemaining', lang), R) + G + padR(tFn('colBoss', lang), B);
    const sep = '-'.repeat(total);
    const lines = ['**📅 ' + tFn('upcomingField', lang) + '**', '```', header, sep];
    for (const { boss, time } of bosses) {
      const remaining = formatRemainingFn(time - now);
      lines.push(padL(formatSpawnTimeFn(time), S) + G + padC(remaining, R) + G + padR(bossNameFn(boss.id, lang), B));
    }
    lines.push('```');
    return msg.reply(lines.join('\n'));
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
      `**Tracker Reset** — ${tFn('allReset', 'en')} ${tFn('byUser', 'en')} ${user}`,
      `**트래커 초기화** — ${tFn('allReset', 'ko')} ${tFn('byUser', 'ko')} ${user}`,
      `**トラッカーリセット** — ${tFn('allReset', 'ja')} ${tFn('byUser', 'ja')} ${user}`
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
        if (enCh) config.channels.en = enCh.id;
        if (koCh) config.channels.ko = koCh.id;
        if (jaCh) config.channels.ja = jaCh.id;
        if (voiceCh) { config.voice = voiceCh.id; }
        config.voiceLang = voiceLang;
        await db.collection('config').doc('discordBot').set(config, { merge: false });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        return interaction.editReply({ content: tFn('setupSuccess', voiceLang) });
      }
      if (isHelp) {
        return interaction.reply({ content: buildDetailedHelp().slice(0, 2000), flags: MessageFlags.Ephemeral });
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
    resetBossCycleFn(boss.id);
    await removeBossReactionsFn(boss.id).catch(() => {});
    await saveTimersFn();
    await addHistoryFn(boss.id, 'killed', now);
    const user = interaction.user.toString();
    const nextStrEn = formatJSTFn(endTime, 'en');
    const nextStrKo = formatJSTFn(endTime, 'ko');
    const nextStrJa = formatJSTFn(endTime, 'ja');
    await sendAllNotifsFn(
      `**${bossNameFn(bossId, 'en')}** ${tFn('defeated', 'en')}\n${tFn('killTime', 'en')}: ${formatJSTFn(now, 'en')}\n${tFn('nextRespawn', 'en')}: ${nextStrEn}\n${tFn('byUser', 'en')} ${user}`,
      `**${bossNameFn(bossId, 'ko')}** ${tFn('defeated', 'ko')}\n${tFn('killTime', 'ko')}: ${formatJSTFn(now, 'ko')}\n${tFn('nextRespawn', 'ko')}: ${nextStrKo}\n${tFn('byUser', 'ko')} ${user}`,
      `**${bossNameFn(bossId, 'ja')}** ${tFn('defeated', 'ja')}\n${tFn('killTime', 'ja')}: ${formatJSTFn(now, 'ja')}\n${tFn('nextRespawn', 'ja')}: ${nextStrJa}\n${tFn('byUser', 'ja')} ${user}`,
      bossId
    );
    speakDefeatedFn(bossId, endTime);
    return;
  }

  if (action === 'missed') {
    interaction.deferUpdate().catch(() => {});
    const timer = timers[boss.id];
    const killedAt = timer?.endTime || now;
    const endTime = killedAt + 5 * 60 * 1000;
    timers[boss.id] = { endTime, startedAt: killedAt };
    resetBossCycleFn(boss.id);
    await removeBossReactionsFn(boss.id).catch(() => {});
    await saveTimersFn();
    await addHistoryFn(boss.id, 'missed', now);
    const user = interaction.user.toString();
    const nextStrEn = formatJSTFn(endTime, 'en');
    const nextStrKo = formatJSTFn(endTime, 'ko');
    const nextStrJa = formatJSTFn(endTime, 'ja');
    await sendAllNotifsFn(
      `**${bossNameFn(bossId, 'en')}** ${tFn('missed', 'en')}\n${tFn('killTime', 'en')}: ${formatJSTFn(killedAt, 'en')}\n${tFn('nextRespawn', 'en')}: ${nextStrEn}\n${tFn('byUser', 'en')} ${user}`,
      `**${bossNameFn(bossId, 'ko')}** ${tFn('missed', 'ko')}\n${tFn('killTime', 'ko')}: ${formatJSTFn(killedAt, 'ko')}\n${tFn('nextRespawn', 'ko')}: ${nextStrKo}\n${tFn('byUser', 'ko')} ${user}`,
      `**${bossNameFn(bossId, 'ja')}** ${tFn('missed', 'ja')}\n${tFn('killTime', 'ja')}: ${formatJSTFn(killedAt, 'ja')}\n${tFn('nextRespawn', 'ja')}: ${nextStrJa}\n${tFn('byUser', 'ja')} ${user}`,
      bossId
    );
    return;
  }
}
