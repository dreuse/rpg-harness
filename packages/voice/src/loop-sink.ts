import { spawn as nodeSpawn } from 'node:child_process';
import type { AmbientSink } from './ambience.ts';
import { PLAYER_COMMANDS, type PlayerProcess, type SpawnPlayer } from './process-sink.ts';

export interface LoopSink extends AmbientSink {
  dispose(): void;
}

export interface LoopSinkOptions {
  readonly resolve: (layerId: string) => string | undefined;
  readonly platform?: NodeJS.Platform;
  readonly spawn?: SpawnPlayer;
}

export const VOLUME_RESTART_STEP = 0.1;
export const NO_PLAYER_MESSAGE_LOOP = 'No audio player is available on this platform.';

const ONE_SHOT_PREFIX = 'effect:';
const PULSE_FULL_VOLUME = 65_536;
const VOLUME_FLAGS: Readonly<Partial<Record<NodeJS.Platform, (volume: number) => readonly string[]>>> = {
  darwin: (volume) => ['-v', String(volume)],
  linux: (volume) => [`--volume=${Math.round(volume * PULSE_FULL_VOLUME)}`],
};

const spawnPlayer: SpawnPlayer = (command, args) => nodeSpawn(command, [...args], { stdio: 'ignore' });

interface Layer {
  volume: number;
  playedVolume: number;
  running: boolean;
  child?: PlayerProcess | undefined;
}

export const createLoopSink = ({
  resolve,
  platform = process.platform,
  spawn = spawnPlayer,
}: LoopSinkOptions): LoopSink => {
  const layers = new Map<string, Layer>();
  const layerFor = (id: string): Layer => {
    const layer = layers.get(id) ?? { volume: 1, playedVolume: 1, running: false };
    layers.set(id, layer);
    return layer;
  };

  const play = (id: string, layer: Layer): void => {
    const player = PLAYER_COMMANDS[platform];
    const volumeFlags = VOLUME_FLAGS[platform];
    const file = resolve(id);
    if (player === undefined || volumeFlags === undefined) throw new Error(NO_PLAYER_MESSAGE_LOOP);
    if (file === undefined) return;
    const [command, ...flags] = player;
    const child = spawn(command, [...flags, ...volumeFlags(layer.volume), file]);
    layer.child = child;
    layer.playedVolume = layer.volume;
    child.on('error', () => undefined);
    child.on('close', () => {
      if (layer.child !== child) return;
      layer.child = undefined;
      if (layer.running && !id.startsWith(ONE_SHOT_PREFIX)) play(id, layer);
    });
  };

  const halt = (layer: Layer): void => {
    const { child } = layer;
    layer.child = undefined;
    child?.kill('SIGKILL');
  };

  return {
    setVolume(id, volume) {
      const layer = layerFor(id);
      layer.volume = volume;
      if (!layer.running || Math.abs(volume - layer.playedVolume) < VOLUME_RESTART_STEP) return;
      halt(layer);
      play(id, layer);
    },
    start(id) {
      const layer = layerFor(id);
      layer.running = true;
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
      for (const layer of layers.values()) {
        layer.running = false;
        halt(layer);
      }
      layers.clear();
    },
  };
};
