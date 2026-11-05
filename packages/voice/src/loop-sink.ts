import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, extname, join } from 'node:path';
import type { AmbientSink } from './ambience.ts';
import { PLAYER_COMMANDS, type PlayerProcess, type SpawnPlayer } from './process-sink.ts';

export interface LoopSink extends AmbientSink {
  dispose(): void;
}

export interface LoopSinkOptions {
  readonly resolve: (layerId: string) => string | undefined;
  readonly platform?: NodeJS.Platform;
  readonly spawn?: SpawnPlayer;
  readonly findFfplay?: () => string | undefined;
  readonly durationOf?: (ffplay: string, file: string) => number | undefined;
  readonly now?: () => number;
}

export const VOLUME_RESTART_STEP = 0.1;
export const NO_PLAYER_MESSAGE_LOOP = 'No audio player is available on this platform.';

const ONE_SHOT_PREFIX = 'effect:';
const PULSE_FULL_VOLUME = 65_536;
const VOLUME_FLAGS: Readonly<Partial<Record<NodeJS.Platform, (volume: number) => readonly string[]>>> = {
  darwin: (volume) => ['-v', String(volume)],
  linux: (volume) => [`--volume=${Math.round(volume * PULSE_FULL_VOLUME)}`],
};

const FFPLAY = 'ffplay';
const FFPROBE = 'ffprobe';
const WINDOWS_PLATFORM = 'win32';
const WINDOWS_EXTENSION = '.exe';
const SEEK_DECIMALS = 3;
const KNOWN_FFPLAY_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'] as const;
const FFPLAY_BASE_FLAGS = ['-nodisp', '-autoexit', '-loglevel', 'quiet'] as const;
const FFPLAY_FULL_VOLUME = 100;
const FFPROBE_DURATION_FLAGS = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1'] as const;
const FFPROBE_TIMEOUT_MS = 5000;
const MS_PER_SECOND = 1000;

export const findFfplayOnSystem = (platform: NodeJS.Platform = process.platform): string | undefined => {
  const dirs = [...KNOWN_FFPLAY_DIRS, ...(process.env['PATH'] ?? '').split(delimiter)];
  const name = platform === WINDOWS_PLATFORM ? FFPLAY + WINDOWS_EXTENSION : FFPLAY;
  return dirs.map((dir) => join(dir, name)).find((candidate) => existsSync(candidate));
};

export const ffprobePathFor = (ffplay: string): string => join(dirname(ffplay), FFPROBE + extname(ffplay));

export const probeDuration = (ffplay: string, file: string): number | undefined => {
  try {
    const out = execFileSync(ffprobePathFor(ffplay), [...FFPROBE_DURATION_FLAGS, file], {
      encoding: 'utf8',
      timeout: FFPROBE_TIMEOUT_MS,
    });
    const seconds = Number.parseFloat(out);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  } catch {
    return undefined;
  }
};

const spawnPlayer: SpawnPlayer = (command, args) => nodeSpawn(command, [...args], { stdio: 'ignore' });

interface Layer {
  volume: number;
  playedVolume: number;
  running: boolean;
  startedAt: number;
  offset: number;
  child?: PlayerProcess | undefined;
}

export const createLoopSink = ({
  resolve,
  platform = process.platform,
  spawn = spawnPlayer,
  findFfplay = () => findFfplayOnSystem(platform),
  durationOf = probeDuration,
  now = Date.now,
}: LoopSinkOptions): LoopSink => {
  let ffplay: string | undefined | null = null;
  const ffplayPath = (): string | undefined => {
    if (ffplay === null) ffplay = findFfplay();
    return ffplay;
  };
  const durations = new Map<string, number | undefined>();
  const probe = (binary: string, file: string): void => {
    if (!durations.has(file)) durations.set(file, durationOf(binary, file));
  };
  const resumeOffset = (file: string, layer: Layer): number => {
    const elapsed = layer.offset + (now() - layer.startedAt) / MS_PER_SECOND;
    const duration = durations.get(file);
    return duration === undefined ? elapsed : elapsed % duration;
  };
  const layers = new Map<string, Layer>();
  const layerFor = (id: string): Layer => {
    const layer = layers.get(id) ?? { volume: 1, playedVolume: 1, running: false, startedAt: 0, offset: 0 };
    layers.set(id, layer);
    return layer;
  };

  const invocation = (
    id: string,
    layer: Layer,
    file: string,
    offset: number,
  ): readonly [string, ...string[]] | undefined => {
    const binary = ffplayPath();
    if (binary !== undefined) {
      const loop = offset === 0 && !id.startsWith(ONE_SHOT_PREFIX) ? ['-loop', '0'] : [];
      const seek = offset > 0 ? ['-ss', offset.toFixed(SEEK_DECIMALS)] : [];
      const volume = String(Math.round(layer.volume * FFPLAY_FULL_VOLUME));
      return [binary, ...FFPLAY_BASE_FLAGS, '-volume', volume, ...loop, ...seek, file];
    }
    const player = PLAYER_COMMANDS[platform];
    const volumeFlags = VOLUME_FLAGS[platform];
    if (player === undefined || volumeFlags === undefined) return undefined;
    return [...player, ...volumeFlags(layer.volume), file];
  };

  const play = (id: string, layer: Layer, resume = false): void => {
    const file = resolve(id);
    const offset = resume && file !== undefined && ffplayPath() !== undefined ? resumeOffset(file, layer) : 0;
    const command = file === undefined ? undefined : invocation(id, layer, file, offset);
    if (file !== undefined && command === undefined) throw new Error(NO_PLAYER_MESSAGE_LOOP);
    if (file === undefined || command === undefined) return;
    const [executable, ...args] = command;
    const child = spawn(executable, args);
    layer.child = child;
    layer.playedVolume = layer.volume;
    layer.startedAt = now();
    layer.offset = offset;
    child.on('error', () => undefined);
    child.on('close', () => {
      if (layer.child !== child) return;
      layer.child = undefined;
      if (id.startsWith(ONE_SHOT_PREFIX)) layer.running = false;
      else if (layer.running) play(id, layer);
    });
  };

  const halt = (layer: Layer): void => {
    const { child } = layer;
    layer.child = undefined;
    child?.kill('SIGKILL');
  };

  const sink: LoopSink = {
    setVolume(id, volume) {
      const layer = layerFor(id);
      layer.volume = volume;
      if (!layer.running || Math.abs(volume - layer.playedVolume) < VOLUME_RESTART_STEP) return;
      halt(layer);
      play(id, layer, true);
    },
    start(id) {
      const layer = layerFor(id);
      layer.running = true;
      halt(layer);
      const file = resolve(id);
      const binary = ffplayPath();
      if (file !== undefined && binary !== undefined) probe(binary, file);
      play(id, layer);
    },
    stop(id) {
      const layer = layers.get(id);
      if (layer === undefined) return;
      layer.running = false;
      halt(layer);
      layers.delete(id);
    },
    dispose() {
      process.removeListener('exit', sink.dispose);
      for (const layer of layers.values()) {
        layer.running = false;
        halt(layer);
      }
      layers.clear();
    },
  };
  process.once('exit', sink.dispose);
  return sink;
};
