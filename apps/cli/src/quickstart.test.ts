import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { INITIAL_DRAFT, nextDraft, planCommand } from '../../../packages/client-protocol/src/guided-start.ts';
import { PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import { FANTASY_PACK, HORROR_PACK } from '../../../packages/content/src/packs.ts';
import { readCampaignState } from './engine-gateway.ts';
import { hermeticGmEnv } from './gm-test-env.ts';
import { BUILT_IN_PACKS } from './import-gateway.ts';
import { planCampaign, planResult, planStart, startOptions, UnknownEdition } from './quickstart.ts';

const BIN = join(import.meta.dirname, 'bin.ts');
const EXIT_OK = 0;
const DEFAULT_CAMPAIGN = 'Ember';
const INTENT_CAMPAIGN = 'Hollow';
const INTENT = 'A horror story using the Narrative rules';
const MISSING_INTENT = 'A fantasy adventure using the Pathfinder rules';
const SCENE_INTENT = 'A fantasy adventure using the Narrative rules';
const HORROR_OPENING = `${HORROR_PACK.story.openingScenes[0]}.`;
const FANTASY_OPENING = `${FANTASY_PACK.story.openingScenes[0]}.`;
const UNDECODABLE_FILE = '%E0%A4%A.sqlite';

const withDataDir = (run: (dataDir: string) => void) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-quickstart-'));
  try {
    run(dataDir);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
};

const rpg = (dataDir: string, args: readonly string[]) =>
  spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: { ...hermeticGmEnv(), RPG_DATA_DIR: dataDir },
  });

const succeed = (dataDir: string, args: readonly string[]) => {
  const result = rpg(dataDir, args);
  assert.equal(result.status, EXIT_OK, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
};

test('new users can start with default choices or one-sentence campaign intent', () =>
  withDataDir((dataDir) => {
    const defaults = succeed(dataDir, ['new', DEFAULT_CAMPAIGN]);
    assert.match(defaults, /^Ruleset: none \(default\)$/m);
    assert.match(defaults, /^Genre: none \(default\)$/m);
    assert.match(defaults, /^Dice: as the ruleset decides \(default\)$/m);

    const intended = succeed(dataDir, ['new', INTENT_CAMPAIGN, INTENT]);
    assert.match(intended, /^Ruleset: narrative original \(derived\)$/m);
    assert.match(intended, /^Genre: horror 1\.0\.0 \(derived\)$/m);

    const launcher = succeed(dataDir, []);
    assert.ok(launcher.includes(DEFAULT_CAMPAIGN) && launcher.includes(INTENT_CAMPAIGN));
    assert.match(launcher, /Type a number to continue/);

    const saved = readCampaignState(dataDir, INTENT_CAMPAIGN);
    assert.ok(succeed(dataDir, ['resume', INTENT_CAMPAIGN]).trim().length > 0);
    assert.deepEqual(readCampaignState(dataDir, INTENT_CAMPAIGN), saved);
  }));

test('missing ruleset files are surfaced honestly instead of invented', () =>
  withDataDir((dataDir) => {
    const result = rpg(dataDir, ['new', DEFAULT_CAMPAIGN, MISSING_INTENT]);
    assert.notEqual(result.status, EXIT_OK);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Ruleset Pathfinder is not installed\./);
    assert.match(result.stderr, /Installed rulesets: d20-lite original, dice-pool-lite original, narrative original\./);
    assert.match(result.stderr, /rpg import <file>/);
    assert.deepEqual(readdirSync(dataDir), []);
  }));

