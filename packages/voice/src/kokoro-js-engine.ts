import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { KOKORO_MODEL_ID, KOKORO_WEIGHTS_PATH, kokoroModelRoot } from './kokoro-model.ts';
import type { KokoroEngine } from './kokoro-provider.ts';

export const KOKORO_MODEL_DIR_ENV = 'RPG_KOKORO_MODEL_DIR';

const KOKORO_MODULE = 'kokoro-js';
const TRANSFORMERS_MODULE = '@huggingface/transformers';
const DTYPE = 'fp32';
const DEVICE = 'cpu';

interface RawAudio {
  toWav(): ArrayBuffer;
}

interface KokoroTts {
  readonly model: { dispose(): Promise<void> };
  generate(text: string, options: { readonly voice: string; readonly speed: number }): Promise<RawAudio>;
}

interface KokoroModule {
  readonly KokoroTTS: {
    from_pretrained(id: string, options: { readonly dtype: string; readonly device: string }): Promise<KokoroTts>;
  };
}

interface TransformersModule {
  readonly env: { localModelPath: string; allowLocalModels: boolean; allowRemoteModels: boolean };
}

export const createKokoroJsEngine = (dir: string): KokoroEngine => {
  let tts: KokoroTts | undefined;
  return {
    ready: () => existsSync(join(kokoroModelRoot(dir), KOKORO_WEIGHTS_PATH)),
    load: async () => {
      const [{ env }, { KokoroTTS }] = (await Promise.all([import(TRANSFORMERS_MODULE), import(KOKORO_MODULE)])) as [
        TransformersModule,
        KokoroModule,
      ];
      env.localModelPath = dir;
      env.allowLocalModels = true;
      env.allowRemoteModels = false;
      tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, { dtype: DTYPE, device: DEVICE });
    },
    synthesize: async (sentence, voiceId, _signal, speed) => {
      if (!tts) throw new Error('kokoro model not loaded');
      return new Uint8Array((await tts.generate(sentence, { voice: voiceId, speed })).toWav());
    },
    unload: async () => {
      const loaded = tts;
      tts = undefined;
      await loaded?.model.dispose();
    },
  };
};
