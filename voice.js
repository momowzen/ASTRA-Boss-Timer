import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState } from '@discordjs/voice';
import { Readable } from 'stream';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFile, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';

const execFileAsync = promisify(execFile);

let client, config, bossNameFn, TZ, TZ_OFFSET;
let TTS_SPAWN_IN, TTS_SPAWNED, TTS_DEFEATED, TTS_SET, TTS_MISSED;
let WORLD_BOSS_TIMES, TTS_WORLD_BOSS_IN, TTS_WORLD_BOSS_SPAWNED;

const EDGE_VOICES = {
  en: 'en-US-AriaNeural',
  ko: 'ko-KR-SunHiNeural',
  ja: 'ja-JP-NanamiNeural',
};

let audioPlayer = null;
let voiceConnection = null;
let speakQueue = [];
let isSpeaking = false;
let idleTimer = null;
let sentWorldBossSpawned = new Set();
let ttsWorldBossMinutes = new Map();

export function initVoice(deps) {
  client = deps.client;
  config = deps.config;
  bossNameFn = deps.bossName;
  TZ = deps.TZ;
  TZ_OFFSET = deps.TZ_OFFSET;
  TTS_SPAWN_IN = deps.TTS_SPAWN_IN;
  TTS_SPAWNED = deps.TTS_SPAWNED;
  TTS_DEFEATED = deps.TTS_DEFEATED;
  TTS_SET = deps.TTS_SET;
  TTS_MISSED = deps.TTS_MISSED;
  WORLD_BOSS_TIMES = deps.WORLD_BOSS_TIMES;
  TTS_WORLD_BOSS_IN = deps.TTS_WORLD_BOSS_IN;
  TTS_WORLD_BOSS_SPAWNED = deps.TTS_WORLD_BOSS_SPAWNED;
}

export function getVoiceConnection() { return voiceConnection; }

export function disconnectVoice() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (voiceConnection) { voiceConnection.destroy(); voiceConnection = null; }
  audioPlayer = null; isSpeaking = false; speakQueue = [];
}

export async function connectVoice() {
  const voiceId = config.voice;
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
        speak(speakQueue.shift());
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

export async function speak(text) {
  if (!config.voice) return;
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
    const voice = EDGE_VOICES[lang] || EDGE_VOICES.en;
    const tmpFile = join(tmpdir(), `tts-${randomUUID()}.mp3`);
    try {
      await execFileAsync('edge-tts', [
        '--text', text,
        '--voice', voice,
        '--write-media', tmpFile,
      ], { timeout: 20000 });
      const data = await readFile(tmpFile);
      audioPlayer.play(createAudioResource(Readable.from(data)));
    } finally {
      await unlink(tmpFile).catch(() => {});
    }
  } catch (e) { console.error('[TTS] error:', e.message); isSpeaking = false; }
}

function buildSpawnStrings(nextRespawnTime) {
  const locale = { en: 'en-US', ko: 'ko-KR', ja: 'ja-JP' }[config.voiceLang] || 'en-US';
  const dateStr = new Date(nextRespawnTime).toLocaleString(locale, { month: 'short', day: 'numeric', timeZone: TZ });
  const timeStr = new Date(nextRespawnTime).toLocaleString(locale, { hour: '2-digit', minute: '2-digit', hour12: config.voiceLang !== 'ja', timeZone: TZ });
  return [dateStr, timeStr];
}

export function speakDefeated(bossId, nextRespawnTime, BOSSES_DATA) {
  const boss = BOSSES_DATA.find(b => b.id === bossId);
  if (!boss) return;
  const [dateStr, timeStr] = buildSpawnStrings(nextRespawnTime);
  const fn = TTS_DEFEATED[config.voiceLang] || TTS_DEFEATED.en;
  speak(fn(bossNameFn(bossId, config.voiceLang), dateStr, timeStr));
}

export function speakSet(bossId, nextRespawnTime, BOSSES_DATA) {
  const boss = BOSSES_DATA.find(b => b.id === bossId);
  if (!boss) return;
  const [dateStr, timeStr] = buildSpawnStrings(nextRespawnTime);
  const fn = TTS_SET[config.voiceLang] || TTS_SET.en;
  speak(fn(bossNameFn(bossId, config.voiceLang), dateStr, timeStr));
}

export function speakMissed(bossId, nextRespawnTime, BOSSES_DATA) {
  const boss = BOSSES_DATA.find(b => b.id === bossId);
  if (!boss) return;
  const [dateStr, timeStr] = buildSpawnStrings(nextRespawnTime);
  const fn = TTS_MISSED[config.voiceLang] || TTS_MISSED.en;
  speak(fn(bossNameFn(bossId, config.voiceLang), dateStr, timeStr));
}

export function speakFromNotifLoop(bossName, minutesLeft) {
  const ttsFn = TTS_SPAWN_IN[config.voiceLang] || TTS_SPAWN_IN.en;
  speak(ttsFn(bossName, minutesLeft));
}

export function speakSpawned(bossName) {
  const spawnFn = TTS_SPAWNED[config.voiceLang] || TTS_SPAWNED.en;
  speak(spawnFn(bossName));
}

export function checkWorldBossTts(now) {
  try {
    const jstNow = new Date(now + TZ_OFFSET);
    let nextSpawn = null;
    for (const { hour, minute } of WORLD_BOSS_TIMES) {
      const s = Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate(), hour - 9, minute);
      let ts = s;
      if (ts < now - 300000) ts += 86400000;
      if (!nextSpawn || ts < nextSpawn) nextSpawn = ts;
    }
    if (nextSpawn) {
      const remainingMs = nextSpawn - now;
      const d = new Date(nextSpawn + TZ_OFFSET);
      const spawnKey = `${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}_${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}`;
      if (remainingMs > 0 && remainingMs <= 5 * 60 * 1000) {
        const minutesLeft = Math.ceil(remainingMs / 60000);
        const spokeKey = `${spawnKey}_${minutesLeft}`;
        if (!ttsWorldBossMinutes.has(spokeKey)) {
          ttsWorldBossMinutes.set(spokeKey, true);
          const fn = TTS_WORLD_BOSS_IN[config.voiceLang] || TTS_WORLD_BOSS_IN.en;
          speak(fn(minutesLeft));
        }
      }
      if (remainingMs <= 0 && remainingMs > -300000 && !sentWorldBossSpawned.has(spawnKey)) {
        sentWorldBossSpawned.add(spawnKey);
        speak(TTS_WORLD_BOSS_SPAWNED[config.voiceLang] || TTS_WORLD_BOSS_SPAWNED.en);
      }
    }
  } catch (e) {}
}

export function cleanupWorldBoss() {
  const jstNow = new Date(Date.now() + TZ_OFFSET);
  const todayStr = `${String(jstNow.getUTCMonth() + 1).padStart(2, '0')}${String(jstNow.getUTCDate()).padStart(2, '0')}`;
  for (const key of sentWorldBossSpawned) {
    if (!key.startsWith(todayStr)) sentWorldBossSpawned.delete(key);
  }
  ttsWorldBossMinutes.clear();
}