test('from single prompt to scene opening without manual JSON editing', () =>
  withDataDir((dataDir) => {
    const opened = succeed(dataDir, ['new', INTENT_CAMPAIGN, SCENE_INTENT]);
    assert.match(opened, /^Ruleset: narrative original \(derived\)$/m);
    assert.match(opened, /^Genre: fantasy 1\.0\.0 \(derived\)$/m);
    assert.ok(opened.includes(FANTASY_OPENING), opened);
    assert.deepEqual(readdirSync(dataDir), [`${INTENT_CAMPAIGN}.sqlite`]);
    const state = readCampaignState(dataDir, INTENT_CAMPAIGN);
    assert.equal(state.currentScene?.title, FANTASY_PACK.genre.name);
    assert.ok(succeed(dataDir, ['resume', INTENT_CAMPAIGN]).includes(FANTASY_OPENING));
  }));

test('a horror intent opens at its own scene instead of the fantasy default', () =>
  withDataDir((dataDir) => {
    const opened = succeed(dataDir, ['new', INTENT_CAMPAIGN, INTENT]);
    assert.ok(opened.includes(HORROR_OPENING), opened);
    assert.equal(opened.includes(FANTASY_OPENING), false);
  }));

test('ruleset not present triggers import/choice instead of invented rules enforcement', () =>
  withDataDir((dataDir) => {
    const result = rpg(dataDir, ['new', INTENT_CAMPAIGN, MISSING_INTENT]);
    assert.notEqual(result.status, EXIT_OK);
    assert.match(result.stderr, /Installed rulesets: .*narrative original/);
    assert.match(result.stderr, /Run rpg import <file> to add its rule files, or name an installed ruleset\./);
    assert.throws(() => readCampaignState(dataDir, INTENT_CAMPAIGN), /No campaign named/);
  }));

test('new saves the campaign settings and resume shows the saved ruleset and genre', () =>
  withDataDir((dataDir) => {
    const opened = succeed(dataDir, ['new', INTENT_CAMPAIGN, INTENT]);
    assert.match(opened, /^Saved settings:$/m);
    const resumed = succeed(dataDir, ['resume', INTENT_CAMPAIGN]);
    assert.match(resumed, /^Ruleset: narrative original \(derived\)$/m);
    assert.match(resumed, /^Genre: horror 1\.0\.0 \(derived\)$/m);
    assert.ok(resumed.includes(HORROR_OPENING), resumed);
  }));

test('the launcher skips saved files whose names cannot be decoded', () =>
  withDataDir((dataDir) => {
    succeed(dataDir, ['new', DEFAULT_CAMPAIGN]);
    writeFileSync(join(dataDir, UNDECODABLE_FILE), '');
    const launcher = succeed(dataDir, []);
    assert.match(launcher, new RegExp(`^ {2}1\\. ${DEFAULT_CAMPAIGN}\\b.*$`, 'm'));
    assert.doesNotMatch(launcher, /^ {2}2\./m);
  }));

test('plain-English genre names resolve to installed genre ids', () => {
  const cases = [
    ['a mystery story', 'investigative-mystery'],
    ['a modern adventure', 'modern-adventure'],
    ['a blank world', 'blank-world'],
    ['a science fiction game', 'science-fiction'],
    ['a fantasy story in a vast world', 'fantasy'],
    ['a horror story set in a ruined world', 'horror'],
  ] as const;
  for (const [text, id] of cases) assert.equal(planCampaign(text).genre?.id, id, text);
  assert.throws(() => planCampaign('a western story'), /not installed/);
});

const PLAN = { version: PROTOCOL_VERSION, type: 'PlanCampaign' } as const;
const DOCUMENTED_DEFAULTS = [
  { field: 'ruleset', value: 'none', provenance: 'default' },
  { field: 'genre', value: 'none', provenance: 'default' },
  { field: 'character', value: 'none', provenance: 'default' },
  { field: 'dice', value: 'as the ruleset decides', provenance: 'default' },
  { field: 'diceVisualization', value: 'off', provenance: 'default' },
  { field: 'voiceOutput', value: 'off', provenance: 'default' },
  { field: 'simulation', value: 'off', provenance: 'default' },
];

