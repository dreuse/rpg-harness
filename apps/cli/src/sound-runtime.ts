import { join } from 'node:path';
import type { AmbientSink } from '../../../packages/voice/src/ambience.ts';
import { createLoopSink } from '../../../packages/voice/src/loop-sink.ts';
import {
  createSoundController,
  type SoundClock,
  type SoundController,
  systemClock,
} from '../../../packages/voice/src/sound-controller.ts';
import { createSoundManager } from '../../../packages/voice/src/sound-downloader.ts';
import { loadBundledManifest, SOUND_KINDS, type SoundKind } from '../../../packages/voice/src/sound-manifest.ts';
import type { SceneSoundInput } from '../../../packages/voice/src/sound-selection.ts';
import { type SoundSettings, soundEnabled } from '../../../packages/voice/src/sound-settings.ts';
import { readSoundSettings } from './sound-command.ts';
import { SOUNDS_DIR } from './sound-files.ts';

export const DEFAULT_SCENE: SceneSoundInput = { location: '', mood: [] };

export interface SoundRuntime {
  readonly controller: SoundController;
  dispose(): void;
}

export interface SoundRuntimeOptions {
  readonly settings?: SoundSettings;
  readonly sink?: AmbientSink & { dispose(): void };
  readonly clock?: SoundClock;
  readonly installed?: (kind: SoundKind, key: string) => boolean;
  readonly scene?: SceneSoundInput;
}

const LAYER_SEPARATOR = ':';
export const SCENE_EFFECT = 'bell';

export const createSoundRuntime = (
  dataDir: string,
  {
    settings = readSoundSettings(dataDir),
    sink,
    clock = systemClock,
    installed,
    scene = DEFAULT_SCENE,
  }: SoundRuntimeOptions = {},
): SoundRuntime | undefined => {
  if (!soundEnabled(settings)) return undefined;
  const manager = createSoundManager({ dir: join(dataDir, SOUNDS_DIR), sounds: loadBundledManifest() });
  const pathOf = (kind: SoundKind, key: string) => manager.pathOf(kind, key);
  const player =
    sink ??
    createLoopSink({
      resolve: (layerId) => {
        const [kind, key = ''] = layerId.split(LAYER_SEPARATOR);
        const known = SOUND_KINDS.find((candidate) => candidate === kind);
        return known === undefined ? undefined : pathOf(known, key);
      },
    });
  const controller = createSoundController({
    sink: player,
    clock,
    available: installed ?? ((kind, key) => pathOf(kind, key) !== undefined),
  });
  controller.apply(settings);
  controller.setScene(scene);
  controller.effect(SCENE_EFFECT);
  return {
    controller,
    dispose: () => {
      controller.dispose();
      player.dispose();
    },
  };
};
