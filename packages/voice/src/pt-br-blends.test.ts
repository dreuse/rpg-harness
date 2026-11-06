import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MLX_KOKORO_CAPABILITIES } from './kokoro-provider.ts';
import { KOKORO_VOICE_LICENCE, namedBlendOf, PT_BR_BLEND_PARTNERS, PT_BR_BLENDS } from './pt-br-blends.ts';
import { VOICE_CATALOG } from './voice-catalog.ts';

const MIN_PER_GENDER = 4;
const BASE_VOICES = ['pf_dora', 'pm_alex', 'pm_santa'];
const MARKER_INDEX = 1;
const MARKER_GENDER: Readonly<Record<string, string>> = { f: 'female', m: 'male' };

const countOf = (gender: string): number =>
  MLX_KOKORO_CAPABILITIES.voices.filter((id) => VOICE_CATALOG[id]?.gender === gender).length;

test('rpg-cm63.45 at least four female and four male pt-BR voices are listed', () => {
  assert.ok(countOf('female') >= MIN_PER_GENDER);
  assert.ok(countOf('male') >= MIN_PER_GENDER);
});

test('rpg-cm63.45 every blend is listed, tagged and licensed', () => {
  const ids = PT_BR_BLENDS.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  for (const blend of PT_BR_BLENDS) {
    assert.ok(MLX_KOKORO_CAPABILITIES.voices.includes(blend.id), blend.id);
    assert.ok(BASE_VOICES.includes(blend.first), blend.id);
    assert.ok(!BASE_VOICES.includes(blend.id), blend.id);
    assert.ok(blend.weight > 0 && blend.weight < 1, blend.id);
    const entry = VOICE_CATALOG[blend.id];
    assert.ok(entry, `${blend.id} is not in the catalog`);
    assert.equal(entry.gender, MARKER_GENDER[blend.id.charAt(MARKER_INDEX)]);
    assert.equal(entry.gender, VOICE_CATALOG[blend.first]?.gender);
    assert.equal(entry.gender, VOICE_CATALOG[blend.second]?.gender);
    assert.ok(entry.ages.length > 0 && entry.timbre.length > 0);
    assert.equal(entry.licence, KOKORO_VOICE_LICENCE);
  }
});

test('rpg-cm63.45 each blend differs from the plain voices by age or timbre', () => {
  const signature = (id: string) => JSON.stringify([VOICE_CATALOG[id]?.ages, VOICE_CATALOG[id]?.timbre]);
  const signatures = [...BASE_VOICES, ...PT_BR_BLENDS.map(({ id }) => id)].map(signature);
  assert.equal(new Set(signatures).size, signatures.length);
});

test('rpg-cm63.45 a blend id resolves to its two voices and weight, other ids to nothing', () => {
  const [blend] = PT_BR_BLENDS;
  assert.ok(blend);
  assert.deepEqual(namedBlendOf(blend.id), { first: blend.first, second: blend.second, weight: blend.weight });
  for (const id of [...BASE_VOICES, 'af_heart', 'pf_unknown', '__proto__', 'toString'])
    assert.equal(namedBlendOf(id), undefined, id);
});

test('rpg-cm63.45 the partner list holds each second voice once and no pt-BR voice', () => {
  assert.deepEqual([...PT_BR_BLEND_PARTNERS].sort(), [...new Set(PT_BR_BLENDS.map(({ second }) => second))].sort());
  for (const partner of PT_BR_BLEND_PARTNERS) assert.ok(!BASE_VOICES.includes(partner));
});
