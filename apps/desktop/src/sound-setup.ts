import type { ModelOffer } from '../../../packages/voice/src/kokoro-model.ts';
import { parseRateLimited, parseUnavailable, retryMinutes } from '../../../packages/voice/src/sound-rate-limit.ts';
import type { SoundBridge } from './sound-player.ts';

export type SoundSetupStep = 'idle' | 'consent' | 'downloading' | 'failed';

export type SoundSetupView = {
  readonly step: SoundSetupStep;
  readonly installed: boolean;
  readonly offer?: ModelOffer;
  readonly retryMinutes?: number;
  readonly unavailable?: boolean;
  readonly progress?: { readonly bytes: number; readonly total: number };
};

export const createSoundSetup = ({
  bridge,
  changed,
  installed,
}: {
  readonly bridge: SoundBridge;
  readonly changed: () => void;
  readonly installed: () => void;
}) => {
  let step: SoundSetupStep = 'idle';
  let present = false;
  let offer: ModelOffer | undefined;
  let progress: SoundSetupView['progress'];
  let retry: number | undefined;
  let unavailable = false;

  const go = (next: SoundSetupStep) => {
    step = next;
    changed();
  };
  const refresh = async () => {
    try {
      const status = await bridge.status();
      present = status.installed;
      offer = status.offer;
    } catch {
      present = false;
    }
    changed();
  };
  bridge.onProgress((bytes) => {
    if (step !== 'downloading' || progress === undefined) return;
    progress = { ...progress, bytes };
    changed();
  });

  return {
    refresh,
    ask: () => {
      if (present || offer === undefined || step === 'downloading') return;
      go('consent');
    },
    decline: () => {
      if (step === 'consent') go('idle');
    },
    accept: async () => {
      if (step !== 'consent' || offer === undefined) return;
      progress = { bytes: 0, total: offer.bytes };
      retry = undefined;
      unavailable = false;
      go('downloading');
      try {
        await bridge.download({ accepted: true, ...offer });
      } catch (error) {
        progress = undefined;
        const message = error instanceof Error ? error.message : '';
        const seconds = parseRateLimited(message);
        unavailable = parseUnavailable(message);
        retry = seconds === undefined ? undefined : retryMinutes(seconds);
        await refresh();
        return go('failed');
      }
      progress = undefined;
      await refresh();
      go('idle');
      if (present) installed();
    },
    view: (): SoundSetupView => ({
      step,
      installed: present,
      ...(offer === undefined ? {} : { offer }),
      ...(retry === undefined ? {} : { retryMinutes: retry }),
      ...(unavailable ? { unavailable } : {}),
      ...(progress === undefined ? {} : { progress }),
    }),
  };
};

export type SoundSetup = ReturnType<typeof createSoundSetup>;
