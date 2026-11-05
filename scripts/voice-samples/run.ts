import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { voiceBlendFor } from '../../packages/voice/src/cinematic.ts';
import { decodeWav, encodeWav } from '../../packages/voice/src/delivery-shaping.ts';
import { createKokoroJsEngine, KOKORO_MODEL_DIR_ENV } from '../../packages/voice/src/kokoro-js-engine.ts';
import {
  createKokoroProvider,
  KOKORO_CAPABILITIES,
  KOKORO_PROVIDER_ID,
  type KokoroCapabilities,
  type KokoroEngine,
  MLX_KOKORO_CAPABILITIES,
  MLX_KOKORO_PROVIDER_ID,
} from '../../packages/voice/src/kokoro-provider.ts';
import { createMlxAudioEngine, MLX_AUDIO_DIR_ENV } from '../../packages/voice/src/mlx-audio-engine.ts';
import { NARRATOR_SPEAKER } from '../../packages/voice/src/speaker-routing.ts';
import type { SpeechChunk } from '../../packages/voice/src/tts.ts';
import type { CommittedUtterance, Delivery } from '../../packages/voice/src/voice.ts';

export const SAMPLES_DIR_ENV = 'RPG_VOICE_SAMPLES_DIR';

export interface SampleLine {
  readonly language: string;
  readonly name: string;
  readonly speakerId: string;
  readonly voice: string;
  readonly text: string;
  readonly delivery?: Delivery;
}

export interface SampleTarget {
  readonly language: string;
  readonly id: string;
  readonly capabilities: KokoroCapabilities;
  readonly engine: KokoroEngine;
}

export const SAMPLE_LINES: readonly SampleLine[] = Object.freeze([
  {
    language: 'en-US',
    name: 'narration',
    speakerId: NARRATOR_SPEAKER,
    voice: 'af_heart',
    text: 'The rain had not stopped for three days. The caravan reached the gates of Varrow at dusk.\n\n***\n\nTorches hissed under the arches.',
    delivery: { emotion: 'calm' },
  },
  {
    language: 'en-US',
    name: 'npc-warning',
    speakerId: 'npc-guard',
    voice: 'am_adam',
    text: 'Keep your voice down. “The captain hears everything,” he whispered. Move!',
    delivery: { emotion: 'tense' },
  },
  {
    language: 'pt-BR',
    name: 'narration',
    speakerId: NARRATOR_SPEAKER,
    voice: 'pf_dora',
    text: 'A chuva não parava havia três dias. A caravana chegou aos portões de Varrow ao anoitecer.\n\n***\n\nAs tochas chiavam sob os arcos.',
    delivery: { emotion: 'calm' },
  },
  {
    language: 'pt-BR',
    name: 'npc-warning',
    speakerId: 'npc-guard',
    voice: 'pm_alex',
    text: 'Fala baixo. “O capitão escuta tudo”, sussurrou ele. Anda!',
    delivery: { emotion: 'tense' },
  },
]);

const MODES = ['before', 'after'] as const;
const SAMPLE_EXTENSION = '.wav';

const utteranceOf = (line: SampleLine, id: string): CommittedUtterance => ({
  text: line.text,
  speakerId: line.speakerId,
  eventId: `sample-${line.language}-${line.name}`,
  profile: {
    id: line.speakerId,
    language: line.language,
    pace: 1,
    style: 'calm',
    pronunciations: {},
    fallbacks: [{ providerId: id, voiceId: line.voice }],
  },
  ...(line.delivery === undefined ? {} : { delivery: line.delivery }),
});

const joinChunks = (chunks: readonly SpeechChunk[]): Uint8Array => {
  const wavs = chunks.map(({ audio }) => decodeWav(audio));
  const first = wavs[0];
  if (!first || wavs.some((wav) => wav === undefined)) throw new Error('engine returned audio that is not a WAV');
  const samples = new Float32Array(wavs.reduce((total, wav) => total + (wav?.samples.length ?? 0), 0));
  let offset = 0;
  for (const wav of wavs) {
    samples.set(wav?.samples ?? [], offset);
    offset += wav?.samples.length ?? 0;
  }
  return encodeWav({ ...first, samples });
};

const render = async (target: SampleTarget, line: SampleLine, shaped: boolean): Promise<Uint8Array> => {
  const provider = createKokoroProvider({
    engine: target.engine,
    id: target.id,
    capabilities: target.capabilities,
    shaping: shaped,
    ...(shaped && line.speakerId !== NARRATOR_SPEAKER
      ? {
          voiceBlend: (speakerId: string, voiceId: string) =>
            voiceBlendFor(speakerId, voiceId, target.capabilities.voices),
        }
      : {}),
  });
  const chunks: SpeechChunk[] = [];
  try {
    for await (const chunk of provider.synthesize(
      utteranceOf(line, target.id),
      line.voice,
      new AbortController().signal,
    )) {
      chunks.push(chunk);
    }
  } finally {
    await provider.dispose();
  }
  return joinChunks(chunks);
};

export const writeSamples = async (targets: readonly SampleTarget[], dir: string): Promise<string[]> => {
  await mkdir(dir, { recursive: true });
  const files: string[] = [];
  for (const target of targets.filter(({ engine }) => engine.ready())) {
    for (const line of SAMPLE_LINES.filter(({ language }) => language === target.language)) {
      for (const mode of MODES) {
        const file = join(dir, `${line.language}-${line.name}-${mode}${SAMPLE_EXTENSION}`);
        await writeFile(file, await render(target, line, mode === 'after'));
        files.push(file);
      }
    }
  }
  return files;
};

if (import.meta.main) {
  const dir = process.env[SAMPLES_DIR_ENV];
  const kokoroDir = process.env[KOKORO_MODEL_DIR_ENV];
  const mlxDir = process.env[MLX_AUDIO_DIR_ENV];
  if (!dir || (!kokoroDir && !mlxDir)) {
    console.error(`set ${SAMPLES_DIR_ENV} and ${KOKORO_MODEL_DIR_ENV} and/or ${MLX_AUDIO_DIR_ENV}`);
    process.exit(1);
  }
  const targets: SampleTarget[] = [
    ...(kokoroDir
      ? [
          {
            language: 'en-US',
            id: KOKORO_PROVIDER_ID,
            capabilities: KOKORO_CAPABILITIES,
            engine: createKokoroJsEngine(kokoroDir),
          },
        ]
      : []),
    ...(mlxDir
      ? [
          {
            language: 'pt-BR',
            id: MLX_KOKORO_PROVIDER_ID,
            capabilities: MLX_KOKORO_CAPABILITIES,
            engine: createMlxAudioEngine({ dir: mlxDir }),
          },
        ]
      : []),
  ];
  const files = await writeSamples(targets, dir);
  console.log(files.length === 0 ? 'no engine is ready, nothing written' : files.join('\n'));
}
