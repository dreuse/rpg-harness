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
import { DEFAULT_RULES_USAGE, usesDice } from '../../../packages/domain/src/rules-usage.ts';
import { type CampaignConfig, type ConfigIssue, generateCampaignConfig } from '../../../packages/intent/src/config.ts';
import {
  CLIENT_CAPABILITIES,
  detectConflicts,
  type IntentConflict,
  MECHANICAL_FIELDS,
  UI_REQUIREMENTS,
} from '../../../packages/intent/src/conflicts.ts';
import {
  type CampaignIntent,
  type CampaignIntentInput,
  type CapabilityMode,
  CLIENTS,
  type Client,
  type IntentField,
  type IntentIssue,
  type Provenance,
  parseCampaignIntent,
} from '../../../packages/intent/src/intent.ts';
import { MAX_INTENT_TEXT_LENGTH, proposeCampaignIntent } from '../../../packages/intent/src/parser.ts';
import {
  type CapabilityReport,
  matchGenre,
  matchRuleset,
  type Registry,
} from '../../../packages/intent/src/registry.ts';
import {
  type RulesetCandidate,
  type RulesetResolution,
  resolveRuleset,
} from '../../../packages/intent/src/resolver.ts';
import { type BuildInput, buildCharacter } from '../../../packages/rules/src/character-builder.ts';
import { D20_LITE_CREATION } from '../../../packages/rules/src/d20-lite.ts';
import { DICE_POOL_LITE_CREATION } from '../../../packages/rules/src/dice-pool-lite.ts';
import { NARRATIVE_CREATION } from '../../../packages/rules/src/narrative.ts';
import { rulesUsageOf } from '../../../packages/rules/src/rulepack.ts';
import { describedBuild } from './character-creation.ts';
import { BUILT_IN_PACKS } from './import-gateway.ts';

export const CREATION_RULES = [D20_LITE_CREATION, DICE_POOL_LITE_CREATION, NARRATIVE_CREATION];
const GENRE_PACKS: readonly {
  genre: Pick<GenrePack, 'id' | 'version' | 'name' | 'examples' | 'archetypes' | 'style'>;
  story?: StoryKit;
}[] = [FANTASY_PACK, SCIENCE_FICTION_PACK, HORROR_PACK, MYSTERY_PACK, MODERN_ADVENTURE_PACK, BLANK_WORLD_PACK];
const GENRE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  [FANTASY_PACK.genre.id]: ['fantasia'],
  [SCIENCE_FICTION_PACK.genre.id]: ['ficção científica'],
  [HORROR_PACK.genre.id]: ['terror'],
  [MYSTERY_PACK.genre.id]: ['mystery', 'mistério'],
  [MODERN_ADVENTURE_PACK.genre.id]: ['modern', 'moderna'],
  [BLANK_WORLD_PACK.genre.id]: ['blank', 'mundo em branco'],
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
const DICELESS_SHEETLESS = 'No dice and no character sheet. The GM decides what happens from your story.';
const DICE_FIELDS: readonly (typeof PLAN_FIELDS)[number][] = ['dice', 'diceVisualization'];
const LIST = new Intl.ListFormat('en', { type: 'conjunction' });
const ALTERNATIVES = new Intl.ListFormat('en', { type: 'disjunction' });
const CONFLICT = 'conflict';
const REQUIRES_DICE = 'requires_dice';
const CLIENT_UNSUPPORTED = 'client_unsupported';
const NEEDS_DICE = 'diceVisualization needs a ruleset with dice.';
const NO_MECHANICS: CapabilityReport = { advertised: [], supported: [], unsupported: [...MECHANICAL_FIELDS] };

type Choices = Readonly<Record<string, unknown>>;

export class UnknownEdition extends Error {}

export class ClientUnsupported extends Error {
  readonly client: Client;
  constructor(message: string, client: Client) {
    super(message);
    this.client = client;
  }
}

const supports = (client: Client, field: IntentField) =>
  UI_REQUIREMENTS.some(
    ([required, capability]) => required === field && CLIENT_CAPABILITIES[client].includes(capability),
  );

const reportFor = ({ ruleset }: CampaignIntent): CapabilityReport => {
  const rules = ruleset.value === null ? null : matchRuleset(REGISTRY, ruleset.value, MECHANICAL_FIELDS);
  return rules?.ok === true ? rules.capabilities : NO_MECHANICS;
};

const conflictText = ({ code, entries: [entry] }: IntentConflict) =>
  code === REQUIRES_DICE ? NEEDS_DICE : issueLine({ code: CONFLICT, path: entry?.field ?? '' });

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

const chosenIntent = (choices: Choices, derived: CampaignIntentInput = {}): CampaignIntent => {
  const chosen = Object.entries(choices).map(([field, value]) => [field, { value, provenance: CHOSEN }]);
  const parsed = parseCampaignIntent({ ...derived, ...Object.fromEntries(chosen) });
  if (!parsed.ok) throw new Error(parsed.issues.map(issueLine).join('\n'));
  return resolvedIntent(parsed.intent);
};