test('rpg-42a.14 start options list only installed rulesets, recommend the lightest and offer genre characters', () => {
  const { genres, rulesets } = startOptions();
  assert.deepEqual(
    rulesets.map(({ id, edition }) => ({ id, edition })),
    BUILT_IN_PACKS.map(({ id, edition }) => ({ id, edition })),
  );
  assert.deepEqual(
    rulesets.filter(({ recommended }) => recommended).map(({ id }) => id),
    ['narrative'],
  );
  assert.ok(rulesets.find(({ id }) => id === 'd20-lite')?.sheet.includes('Might'));
  const fantasy = genres.find(({ id }) => id === FANTASY_PACK.genre.id);
  assert.equal(fantasy?.blurb, FANTASY_PACK.genre.examples[0]);
  assert.deepEqual(
    fantasy?.characters,
    FANTASY_PACK.genre.archetypes.map(({ name, summary }) => ({ name, summary })),
  );
});

test('rpg-42a.14 skipping every step plans the documented defaults with default provenance', () => {
  assert.deepEqual(planStart({ ...PLAN, choices: {} }).entries, DOCUMENTED_DEFAULTS);
  assert.deepEqual(planStart(PLAN).entries, DOCUMENTED_DEFAULTS);
  const chosen = planStart({ ...PLAN, choices: { genre: 'fantasy', voiceOutput: true, client: 'desktop' } }).entries;
  assert.deepEqual(chosen[1], { field: 'genre', value: 'fantasy', provenance: 'explicit' });
  assert.deepEqual(chosen[5], { field: 'voiceOutput', value: 'on', provenance: 'explicit' });
});

const DICE_ANIMATION_INTENT = 'A fantasy story using the d20-lite rules with dice animation';
const TUI_CLIENT = 'tui';

test('rpg-42a.8 free text turns dice animation on for the tui client', () => {
  assert.equal(planCampaign(DICE_ANIMATION_INTENT, { client: TUI_CLIENT }).values.diceVisualization, true);
  const described = nextDraft(nextDraft(INITIAL_DRAFT, { kind: 'path', path: 'describe' }), {
    kind: 'enter',
    text: DICE_ANIMATION_INTENT,
  });
  const entry = planStart(planCommand(described, TUI_CLIENT), TUI_CLIENT).entries.find(
    ({ field }) => field === 'diceVisualization',
  );
  assert.deepEqual(entry, { field: 'diceVisualization', value: 'on', provenance: 'derived' });
});

const DICE_ONLY_INTENT = 'with dice animation';
const VOICE_DICE_INTENT = `${DICE_ANIMATION_INTENT} and voice narration`;
const DICE_HINT = 'Use the tui or desktop client for diceVisualization. Add --client tui.';
const NEEDS_DICE = 'diceVisualization needs a ruleset with dice.';

test('rpg-42a.31 new explains each conflict once, hints at --client and accepts --client', () =>
  withDataDir((dataDir) => {
    const refusals: [string[], string][] = [
      [[DICE_ANIMATION_INTENT], `${DICE_HINT}\n`],
      [[DICE_ONLY_INTENT], `${NEEDS_DICE}\n${DICE_HINT}\n`],
      [[DICE_ONLY_INTENT, '--client', TUI_CLIENT], `${NEEDS_DICE}\n`],
      [[VOICE_DICE_INTENT], 'Use the desktop client for voiceOutput and diceVisualization. Add --client desktop.\n'],
    ];
    for (const [args, stderr] of refusals) {
      const refused = rpg(dataDir, ['new', DEFAULT_CAMPAIGN, ...args]);
      assert.notEqual(refused.status, EXIT_OK);
      assert.equal(refused.stderr, stderr, args.join(' '));
    }
    assert.deepEqual(readdirSync(dataDir), []);
    succeed(dataDir, ['new', DEFAULT_CAMPAIGN, DICE_ANIMATION_INTENT, '--client', TUI_CLIENT]);
    assert.deepEqual(readdirSync(dataDir), [`${DEFAULT_CAMPAIGN}.sqlite`]);
  }));

