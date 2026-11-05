import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KOKORO_CAPABILITIES, KOKORO_PROVIDER_ID } from './kokoro-provider.ts';
import { narratorFallback } from './language-voices.ts';
import { createNpcVoices, type InstalledVoice, installedVoices, pickVoice } from './npc-voice.ts';
import type { TtsProvider } from './tts.ts';
import type { VoiceProfile } from './voice.ts';

const CAMPAIGN = 'camp-1';
const OTHER_CAMPAIGN = 'camp-2';
const NPC = 'npc-mira';
const LANGUAGE = 'en-GB';
const FEMALE = 'female';
const MALE = 'male';

const voice = (voiceId: string): InstalledVoice => ({ providerId: KOKORO_PROVIDER_ID, voiceId });
const ENGLISH_VOICES = KOKORO_CAPABILITIES.voices.map(voice);
const BASE: VoiceProfile = {
  id: 'base',
  language: LANGUAGE,
  pace: 1,
  style: 'plain',
  pronunciations: {},
  fallbacks: [],
};
const profileWith = (voiceId: string): VoiceProfile => ({
  ...BASE,
  id: NPC,
  fallbacks: [{ providerId: KOKORO_PROVIDER_ID, voiceId }],
});

interface Harness {
  readonly notices: string[];
  readonly store: Map<string, VoiceProfile>;
  readonly assigned: string[];
  installed: readonly InstalledVoice[];
  readonly npcVoices: ReturnType<typeof createNpcVoices>;
}

const harness = (store = new Map<string, VoiceProfile>(), hints: Record<string, { gender?: string }> = {}): Harness => {
  const state: Harness = {
    notices: [],
    store,
    assigned: [],
    installed: ENGLISH_VOICES,
    npcVoices: undefined as never,
  };
  const npcVoices = createNpcVoices({
    campaignId: CAMPAIGN,
    language: LANGUAGE,
    base: BASE,
    installed: () => state.installed,
    stored: (id) => store.get(id),
    assign: (id, profile) => {
      state.assigned.push(id);
      store.set(id, profile);
    },
    hintOf: (id) => hints[id],
    notify: (message) => state.notices.push(message),
  });
  return Object.assign(state, { npcVoices });
};

const voiceOf = (profile: VoiceProfile | undefined): string | undefined => profile?.fallbacks[0]?.voiceId;

test('picking is deterministic and ignores the order voices are listed in', () => {
  const first = pickVoice({ campaignId: CAMPAIGN, entityId: NPC, voices: ENGLISH_VOICES });
  const again = pickVoice({ campaignId: CAMPAIGN, entityId: NPC, voices: [...ENGLISH_VOICES].reverse() });
  assert.deepEqual(first, again);
  assert.ok(first);
});

test('different campaigns can give the same npc different voices', () => {
  const picks = new Set(
    [CAMPAIGN, OTHER_CAMPAIGN, 'c3', 'c4', 'c5', 'c6'].map(
      (campaignId) => pickVoice({ campaignId, entityId: NPC, voices: ENGLISH_VOICES })?.voiceId,
    ),
  );
  assert.ok(picks.size > 1);
});

test('a gender hint limits the pick to matching voices', () => {
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
    assert.match(
      pickVoice({ campaignId: CAMPAIGN, entityId: id, voices: ENGLISH_VOICES, hint: { gender: FEMALE } })?.voiceId ??
        '',
      /^.f_/,
    );
    assert.match(
      pickVoice({ campaignId: CAMPAIGN, entityId: id, voices: ENGLISH_VOICES, hint: { gender: MALE } })?.voiceId ?? '',
      /^.m_/,
    );
  }
});

test('a hint nothing matches falls back to any voice; no voices gives nothing', () => {
  const femaleOnly = [voice('af_heart')];
  assert.equal(
    pickVoice({ campaignId: CAMPAIGN, entityId: NPC, voices: femaleOnly, hint: { gender: MALE } })?.voiceId,
    'af_heart',
  );
  assert.equal(pickVoice({ campaignId: CAMPAIGN, entityId: NPC, voices: [] }), undefined);
});

test('installed voices come from healthy providers that speak the language', () => {
  const provider = (healthy: boolean): TtsProvider & { capabilities: typeof KOKORO_CAPABILITIES } => ({
    id: KOKORO_PROVIDER_ID,
    locality: 'local',
    retention: 'none',
    healthy: () => healthy,
    capabilities: KOKORO_CAPABILITIES,
    synthesize: async function* () {},
  });
  assert.deepEqual(installedVoices([provider(true)], LANGUAGE), ENGLISH_VOICES);
  assert.deepEqual(installedVoices([provider(false)], LANGUAGE), []);
  assert.deepEqual(installedVoices([provider(true)], 'pt-BR'), []);
});

