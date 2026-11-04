import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseCharacterProfile } from '../../domain/src/character.ts';
import { attemptCheck, createSheet, D20_LITE_MANIFEST } from './d20-lite.ts';
import { createSeededRng, type Rng, type TrustedRoll } from './dice.ts';
import { DEFAULT_POOL_CONFIG, DICE_POOL_LITE_MANIFEST, rollPool } from './dice-pool-lite.ts';
import { adjudicate, NARRATIVE_MANIFEST } from './narrative.ts';
import { type RulePackManifest, validateManifest } from './rulepack.ts';
import type { TraitSheet } from './traits.ts';

const SEED = 42;
const ACTION_ID = 'act-compat';
const CHECK_DC = 12;
const POOL_DICE = 4;
const ROLL_ID_SEPARATOR = ':';
const AVERAGE_SCORE = 5;
const HERO = 'hero' as TraitSheet['characterId'];
const CORE_MODULES = ['resolve.ts', 'compile.ts', 'rulepack.ts', 'dsl.ts', 'dice.ts'];
const GENRE_SOURCE = join(import.meta.dirname, '..', '..', 'content', 'src', 'genrepack.ts');
const GENRE_WORDS = ['fantasy', 'cyberpunk', 'noir', 'horror', 'sci-fi', 'space-opera', 'western', 'steampunk'];
const GENRE_IDS = ['noir', 'space-opera'];
const CONTENT_PACKAGE = 'content/';

type Output = { payload: Record<string, unknown>; rolls: readonly TrustedRoll[]; actionIds: readonly string[] };

type PackContract = {
  manifest: RulePackManifest;
  fields: readonly string[];
  run: (actionId: string, rng: Rng) => Output;
};

const unwrap = <T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> => {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result as Extract<T, { ok: true }>;
};

const PACKS: readonly PackContract[] = [
  {
    manifest: NARRATIVE_MANIFEST,
    fields: ['mode', 'actionId', 'intent', 'outcome'],
    run: (actionId) => {
      const { adjudication } = unwrap(adjudicate({ actionId, intent: 'pick the lock', outcome: 'the door opens' }));
      return { payload: adjudication, rolls: [], actionIds: [adjudication.actionId] };
    },
  },
  {
    manifest: D20_LITE_MANIFEST,
    fields: ['sheet', 'changes', 'events'],
    run: (actionId, rng) => {
      const sheet = createSheet({
        characterId: HERO,
        attributes: { might: AVERAGE_SCORE, agility: AVERAGE_SCORE, wits: AVERAGE_SCORE, presence: AVERAGE_SCORE },
      });
      const {
        ok: _ok,
        rolls,
        ...payload
      } = unwrap(attemptCheck({ actionId, sheet, attribute: 'wits', dc: CHECK_DC, rng }));
      return { payload, rolls, actionIds: payload.events.map((event) => event.actionId) };
    },
  },
  {
    manifest: DICE_POOL_LITE_MANIFEST,
    fields: ['faces', 'successes', 'complications', 'outcome'],
    run: (actionId, rng) => {
      const { rolls, ...payload } = unwrap(
        rollPool({ actionId, dice: POOL_DICE, config: DEFAULT_POOL_CONFIG, rng }),
      ).roll;
      return { payload, rolls, actionIds: [] };
    },
  },
];

const runSeeded = (pack: PackContract, actionId = ACTION_ID) => pack.run(actionId, createSeededRng(SEED));
const rollActionId = (roll: TrustedRoll) => roll.rollId.split(ROLL_ID_SEPARATOR)[0];
const coreSource = (file: string) => readFileSync(join(import.meta.dirname, file), 'utf8').toLowerCase();

test('run same domain test suite across narrative, d20-lite and dice-pool-lite packs', () => {
  assert.deepEqual(
    PACKS.map((pack) => pack.manifest.id),
    ['narrative', 'd20-lite', 'dice-pool-lite'],
  );
  for (const pack of PACKS) {
    const { id } = pack.manifest;
    assert.deepEqual(validateManifest(pack.manifest), { ok: true, manifest: pack.manifest }, id);
    const output = runSeeded(pack);
    assert.deepEqual(runSeeded(pack), output, `${id} is deterministic for a fixed seed`);
    assert.deepEqual(Object.keys(output.payload).sort(), [...pack.fields].sort(), `${id} payload shape`);
    const foreign = PACKS.filter((other) => other !== pack)
      .flatMap((other) => other.fields)
      .filter((field) => !pack.fields.includes(field));
    assert.deepEqual(
      foreign.filter((field) => Object.hasOwn(output.payload, field)),
      [],
      `${id} leaks no other pack fields`,
    );
    const traced = [...output.actionIds, ...output.rolls.map(rollActionId)];
    assert.ok(traced.length > 0, `${id} output carries an actionId`);
    assert.deepEqual(new Set(traced), new Set([ACTION_ID]), `${id} output traces to its action`);
  }
  const interleaved = PACKS.map((pack) => runSeeded(pack));
  assert.deepEqual(
    [...PACKS].reverse().map((pack) => runSeeded(pack)),
    [...interleaved].reverse(),
    'packs share no hidden state',
  );
});

test('switching genre requires no core ruleset change and vice versa', () => {
  const packIds = PACKS.map((pack) => pack.manifest.id);
  for (const file of CORE_MODULES) {
    const source = coreSource(file);
    for (const word of [...packIds, ...GENRE_WORDS, CONTENT_PACKAGE]) {
      assert.equal(source.includes(word), false, `${file} must not reference ${word}`);
    }
  }
  const genreSource = readFileSync(GENRE_SOURCE, 'utf8').toLowerCase();
  for (const id of packIds) {
    assert.equal(genreSource.includes(`'${id}'`), false, `genrepack.ts must not reference ${id}`);
  }
  for (const pack of PACKS) {
    const { id, edition, revision } = pack.manifest;
    const baseline = runSeeded(pack);
    for (const genre of GENRE_IDS) {
      const profile = parseCharacterProfile({
        identity: { name: `${genre} hero` },
        motivations: [],
        background: genre,
        traits: [],
        conditions: [],
        rulepack: { id, edition, revision },
      });
      assert.ok(profile.ok, `${id} with ${genre}`);
      assert.deepEqual(profile.profile.rulepack, { id, edition, revision });
      assert.deepEqual(validateManifest(pack.manifest), { ok: true, manifest: pack.manifest });
      assert.deepEqual(runSeeded(pack), baseline, `${id} resolution is independent of ${genre}`);
    }
  }
});
