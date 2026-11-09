import assert from 'node:assert/strict';
import { test } from 'node:test';
import { missingKeys } from '../../client-protocol/src/locale.ts';
import { CHATTERBOX_CAPABILITIES, CHATTERBOX_PROVIDER_ID } from './chatterbox-engine.ts';
import { KOKORO_ONNX_PROVIDER_ID } from './kokoro-onnx-engine.ts';
import {
  KOKORO_CAPABILITIES,
  KOKORO_PROVIDER_ID,
  type KokoroCapabilities,
  MLX_KOKORO_CAPABILITIES,
} from './kokoro-provider.ts';
import {
  languageVoicesFor,
  narratorFallback,
  narratorFallbacks,
  noVoiceNotice,
  synthesisFailureNotice,
  VOICE_NOTICE_CATALOG,
  voiceLocaleFor,
  voicesFor,
} from './language-voices.ts';
import { MLX_KOKORO_PROVIDER_ID } from './mlx-audio-engine.ts';
import type { TtsProvider } from './tts.ts';

const ROUTE = 'mlx';
const PT_BR_PROVIDER_ID = MLX_KOKORO_PROVIDER_ID;

const provider = (id: string, healthy: boolean): TtsProvider => ({
  id,
  locality: 'local',
  retention: 'none',
  healthy: () => healthy,
  synthesize: async function* () {},
});

test('a Brazilian Portuguese campaign narrates with pf_dora on the pt-BR provider of the platform', () => {
  assert.deepEqual(narratorFallback('pt-BR', ROUTE), { providerId: PT_BR_PROVIDER_ID, voiceId: 'pf_dora' });
  assert.deepEqual(narratorFallback('pt', ROUTE), { providerId: PT_BR_PROVIDER_ID, voiceId: 'pf_dora' });
  assert.equal(voicesFor('pt-BR', ROUTE)?.providerId, PT_BR_PROVIDER_ID);
});

test('an English campaign keeps the af_heart narrator on the in-process provider', () => {
  assert.deepEqual(narratorFallback('en-GB', ROUTE), { providerId: KOKORO_PROVIDER_ID, voiceId: 'af_heart' });
});

test('a language without a Kokoro voice has no narrator voice', () => {
  assert.equal(narratorFallback('pt-PT', ROUTE), undefined);
  assert.equal(narratorFallback('ja', ROUTE), undefined);
  assert.equal(voicesFor('not a tag', ROUTE), undefined);
});

test('tells the player plainly when their language has no voice', () => {
  assert.equal(
    noVoiceNotice('pt-PT', [provider(PT_BR_PROVIDER_ID, true)], ROUTE),
    'No spoken voice exists for European Portuguese yet. The story stays in text.',
  );
});

test('tells the player when the voice for their language is not available on this computer', () => {
  const notice = 'Brazilian Portuguese voices are not available on this computer. The story stays in text.';
  assert.equal(noVoiceNotice('pt-BR', [], ROUTE), notice);
  assert.equal(noVoiceNotice('pt-BR', [provider(PT_BR_PROVIDER_ID, false)], ROUTE), notice);
});

test('rpg-42a.117 the no-voice notices read in Brazilian Portuguese and Spanish', () => {
  assert.equal(
    noVoiceNotice('pt-PT', [provider(PT_BR_PROVIDER_ID, true)], ROUTE, 'pt-BR'),
    'Ainda não existe voz falada para português (Portugal). A história continua em texto.',
  );
  assert.equal(
    noVoiceNotice('pt-BR', [], ROUTE, 'pt-BR'),
    'As vozes em português (Brasil) não estão disponíveis neste computador. A história continua em texto.',
  );
  assert.equal(
    noVoiceNotice('pt-BR', [], ROUTE, 'es'),
    'Las voces en portugués de Brasil no están disponibles en este equipo. La historia sigue en texto.',
  );
});

test('rpg-42a.117 the notice catalog covers every locale with the same keys', () => {
  assert.deepEqual(missingKeys(VOICE_NOTICE_CATALOG), []);
});

test('says nothing when a voice for the language is ready', () => {
  assert.equal(noVoiceNotice('pt-BR', [provider(PT_BR_PROVIDER_ID, true)], ROUTE), undefined);
  assert.equal(noVoiceNotice('en-US', [provider(KOKORO_PROVIDER_ID, true)], ROUTE), undefined);
});

test('rpg-42a.40 the voice locale follows the campaign language when a provider speaks it', () => {
  assert.equal(voiceLocaleFor('pt-BR', 'en-US'), 'pt-BR');
  assert.equal(voiceLocaleFor('en', 'pt-BR'), 'en');
  assert.equal(voiceLocaleFor('ja', 'en-US'), 'en-US');
});

test('rpg-cm63.53 the ONNX route narrates pt-BR with pf_dora on the kokoro-onnx provider', () => {
  const [, portuguese] = languageVoicesFor('onnx');
  assert.equal(portuguese?.providerId, KOKORO_ONNX_PROVIDER_ID);
  assert.equal(portuguese?.narrator, 'pf_dora');
  assert.equal(languageVoicesFor('mlx')[1]?.providerId, MLX_KOKORO_PROVIDER_ID);
});

const capable = (id: string, capabilities: KokoroCapabilities): TtsProvider & { capabilities: KokoroCapabilities } => ({
  ...provider(id, true),
  capabilities,
});

test('the pt-BR narrator lists every engine that speaks pt-BR, the route engine first', () => {
  const providers = [
    capable(CHATTERBOX_PROVIDER_ID, CHATTERBOX_CAPABILITIES),
    capable(KOKORO_PROVIDER_ID, KOKORO_CAPABILITIES),
    capable(PT_BR_PROVIDER_ID, MLX_KOKORO_CAPABILITIES),
  ];
  assert.deepEqual(narratorFallbacks('pt-BR', ROUTE, providers), [
    { providerId: PT_BR_PROVIDER_ID, voiceId: 'pf_dora' },
    { providerId: CHATTERBOX_PROVIDER_ID, voiceId: CHATTERBOX_CAPABILITIES.voices[0] },
  ]);
});

test('an English narrator keeps one fallback and a language nobody speaks has none', () => {
  const providers = [capable(CHATTERBOX_PROVIDER_ID, CHATTERBOX_CAPABILITIES)];
  assert.deepEqual(narratorFallbacks('en-GB', ROUTE, providers), [
    { providerId: KOKORO_PROVIDER_ID, voiceId: 'af_heart' },
  ]);
  assert.deepEqual(narratorFallbacks('xx-YY', ROUTE, providers), []);
});

test('the failure notice reads in every catalog language', () => {
  assert.match(synthesisFailureNotice('en'), /could not be read aloud/);
  assert.match(synthesisFailureNotice('pt-BR'), /não pôde ser lida em voz alta/);
});
