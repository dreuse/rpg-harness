import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type GenrePack, loadGenrePack } from '../../../packages/content/src/genrepack.ts';
import {
  BLANK_WORLD_PACK,
  FANTASY_PACK,
  HORROR_PACK,
  MODERN_ADVENTURE_PACK,
  MYSTERY_PACK,
  SCIENCE_FICTION_PACK,
} from '../../../packages/content/src/packs.ts';
import { attemptCheck, createSheet, D20_LITE_MANIFEST } from '../../../packages/rules/src/d20-lite.ts';
import { createSeededRng } from '../../../packages/rules/src/dice.ts';
import { DEFAULT_POOL_CONFIG, DICE_POOL_LITE_MANIFEST, rollPool } from '../../../packages/rules/src/dice-pool-lite.ts';
import { adjudicate, NARRATIVE_MANIFEST } from '../../../packages/rules/src/narrative.ts';
import { checkRequiredCapabilities, type RulePackManifest } from '../../../packages/rules/src/rulepack.ts';
import type { TraitSheet } from '../../../packages/rules/src/traits.ts';

const SEED = 7;
const CHECK_DC = 12;
const POOL_DICE = 3;
const AVERAGE_SCORE = 5;
const HERO = 'hero' as TraitSheet['characterId'];
const TACTICAL_REQUIREMENTS = ['combat', 'resources'];

const load = (input: unknown): GenrePack => {
  const result = loadGenrePack(input);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.pack;
};

const resolveWith = (manifest: RulePackManifest, actionId: string): unknown => {
  const rng = createSeededRng(SEED);
  if (manifest === NARRATIVE_MANIFEST) return adjudicate({ actionId, intent: 'search', outcome: 'a clue surfaces' });
  if (manifest === DICE_POOL_LITE_MANIFEST) {
    return rollPool({ actionId, dice: POOL_DICE, config: DEFAULT_POOL_CONFIG, rng });
  }
  if (manifest !== D20_LITE_MANIFEST) throw new Error(`no resolver for rule pack ${manifest.id}`);
  const sheet = createSheet({
    characterId: HERO,
    attributes: { might: AVERAGE_SCORE, agility: AVERAGE_SCORE, wits: AVERAGE_SCORE, presence: AVERAGE_SCORE },
  });
  return attemptCheck({ actionId, sheet, attribute: 'wits', dc: CHECK_DC, rng });
};

const RULE_PACKS = [NARRATIVE_MANIFEST, D20_LITE_MANIFEST, DICE_POOL_LITE_MANIFEST];
const GENRES = [FANTASY_PACK, SCIENCE_FICTION_PACK, HORROR_PACK, MYSTERY_PACK, MODERN_ADVENTURE_PACK, BLANK_WORLD_PACK];
const CHECKS_GENRE = { ...FANTASY_PACK.genre, id: 'fantasy-checks', requiredRuleCapabilities: ['checks'] };
const TACTICAL_GENRE = { ...FANTASY_PACK.genre, id: 'tactical-war', requiredRuleCapabilities: TACTICAL_REQUIREMENTS };

test('every shipped genre combines with narrative, d20-lite and dice-pool-lite', () => {
  for (const { genre } of GENRES) {
    const pack = load(genre);
    for (const manifest of RULE_PACKS) {
      const label = `${pack.id} with ${manifest.id}`;
      assert.deepEqual(checkRequiredCapabilities(manifest, pack.requiredRuleCapabilities ?? []), { ok: true }, label);
      const actionId = `${pack.id}:${manifest.id}`;
      const outcome = resolveWith(manifest, actionId);
      assert.equal((outcome as { ok: boolean }).ok, true, label);
      assert.deepEqual(resolveWith(manifest, actionId), outcome, `${label} is deterministic`);
    }
  }
});

test('a genre requiring checks accepts deterministic and adjudicated checks alike', () => {
  const pack = load(CHECKS_GENRE);
  assert.deepEqual(pack.requiredRuleCapabilities, ['checks']);
  for (const manifest of RULE_PACKS) {
    assert.deepEqual(checkRequiredCapabilities(manifest, pack.requiredRuleCapabilities ?? []), { ok: true });
  }
});

test('an incompatible genre and ruleset pair reports the missing capabilities instead of falling back to d20', () => {
  const pack = load(TACTICAL_GENRE);
  const required = pack.requiredRuleCapabilities ?? [];
  assert.deepEqual(checkRequiredCapabilities(D20_LITE_MANIFEST, required), { ok: true });
  assert.deepEqual(checkRequiredCapabilities(DICE_POOL_LITE_MANIFEST, required), {
    ok: false,
    packId: 'dice-pool-lite',
    missing: ['combat', 'resources'],
    reason: 'Rule pack dice-pool-lite disables required capabilities: combat, resources',
  });
  assert.deepEqual(checkRequiredCapabilities(NARRATIVE_MANIFEST, required), {
    ok: false,
    packId: 'narrative',
    missing: ['resources'],
    reason: 'Rule pack narrative disables required capabilities: resources',
  });
});
