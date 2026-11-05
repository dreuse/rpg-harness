import {
  type CampaignPlan,
  failure,
  type PlanCampaign,
  type PlanEntry,
  PROTOCOL_VERSION,
  type Result,
  type StartOptions,
} from '../../../packages/client-protocol/src/protocol.ts';
import type { GenrePack } from '../../../packages/content/src/genrepack.ts';
import {
  BLANK_WORLD_PACK,
  FANTASY_PACK,
  HORROR_PACK,
  MODERN_ADVENTURE_PACK,
  MYSTERY_PACK,
  SCIENCE_FICTION_PACK,
} from '../../../packages/content/src/packs.ts';
import type { StoryKit } from '../../../packages/content/src/story.ts';
import { type CampaignConfig, type ConfigIssue, generateCampaignConfig } from '../../../packages/intent/src/config.ts';
import {
  type CampaignIntent,
  type CapabilityMode,
  createCampaignIntent,
  type IntentIssue,
  type Provenance,
  parseCampaignIntent,
} from '../../../packages/intent/src/intent.ts';
import { MAX_INTENT_TEXT_LENGTH, proposeCampaignIntent } from '../../../packages/intent/src/parser.ts';
import { matchGenre, type Registry } from '../../../packages/intent/src/registry.ts';
import {
  type RulesetCandidate,
  type RulesetResolution,
  resolveRuleset,
} from '../../../packages/intent/src/resolver.ts';
import { type BuildInput, buildCharacter } from '../../../packages/rules/src/character-builder.ts';
import { D20_LITE_CREATION } from '../../../packages/rules/src/d20-lite.ts';
import { DICE_POOL_LITE_CREATION } from '../../../packages/rules/src/dice-pool-lite.ts';
import { NARRATIVE_CREATION } from '../../../packages/rules/src/narrative.ts';
import { describedBuild } from './character-creation.ts';
import { BUILT_IN_PACKS } from './import-gateway.ts';

export const CREATION_RULES = [D20_LITE_CREATION, DICE_POOL_LITE_CREATION, NARRATIVE_CREATION];
const GENRE_PACKS: readonly {
  genre: Pick<GenrePack, 'id' | 'version' | 'name' | 'examples' | 'archetypes'>;
  story?: StoryKit;
}[] = [FANTASY_PACK, SCIENCE_FICTION_PACK, HORROR_PACK, MYSTERY_PACK, MODERN_ADVENTURE_PACK, BLANK_WORLD_PACK];
const GENRE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  [MYSTERY_PACK.genre.id]: ['mystery'],
  [MODERN_ADVENTURE_PACK.genre.id]: ['modern'],
  [BLANK_WORLD_PACK.genre.id]: ['blank'],
};
const REGISTRY: Registry = {
  rulepacks: BUILT_IN_PACKS,
  genres: GENRE_PACKS.map(({ genre }) => ({
    id: genre.id,
    version: genre.version,
    name: genre.name,
    aliases: [...(GENRE_ALIASES[genre.id] ?? [])],
  })),
};
const NONE = 'none';
const IMPORT_HINT = 'Run rpg import <file> to add its rule files, or name an installed ruleset.';
const CHOSEN: Provenance = 'explicit';
const DEFAULT: Provenance = 'default';
const DICE_LABELS: Record<CapabilityMode, string> = { rulepack: 'as the ruleset decides', on: 'on', off: 'off' };
const SWITCH_LABELS = { true: 'on', false: 'off' } as const;
const PLAN_FIELDS = [
  'ruleset',
  'genre',
  'character',
  'dice',
  'diceVisualization',
  'voiceOutput',
  'simulation',
] as const;
const LIGHT_RULES = 'Light rules. The GM decides what happens from your story.';
const LIST = new Intl.ListFormat('en', { type: 'conjunction' });

export class UnknownEdition extends Error {}

const listed = (items: readonly string[]) => (items.length === 0 ? NONE : items.join(', '));
const rulesets = (candidates: readonly RulesetCandidate[]) =>
  listed(candidates.map(({ id, edition }) => `${id} ${edition}`));

