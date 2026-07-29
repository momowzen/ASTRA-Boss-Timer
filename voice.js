import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState } from '@discordjs/voice';
import { getAudioBase64 } from 'google-tts-api';
import { Readable } from 'stream';

let client, config, bossNameFn, TZ, TZ_OFFSET;
let TTS_SPAWN_IN, TTS_SPAWNED, TTS_DEFEATED;
let WORLD_BOSS_TIMES, TTS_WORLD_BOSS_IN, TTS_WORLD_BOSS_SPAWNED;

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
    const base64 = await getAudioBase64(text, { lang, slow: false });
    const stream = Readable.from(Buffer.from(base64, 'base64'));
    audioPlayer.play(createAudioResource(stream));
  } catch (e) { console.error('[TTS] error:', e.message); isSpeaking = false; }
}

export function speakDefeated(bossId, nextRespawnTime, BOSSES_DATA) {
  const boss = BOSSES_DATA.find(b => b.id === bossId);
  if (!boss) return;
  const fn = TTS_DEFEATED[config.voiceLang] || TTS_DEFEATED.en;
  const locales = { en: 'en-US', ko: 'ko-KR', ja: 'ja-JP' };
  const timeStr = new Date(nextRespawnTime).toLocaleString(locales[config.voiceLang] || 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: config.voiceLang !== 'ja', timeZone: TZ });
  speak(fn(bossNameFn(bossId, config.voiceLang), timeStr));
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
