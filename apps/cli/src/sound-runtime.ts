import { join } from 'node:path';
import {
  type CampaignSnapshot,
  type ClientSession,
  EVENT_COMMITTED,
  PROTOCOL_VERSION,
  type Unsubscribe,
} from '../../../packages/client-protocol/src/protocol.ts';
import type { CampaignId } from '../../../packages/domain/src/campaign.ts';
import type { AmbientSink } from '../../../packages/voice/src/ambience.ts';
import { createLoopSink } from '../../../packages/voice/src/loop-sink.ts';
import {
  createSoundController,
  SCENE_EFFECT,
  type SoundClock,
  type SoundController,
  systemClock,
} from '../../../packages/voice/src/sound-controller.ts';
import { createSoundManager } from '../../../packages/voice/src/sound-downloader.ts';
import { loadBundledManifest, SOUND_KINDS, type SoundKind } from '../../../packages/voice/src/sound-manifest.ts';
import { type SceneSoundInput, sceneSoundOf } from '../../../packages/voice/src/sound-selection.ts';
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

export const followScenes = (
  controller: SoundController,
  session: Pick<ClientSession, 'getSnapshot' | 'subscribeEvents'>,
  campaignId: CampaignId,
  shown: CampaignSnapshot,
): Unsubscribe => {
  let sceneId = shown.currentScene?.id;
  const header = { version: PROTOCOL_VERSION, campaignId } as const;
  return session.subscribeEvents({ ...header, type: 'SubscribeEvents', fromRevision: shown.revision }, (event) => {
    if (event.type !== EVENT_COMMITTED) return;
    const snapshot = session.getSnapshot({ ...header, type: 'GetCampaignSnapshot' });
    const scene = snapshot.ok ? snapshot.value.currentScene : undefined;
    if (scene === undefined || scene.id === sceneId) return;
    sceneId = scene.id;
    controller.setScene(sceneSoundOf(scene.title, scene));
    controller.effect(SCENE_EFFECT);
  });
};