const rulesetError = (resolution: Exclude<RulesetResolution, { status: 'resolved' }>) => {
  const { id, edition } = resolution.requested;
  const requested = edition === null ? id : `${id} ${edition}`;
  if (resolution.status === 'ambiguous')
    return `Ruleset ${requested} matches more than one installed ruleset: ${rulesets(resolution.candidates)}. Name one of them.`;
  return `Ruleset ${requested} is not installed. Installed rulesets: ${rulesets(resolution.available)}. ${IMPORT_HINT}`;
};

const issueLine = ({ code, path }: ConfigIssue | IntentIssue) => `${path} ${code.replaceAll('_', ' ')}.`;

const issueText = (intent: CampaignIntent, issue: ConfigIssue) =>
  issue.path === 'genre' && issue.code === 'not_installed'
    ? `Genre ${intent.genre.value} is not installed. Installed genres: ${listed(REGISTRY.genres.map(({ id }) => id))}.`
    : issueLine(issue);

const canonicalGenre = (intent: CampaignIntent): CampaignIntent => {
  if (intent.genre.value === null) return intent;
  const match = matchGenre(REGISTRY, { id: intent.genre.value, version: null });
  return match.ok ? { ...intent, genre: { value: match.genre.id, provenance: intent.genre.provenance } } : intent;
};

const intentFrom = (text: string): CampaignIntent => {
  const proposed = proposeCampaignIntent(text);
  if (!proposed.ok) throw new Error(`Campaign intent must be at most ${MAX_INTENT_TEXT_LENGTH} characters.`);
  const { conflicts, input } = proposed.proposal;
  if (conflicts.length > 0)
    throw new Error(`Your intent gives conflicting choices for ${listed(conflicts.map(({ field }) => field))}.`);
  return resolvedIntent(createCampaignIntent(input));
};

const resolvedIntent = (choices: CampaignIntent): CampaignIntent => {
  const intent = canonicalGenre(choices);
  if (intent.ruleset.value === null) return intent;
  const resolution = resolveRuleset(REGISTRY, intent.ruleset.value);
  if (resolution.status !== 'resolved') throw new UnknownEdition(rulesetError(resolution));
  const { id, edition } = resolution.rulepack;
  return { ...intent, ruleset: { value: { id, edition }, provenance: intent.ruleset.provenance } };
};

const configFor = (intent: CampaignIntent): CampaignConfig => {
  const result = generateCampaignConfig(intent, REGISTRY);
  if (!result.ok) throw new Error(result.issues.map((issue) => issueText(intent, issue)).join('\n'));
  return result.config;
};

export const planCampaign = (text?: string): CampaignConfig =>
  configFor(text === undefined ? createCampaignIntent({}) : intentFrom(text));

export const planCampaignFrom = (choices: Readonly<Record<string, unknown>>): CampaignConfig => {
  const chosen = Object.entries(choices).map(([field, value]) => [field, { value, provenance: CHOSEN }]);
  const parsed = parseCampaignIntent(Object.fromEntries(chosen));
  if (!parsed.ok) throw new Error(parsed.issues.map(issueLine).join('\n'));
  return configFor(resolvedIntent(parsed.intent));
};

export type Opening = { title: string; narration: string };

export const openingFor = ({ genre }: CampaignConfig, fallback: Opening): Opening => {
  const pack = GENRE_PACKS.find((candidate) => candidate.genre.id === genre?.id);
  const scene = pack?.story?.openingScenes[0];
  return pack === undefined || scene === undefined ? fallback : { title: pack.genre.name, narration: `${scene}.` };
};

export const describeConfig = ({ rulepack, genre, values, provenance }: CampaignConfig): string =>
  [
    `Ruleset: ${rulepack === null ? NONE : `${rulepack.id} ${rulepack.edition}`} (${provenance.ruleset})`,
    `Genre: ${genre === null ? NONE : `${genre.id} ${genre.version}`} (${provenance.genre})`,
    `Dice: ${DICE_LABELS[values.dice]} (${provenance.dice})`,
  ].join('\n');

const featuresOf = ({ capabilities }: (typeof BUILT_IN_PACKS)[number]) =>
  Object.entries(capabilities)
    .filter(([, mode]) => mode === true)
    .map(([feature]) => feature);