const intentFrom = (text: string, choices: Choices): CampaignIntent => {
  const proposed = proposeCampaignIntent(text);
  if (!proposed.ok) throw new Error(`Campaign intent must be at most ${MAX_INTENT_TEXT_LENGTH} characters.`);
  const { conflicts, input } = proposed.proposal;
  if (conflicts.length > 0)
    throw new Error(`Your intent gives conflicting choices for ${listed(conflicts.map(({ field }) => field))}.`);
  return chosenIntent(choices, input);
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
  if (result.ok) return result.config;
  const conflicts = result.issues.some(({ code }) => code === CONFLICT)
    ? detectConflicts(intent, reportFor(intent))
    : [];
  const unsupported = conflicts.flatMap(({ code, entries: [entry] }) =>
    code === CLIENT_UNSUPPORTED && entry !== undefined ? [entry.field] : [],
  );
  const lines = [
    ...result.issues.filter(({ code }) => code !== CONFLICT).map((issue) => issueText(intent, issue)),
    ...conflicts.filter(({ code }) => code !== CLIENT_UNSUPPORTED).map(conflictText),
  ];
  const clients = CLIENTS.filter((client) => unsupported.every((field) => supports(client, field)));
  const [client] = clients;
  if (unsupported.length === 0 || client === undefined) throw new Error(lines.join('\n'));
  const advice = `Use the ${ALTERNATIVES.format(clients)} client for ${LIST.format(unsupported)}.`;
  throw new ClientUnsupported([...lines, advice].join('\n'), client);
};

export const planCampaign = (text?: string, choices: Choices = {}): CampaignConfig =>
  configFor(text === undefined ? chosenIntent(choices) : intentFrom(text, choices));

const MAX_TITLE_WORDS = 4;
const MAX_TITLE_LENGTH = 40;
const WORD_SEPARATOR = /\s+/;

export const isPitch = (text: string) =>
  text.trim().split(WORD_SEPARATOR).length > MAX_TITLE_WORDS || text.trim().length > MAX_TITLE_LENGTH;

export const titleOf = (pitch: string) =>
  pitch.trim().split(WORD_SEPARATOR).slice(0, MAX_TITLE_WORDS).join(' ').slice(0, MAX_TITLE_LENGTH).trim();

export type Opening = { title: string; narration: string };

export const openingFor = ({ genre }: CampaignConfig, fallback: Opening): Opening => {
  const pack = GENRE_PACKS.find((candidate) => candidate.genre.id === genre?.id);
  const scene = pack?.story?.openingScenes[0];
  return pack === undefined || scene === undefined ? fallback : { title: pack.genre.name, narration: `${scene}.` };
};

const styleLine = (source: string, id: string, style: unknown) =>
  style === undefined ? [] : [`${source} ${id} style: ${JSON.stringify(style)}`];

export const styleLinesOf = ({ rulepack, genre }: CampaignConfig): string[] => [
  ...styleLine(
    'rulepack',
    rulepack?.id ?? '',
    BUILT_IN_PACKS.find(
      ({ id, edition, revision }) =>
        id === rulepack?.id && edition === rulepack.edition && revision === rulepack.revision,
    )?.style,
  ),
  ...styleLine(
    'genre',
    genre?.id ?? '',
    GENRE_PACKS.find((candidate) => candidate.genre.id === genre?.id)?.genre.style,
  ),
];

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

const blurbOf = (pack: (typeof BUILT_IN_PACKS)[number], features: readonly string[]) => {
  const { resolution, sheet } = rulesUsageOf(pack);
  if (resolution !== 'dice' && sheet === 'none') return DICELESS_SHEETLESS;
  return features.length === 0 ? LIGHT_RULES : `Rules for ${LIST.format(features)}.`;
};

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
        blurb: blurbOf(pack, features),
        recommended: features.length === lightest,
        readyMade: readyMadeOn(pack),
        sheet: sheetOf(pack),
        usage: rulesUsageOf(pack),
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

export const commandConfig = (
  { intent, choices }: Pick<PlanCampaign, 'intent' | 'choices'>,
  client?: string,
): CampaignConfig => planCampaign(intent, client === undefined ? choices : { ...choices, client });

export const usageFor = (rulepack: CampaignConfig['rulepack']) => {
  const pack = BUILT_IN_PACKS.find(
    ({ id, edition, revision }) =>
      id === rulepack?.id && edition === rulepack.edition && revision === rulepack.revision,
  );
  return pack === undefined ? DEFAULT_RULES_USAGE : rulesUsageOf(pack);
};

export const planStart = (command: PlanCampaign, client?: string): CampaignPlan => {
  const config = commandConfig(command, client);
  const character = startingCharacter(config);
  const diceless = !usesDice(usageFor(config.rulepack));
  const entries: PlanEntry[] = PLAN_FIELDS.filter((field) => !(diceless && DICE_FIELDS.includes(field))).map((field) =>
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

export const planResult = (command: PlanCampaign, client?: string): Result<CampaignPlan> => {
  try {
    return { ok: true, value: planStart(command, client) };
  } catch (error) {
    return failureOf(error);
  }
};
