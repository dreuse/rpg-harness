import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { voiceBlendFor } from './cinematic.ts';
import { designedVoicepackPath } from './designed-voicepack-path.ts';
import { DESIGNED_INPUTS, DESIGNED_VOICES, designedVoiceOf } from './designed-voices.ts';
import { KOKORO_MAX_TOKENS, KOKORO_STYLE_DIMENSION } from './kokoro-onnx-engine.ts';
import { MLX_KOKORO_CAPABILITIES } from './kokoro-provider.ts';
import { KOKORO_VOICE_LICENCE, PT_BR_BLENDS } from './pt-br-blends.ts';
import { VOICE_CATALOG } from './voice-catalog.ts';

const MIN_PER_GENDER = 2;
const MARKER_INDEX = 1;
const MARKER_GENDER: Readonly<Record<string, string>> = { f: 'female', m: 'male' };
const PACK_BYTES = KOKORO_MAX_TOKENS * KOKORO_STYLE_DIMENSION * Float32Array.BYTES_PER_ELEMENT;
const countOf = (gender: string): number => DESIGNED_VOICES.filter((voice) => voice.gender === gender).length;

test('rpg-cm63.63 the manifest lists at least two female and two male voices with varied ages', () => {
  assert.ok(countOf('female') >= MIN_PER_GENDER);
  assert.ok(countOf('male') >= MIN_PER_GENDER);
  assert.ok(new Set(DESIGNED_VOICES.flatMap(({ ages }) => ages)).size > 1);
  const ids = DESIGNED_VOICES.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
});

test('rpg-cm63.63 every designed voice records its source, similarity score and licence', () => {
  for (const voice of DESIGNED_VOICES) {
    assert.equal(voice.gender, MARKER_GENDER[voice.id.charAt(MARKER_INDEX)], voice.id);
    assert.match(voice.id, /^p[fm]_[a-z]+$/);
    assert.ok(voice.references.length > 0, voice.id);
    for (const reference of voice.references) assert.match(reference.url, /^https:\/\//);
    assert.ok(voice.similarity.score > 0 && voice.similarity.score <= 1, voice.id);
    assert.ok(voice.similarity.score > voice.similarity.otherTargetsMax, voice.id);
    assert.ok(voice.ages.length > 0 && voice.timbre.length > 0, voice.id);
    assert.equal(voice.licence, KOKORO_VOICE_LICENCE);
  }
});

test('rpg-cm63.63 the manifest records the licence of every input', () => {
  assert.ok(DESIGNED_INPUTS.length >= 3);
  for (const input of DESIGNED_INPUTS) assert.ok(input.licence.length > 0 && input.source.length > 0, input.role);
});

test('rpg-cm63.63 each voicepack file matches its recorded size and checksum and holds finite style values', () => {
  for (const voice of DESIGNED_VOICES) {
    const bytes = readFileSync(designedVoicepackPath(voice));
    assert.equal(bytes.byteLength, PACK_BYTES, voice.id);
    assert.equal(voice.bytes, PACK_BYTES, voice.id);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), voice.sha256, voice.id);
    const values = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / Float32Array.BYTES_PER_ELEMENT);
    assert.ok(values.every(Number.isFinite), voice.id);
  }
});

test('rpg-cm63.63 designed ids resolve and other ids do not', () => {
  const [voice] = DESIGNED_VOICES;
  assert.ok(voice);
  assert.equal(designedVoiceOf(voice.id), voice);
  for (const id of ['pf_dora', 'pf_clara', 'pf_unknown', '__proto__', 'toString'])
    assert.equal(designedVoiceOf(id), undefined, id);
});

test('rpg-cm63.63 designed voices are listed and tagged in the catalog and on the pt-BR route', () => {
  for (const voice of DESIGNED_VOICES) {
    assert.ok(MLX_KOKORO_CAPABILITIES.voices.includes(voice.id), voice.id);
    assert.deepEqual(VOICE_CATALOG[voice.id], {
      gender: voice.gender,
      ages: voice.ages,
      timbre: voice.timbre,
      licence: voice.licence,
    });
    assert.ok(!PT_BR_BLENDS.some(({ id }) => id === voice.id), voice.id);
  }
});

test('rpg-cm63.63 a random per-character blend never uses a designed voice', () => {
  for (const voice of DESIGNED_VOICES) {
    const prefix = voice.id.slice(0, 2);
    const base = prefix === 'pf' ? 'pf_dora' : 'pm_alex';
    assert.equal(voiceBlendFor('npc-any', voice.id, MLX_KOKORO_CAPABILITIES.voices), undefined);
    for (let index = 0; index < 20; index++) {
      assert.ok(
        !DESIGNED_VOICES.some(
          ({ id }) => id === voiceBlendFor(`npc-${index}`, base, MLX_KOKORO_CAPABILITIES.voices)?.second,
        ),
      );
    }
  }
});