const sheetOf = ({ id, edition }: (typeof BUILT_IN_PACKS)[number]) =>
  (
    CREATION_RULES.find(({ schema: { rulepack } }) => rulepack.id === id && rulepack.edition === edition)?.schema
      .fields ?? []
  )
    .filter(({ derived }) => derived === undefined)
    .map(({ id: field, label }) => label ?? field);

const readyMadeOn = (pack: (typeof BUILT_IN_PACKS)[number]) => {
  const rules = creationRulesFor(pack);
  return (
    rules === undefined ||
    GENRE_PACKS.every(({ genre }) =>
      genre.archetypes.every(({ name }) => buildCharacter(describedBuild(rules, name)).status === 'created'),
    )
  );
};

export const startOptions = (): StartOptions => {
  const lightest = Math.min(...BUILT_IN_PACKS.map((pack) => featuresOf(pack).length));
  return {
    genres: GENRE_PACKS.map(({ genre }) => ({
      id: genre.id,
      name: genre.name,
      blurb: genre.examples[0] ?? genre.name,
      characters: genre.archetypes.map(({ name, summary }) => ({ name, summary })),
    })),
    rulesets: BUILT_IN_PACKS.map((pack) => {
      const features = featuresOf(pack);
      return {
        id: pack.id,
        edition: pack.edition,
        blurb: features.length === 0 ? LIGHT_RULES : `Rules for ${LIST.format(features)}.`,
        recommended: features.length === lightest,
        readyMade: readyMadeOn(pack),
        sheet: sheetOf(pack),
      };
    }),
  };
};

const planValue = ({ rulepack, genre, values }: CampaignConfig, field: (typeof PLAN_FIELDS)[number]) => {
  if (field === 'ruleset') return rulepack === null ? NONE : `${rulepack.id} ${rulepack.edition}`;
  if (field === 'genre') return genre?.id ?? NONE;
  if (field === 'dice') return DICE_LABELS[values.dice];
  const value = values[field];
  return typeof value === 'boolean' ? SWITCH_LABELS[`${value}`] : (value ?? NONE);
};

export const creationRulesFor = (rulepack: CampaignConfig['rulepack']) =>
  CREATION_RULES.find(
    ({ schema: { rulepack: pack } }) =>
      pack.id === rulepack?.id && pack.edition === rulepack.edition && pack.revision === rulepack.revision,
  );

export const startingCharacter = ({ rulepack, values: { character } }: CampaignConfig): BuildInput | undefined => {
  const rules = creationRulesFor(rulepack);
  if (typeof character !== 'string' || rules === undefined) return undefined;
  const build = describedBuild(rules, character);
  const result = buildCharacter(build);
  if (result.status === 'created') return build;
  if (result.status === 'pending')
    throw new Error(
      `Your character needs ${LIST.format(result.questions.map(({ label, fieldId }) => label ?? fieldId))}. Add them to your description, or skip this step.`,
    );
  throw new Error(`Your character does not fit the rules: ${result.issues.map(({ message }) => message).join('; ')}.`);
};

export const planStart = ({ intent, choices }: PlanCampaign): CampaignPlan => {
  const config = choices === undefined ? planCampaign(intent) : planCampaignFrom(choices);
  const character = startingCharacter(config);
  const entries: PlanEntry[] = PLAN_FIELDS.map((field) =>
    field === 'character'
      ? {
          field,
          value: character?.proposal.name ?? NONE,
          provenance: character === undefined ? DEFAULT : config.provenance.character,
        }
      : { field, value: planValue(config, field), provenance: config.provenance[field] },
  );
  return { version: PROTOCOL_VERSION, options: startOptions(), entries };
};

export const failureOf = (error: unknown) =>
  failure(
    error instanceof UnknownEdition ? 'UnknownEdition' : 'Rejected',
    error instanceof Error ? error.message : String(error),
  );

export const planResult = (command: PlanCampaign): Result<CampaignPlan> => {
  try {
    return { ok: true, value: planStart(command) };
  } catch (error) {
    return failureOf(error);
  }
};