test('an npc without a profile gets a picked voice committed once', () => {
  const { npcVoices, assigned, store } = harness();
  const profile = npcVoices.profileOf(NPC);
  assert.deepEqual(assigned, [NPC]);
  assert.equal(profile?.id, NPC);
  assert.equal(profile?.language, LANGUAGE);
  assert.deepEqual(store.get(NPC), profile);
  npcVoices.profileOf(NPC);
  assert.deepEqual(assigned, [NPC]);
});

test('the picked voice honours the gm hint', () => {
  const { npcVoices } = harness(undefined, { [NPC]: { gender: MALE } });
  assert.match(voiceOf(npcVoices.profileOf(NPC)) ?? '', /^.m_/);
});

test('the same npc keeps its voice after reload and after new voices are installed', () => {
  const first = harness();
  const picked = voiceOf(first.npcVoices.profileOf(NPC));
  const reloaded = harness(first.store);
  reloaded.installed = [...ENGLISH_VOICES, voice('zz_extra'), voice('af_new')];
  assert.equal(voiceOf(reloaded.npcVoices.profileOf(NPC)), picked);
  assert.deepEqual(reloaded.assigned, []);
});

test('a player override wins and survives restart', () => {
  const first = harness();
  first.npcVoices.profileOf(NPC);
  first.store.set(NPC, profileWith('bm_george'));
  const reloaded = harness(first.store);
  assert.equal(voiceOf(reloaded.npcVoices.profileOf(NPC)), 'bm_george');
  assert.deepEqual(reloaded.assigned, []);
});

test('a missing stored voice uses the nearest same-gender voice for this session only', () => {
  const stored = profileWith('bm_george');
  const gone = harness(new Map([[NPC, stored]]));
  gone.installed = ENGLISH_VOICES.filter(({ voiceId }) => voiceId !== 'bm_george');
  const substitute = voiceOf(gone.npcVoices.profileOf(NPC));
  assert.match(substitute ?? '', /^.m_/);
  assert.notEqual(substitute, 'bm_george');
  assert.equal(gone.store.get(NPC), stored);
  assert.equal(gone.notices.length, 1);
});

test('without a same-gender voice any same-language voice is used', () => {
  const femaleLeft = harness(new Map([[NPC, profileWith('bm_george')]]));
  femaleLeft.installed = [voice('af_heart')];
  assert.equal(voiceOf(femaleLeft.npcVoices.profileOf(NPC)), 'af_heart');
});

test('with no voices installed the stored profile comes back unchanged and silent', () => {
  const stored = profileWith('bm_george');
  const none = harness(new Map([[NPC, stored]]));
  none.installed = [];
  assert.equal(none.npcVoices.profileOf(NPC), stored);
  assert.equal(none.notices.length, 0);
  assert.deepEqual(none.assigned, []);
  assert.equal(none.store.get(NPC), stored);
});

test('the substitute is deterministic, spreads npcs and the notice hides the speaker id', () => {
  const stored = profileWith('bm_george');
  const substitutes = new Set<string | undefined>();
  for (const id of ['npc-1', 'npc-2', 'npc-3', 'npc-4', 'npc-5', 'npc-6', 'npc-7', 'npc-8']) {
    const first = harness(new Map([[id, { ...stored, id }]]));
    first.installed = ENGLISH_VOICES.filter(({ voiceId }) => voiceId !== 'bm_george');
    const picked = voiceOf(first.npcVoices.profileOf(id));
    assert.equal(picked, voiceOf(first.npcVoices.profileOf(id)));
    assert.equal(first.notices.length, 1);
    assert.equal(first.notices[0]?.includes(id), false);
    substitutes.add(picked);
  }
  assert.ok(substitutes.size > 1);
});

test('the player is told once per speaker per session', () => {
  const stored = profileWith('bm_george');
  const state = harness(
    new Map([
      [NPC, stored],
      ['npc-two', { ...stored, id: 'npc-two' }],
    ]),
  );
  state.installed = [voice('af_heart')];
  for (let spoken = 0; spoken < 3; spoken += 1) {
    state.npcVoices.profileOf(NPC);
  }
  assert.equal(state.notices.length, 1);
  state.npcVoices.profileOf('npc-two');
  assert.equal(state.notices.length, 2);
});

test('narrator defaults resolve per language', () => {
  assert.equal(narratorFallback('en')?.voiceId, 'af_heart');
  assert.equal(narratorFallback('pt-BR')?.voiceId, 'pf_dora');
});
