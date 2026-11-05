import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KOKORO_PROVIDER_ID } from './kokoro-provider.ts';
import { narratorFallback, noVoiceNotice, voicesFor } from './language-voices.ts';
import { MLX_KOKORO_PROVIDER_ID } from './mlx-audio-engine.ts';
import type { TtsProvider } from './tts.ts';

const provider = (id: string, healthy: boolean): TtsProvider => ({
  id,
  locality: 'local',
  retention: 'none',
  healthy: () => healthy,
  synthesize: async function* () {},
});

test('a Brazilian Portuguese campaign narrates with pf_dora on the mlx-audio provider', () => {
  assert.deepEqual(narratorFallback('pt-BR'), { providerId: MLX_KOKORO_PROVIDER_ID, voiceId: 'pf_dora' });
  assert.deepEqual(narratorFallback('pt'), { providerId: MLX_KOKORO_PROVIDER_ID, voiceId: 'pf_dora' });
  assert.equal(voicesFor('pt-BR')?.providerId, MLX_KOKORO_PROVIDER_ID);
});

test('an English campaign keeps the af_heart narrator on the in-process provider', () => {
  assert.deepEqual(narratorFallback('en-GB'), { providerId: KOKORO_PROVIDER_ID, voiceId: 'af_heart' });
});

test('a language without a Kokoro voice has no narrator voice', () => {
  assert.equal(narratorFallback('pt-PT'), undefined);
  assert.equal(narratorFallback('ja'), undefined);
  assert.equal(voicesFor('not a tag'), undefined);
});

test('tells the player plainly when their language has no voice', () => {
  assert.equal(
    noVoiceNotice('pt-PT', [provider(MLX_KOKORO_PROVIDER_ID, true)]),
    'No spoken voice exists for European Portuguese yet. The story stays in text.',
  );
});

test('tells the player when the voice for their language is not available on this computer', () => {
  const notice = 'Brazilian Portuguese voices are not available on this computer. The story stays in text.';
  assert.equal(noVoiceNotice('pt-BR', []), notice);
  assert.equal(noVoiceNotice('pt-BR', [provider(MLX_KOKORO_PROVIDER_ID, false)]), notice);
});

test('says nothing when a voice for the language is ready', () => {
  assert.equal(noVoiceNotice('pt-BR', [provider(MLX_KOKORO_PROVIDER_ID, true)]), undefined);
  assert.equal(noVoiceNotice('en-US', [provider(KOKORO_PROVIDER_ID, true)]), undefined);
});