test('rpg-42a.14 an uninstalled or invalid edition is reported as unknown and never substituted', () => {
  assert.throws(() => planStart({ ...PLAN, intent: 'D&D 1.9' }), UnknownEdition);
  assert.throws(() => planStart({ ...PLAN, choices: { ruleset: { id: 'd20-lite', edition: '5e' } } }), UnknownEdition);
  assert.throws(() => planCampaign('Play D&D 1.9'), /D&D 1\.9 is not installed/);
});

const TYPED_CHARACTER = 'Ash, a tired knight';
const STATTED_CHARACTER = `${TYPED_CHARACTER}. Might 3, Agility 2, Wits 2, Presence 1`;
const NARRATIVE_RULES = { id: 'narrative', edition: 'original' };
const D20_RULES = { id: 'd20-lite', edition: 'original' };
const characterPlan = (choices: Record<string, unknown>) =>
  planResult({ version: PROTOCOL_VERSION, type: 'PlanCampaign', choices });
const characterEntry = (choices: Record<string, unknown>) => {
  const plan = characterPlan(choices);
  return plan.ok ? plan.value.entries.find(({ field }) => field === 'character') : plan.error.message;
};

test('rpg-42a.14 plan builds the chosen character from the ruleset sheet and never claims one it cannot build', () => {
  const chosen = { field: 'character', value: 'Ash', provenance: 'explicit' };
  assert.deepEqual(characterEntry({ ruleset: NARRATIVE_RULES, character: TYPED_CHARACTER }), chosen);
  assert.deepEqual(characterEntry({ ruleset: D20_RULES, character: STATTED_CHARACTER }), chosen);
  assert.deepEqual(characterEntry({ character: TYPED_CHARACTER }), {
    field: 'character',
    value: 'none',
    provenance: 'default',
  });
  assert.match(
    String(characterEntry({ ruleset: D20_RULES, character: TYPED_CHARACTER })),
    /^Your character needs Might, Agility, Wits, and Presence\./,
  );
});

test('rpg-42a.19 ready-made characters are offered only on rules that can build them from a name', () => {
  const { genres, rulesets } = startOptions();
  const readyMade = Object.fromEntries(rulesets.map(({ id, readyMade }) => [id, readyMade]));
  assert.deepEqual(readyMade, { 'd20-lite': false, 'dice-pool-lite': true, narrative: true });
  const [archetype] = genres[0]?.characters ?? [];
  assert.ok(archetype !== undefined);
  assert.deepEqual(characterEntry({ ruleset: NARRATIVE_RULES, character: archetype.name }), {
    field: 'character',
    value: archetype.name,
    provenance: 'explicit',
  });
  assert.match(String(characterEntry({ ruleset: D20_RULES, character: archetype.name })), /^Your character needs/);
});

test('rpg-42a.38 start options declare usage and explain the diceless built-in pack in plain words', () => {
  const { rulesets } = startOptions();
  const usage = Object.fromEntries(rulesets.map(({ id, usage }) => [id, usage]));
  assert.deepEqual(usage, {
    'd20-lite': { resolution: 'dice', sheet: 'full' },
    'dice-pool-lite': { resolution: 'dice', sheet: 'full' },
    narrative: { resolution: 'adjudicated', sheet: 'none' },
  });
  assert.equal(
    rulesets.find(({ id }) => id === 'narrative')?.blurb,
    'No dice and no character sheet. The GM decides what happens from your story.',
  );
});

test('rpg-42a.38 the plan of a diceless ruleset has no dice entries', () => {
  const fields = (ruleset: Record<string, unknown>) => {
    const plan = characterPlan({ ruleset });
    return plan.ok ? plan.value.entries.map(({ field }) => field) : [];
  };
  assert.deepEqual(fields(NARRATIVE_RULES), ['ruleset', 'genre', 'character', 'voiceOutput', 'simulation']);
  assert.ok(fields(D20_RULES).includes('dice'));
});
