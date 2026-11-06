import { type ContentKind, contentText } from '../../../packages/client-protocol/src/content-names.ts';
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
import { type RulePackManifest, rulesUsageOf } from '../../../packages/rules/src/rulepack.ts';
import { describedBuild } from './character-creation.ts';
import { BUILT_IN_PACKS } from './import-gateway.ts';
import { installedRulesets } from './installed-rulesets.ts';
import { DEFAULT_LOCALE, errorText, ListParam, LocalizedError, say } from './messages.ts';

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
const GENRE_REGISTRY: Registry['genres'] = GENRE_PACKS.map(({ genre }) => ({
  id: genre.id,
  version: genre.version,
  name: genre.name,
  aliases: [...(GENRE_ALIASES[genre.id] ?? [])],
}));
const registryOf = (packs: Packs): Registry => ({ rulepacks: packs, genres: GENRE_REGISTRY });
const NONE = 'none';
const DICE_KEYS: Record<CapabilityMode, string> = {
  rulepack: 'config.dice.rulepack',
  on: 'config.dice.on',
  off: 'config.dice.off',
};
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
const CONFLICT = 'conflict';
const REQUIRES_DICE = 'requires_dice';
const CLIENT_UNSUPPORTED = 'client_unsupported';
const NO_MECHANICS: CapabilityReport = { advertised: [], supported: [], unsupported: [...MECHANICAL_FIELDS] };

type Choices = Readonly<Record<string, unknown>>;
type Packs = readonly RulePackManifest[];

export const packsIn = (dataDir: string): Packs => [...BUILT_IN_PACKS, ...installedRulesets(dataDir)];

export class UnknownEdition extends LocalizedError {}

export class ClientUnsupported extends LocalizedError {
  readonly client: Client;
  constructor(lines: readonly (string | LocalizedError)[], client: Client) {
    super('quickstart.lines', { lines });
    this.client = client;
  }
}

const supports = (client: Client, field: IntentField) =>
  UI_REQUIREMENTS.some(
    ([required, capability]) => required === field && CLIENT_CAPABILITIES[client].includes(capability),
  );

const reportFor = ({ ruleset }: CampaignIntent, registry: Registry): CapabilityReport => {
  const rules = ruleset.value === null ? null : matchRuleset(registry, ruleset.value, MECHANICAL_FIELDS);
  return rules?.ok === true ? rules.capabilities : NO_MECHANICS;
};

const conflictText = ({ code, entries: [entry] }: IntentConflict) =>
  code === REQUIRES_DICE
    ? new LocalizedError('quickstart.needsDice')
    : issueLine({ code: CONFLICT, path: entry?.field ?? '' });

const listed = (items: readonly string[], kind?: ContentKind) => new ListParam(items, 'plain', kind);
const rulesets = (candidates: readonly RulesetCandidate[]) =>
  listed(candidates.map(({ id, edition }) => `${id} ${edition}`));

const rulesetError = (resolution: Exclude<RulesetResolution, { status: 'resolved' }>) => {
  const { id, edition } = resolution.requested;
  const requested = edition === null ? id : `${id} ${edition}`;
  if (resolution.status === 'ambiguous')
    return new UnknownEdition('quickstart.rulesetAmbiguous', {
      requested,
      candidates: rulesets(resolution.candidates),
    });
  return new UnknownEdition('quickstart.rulesetMissing', {
    requested,
    available: rulesets(resolution.available),
    hint: new LocalizedError('quickstart.importHint'),
  });
};

const issueLine = ({ code, path }: ConfigIssue | IntentIssue) => `${path} ${code.replaceAll('_', ' ')}.`;

const issueText = (intent: CampaignIntent, issue: ConfigIssue) =>
  issue.path === 'genre' && issue.code === 'not_installed'
    ? new LocalizedError('quickstart.genreMissing', {
        genre: intent.genre.value,
        available: listed(GENRE_REGISTRY.map(({ id }) => id)),
      })
    : issueLine(issue);

const canonicalGenre = (registry: Registry, intent: CampaignIntent): CampaignIntent => {
  if (intent.genre.value === null) return intent;
  const match = matchGenre(registry, { id: intent.genre.value, version: null });
  return match.ok ? { ...intent, genre: { value: match.genre.id, provenance: intent.genre.provenance } } : intent;
};

const chosenIntent = (registry: Registry, choices: Choices, derived: CampaignIntentInput = {}): CampaignIntent => {
  const chosen = Object.entries(choices).map(([field, value]) => [field, { value, provenance: CHOSEN }]);
  const parsed = parseCampaignIntent({ ...derived, ...Object.fromEntries(chosen) });
  if (!parsed.ok) throw new LocalizedError('quickstart.lines', { lines: parsed.issues.map(issueLine) });
  return resolvedIntent(registry, parsed.intent);
};

const intentFrom = (registry: Registry, text: string, choices: Choices): CampaignIntent => {
  const proposed = proposeCampaignIntent(text);
  if (!proposed.ok) throw new LocalizedError('quickstart.intentTooLong', { max: MAX_INTENT_TEXT_LENGTH });
  const { conflicts, input } = proposed.proposal;
  if (conflicts.length > 0)
    throw new LocalizedError('quickstart.intentConflict', { fields: listed(conflicts.map(({ field }) => field)) });
  return chosenIntent(registry, choices, input);
};

const resolvedIntent = (registry: Registry, choices: CampaignIntent): CampaignIntent => {
  const intent = canonicalGenre(registry, choices);
  if (intent.ruleset.value === null) return intent;
  const resolution = resolveRuleset(registry, intent.ruleset.value);
  if (resolution.status !== 'resolved') throw rulesetError(resolution);
  const { id, edition } = resolution.rulepack;
  return { ...intent, ruleset: { value: { id, edition }, provenance: intent.ruleset.provenance } };
};

const configFor = (registry: Registry, intent: CampaignIntent): CampaignConfig => {
  const result = generateCampaignConfig(intent, registry);
  if (result.ok) return result.config;
  const conflicts = result.issues.some(({ code }) => code === CONFLICT)
    ? detectConflicts(intent, reportFor(intent, registry))
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
  if (unsupported.length === 0 || client === undefined) throw new LocalizedError('quickstart.lines', { lines });
  const advice = new LocalizedError('quickstart.useClient', {
    clients: new ListParam(clients, 'disjunction'),
    fields: new ListParam(unsupported, 'conjunction'),
  });
  throw new ClientUnsupported([...lines, advice], client);
};

export const planCampaign = (text?: string, choices: Choices = {}, packs: Packs = BUILT_IN_PACKS): CampaignConfig => {
  const registry = registryOf(packs);
  return configFor(
    registry,
    text === undefined ? chosenIntent(registry, choices) : intentFrom(registry, text, choices),
  );
};

const MAX_TITLE_WORDS = 4;
const MAX_TITLE_LENGTH = 40;
const WORD_SEPARATOR = /\s+/;

export const isPitch = (text: string) =>
  text.trim().split(WORD_SEPARATOR).length > MAX_TITLE_WORDS || text.trim().length > MAX_TITLE_LENGTH;

export const titleOf = (pitch: string) =>
  pitch.trim().split(WORD_SEPARATOR).slice(0, MAX_TITLE_WORDS).join(' ').slice(0, MAX_TITLE_LENGTH).trim();

export type Opening = {
  title: string;
  narration: string;
  locationKind?: string;
  moodTags?: readonly string[];
};

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

export const describeConfig = (
  { rulepack, genre, values, provenance }: CampaignConfig,
  locale = DEFAULT_LOCALE,
): string => {
  const none = say(locale, 'quickstart.none');
  const how = (field: string) => say(locale, `provenance.${field}`);
  return [
    say(locale, 'config.ruleset', {
      value: rulepack === null ? none : `${rulepack.id} ${rulepack.edition}`,
      provenance: how(provenance.ruleset),
    }),
    say(locale, 'config.genre', {
      value: genre === null ? none : `${contentText(locale, 'genre', genre.id, genre.id)} ${genre.version}`,
      provenance: how(provenance.genre),
    }),
    say(locale, 'config.dice', { value: say(locale, DICE_KEYS[values.dice]), provenance: how(provenance.dice) }),
  ].join('\n');
};

const featuresOf = ({ capabilities }: RulePackManifest) =>
  Object.entries(capabilities)
    .filter(([, mode]) => mode === true)
    .map(([feature]) => feature);

const sheetOf = ({ id, edition }: RulePackManifest) =>
  (
    CREATION_RULES.find(({ schema: { rulepack } }) => rulepack.id === id && rulepack.edition === edition)?.schema
      .fields ?? []
  )
    .filter(({ derived }) => derived === undefined)
    .map(({ id: field, label }) => label ?? field);

const blurbOf = (pack: RulePackManifest, features: readonly string[]) => {
  const { resolution, sheet } = rulesUsageOf(pack);
  if (resolution !== 'dice' && sheet === 'none') return DICELESS_SHEETLESS;
  return features.length === 0 ? LIGHT_RULES : `Rules for ${LIST.format(features)}.`;
};

const readyMadeOn = (pack: RulePackManifest) => {
  const rules = creationRulesFor(pack);
  return (
    rules === undefined ||
    GENRE_PACKS.every(({ genre }) =>
      genre.archetypes.every(({ name }) => buildCharacter(describedBuild(rules, name)).status === 'created'),
    )
  );
};

export const startOptions = (packs: Packs = BUILT_IN_PACKS): StartOptions => {
  const lightest = Math.min(...BUILT_IN_PACKS.map((pack) => featuresOf(pack).length));
  return {
    genres: GENRE_PACKS.map(({ genre }) => ({
      id: genre.id,
      name: genre.name,
      blurb: genre.examples[0] ?? genre.name,
      characters: genre.archetypes.map(({ name, summary }) => ({ name, summary })),
    })),
    rulesets: packs.map((pack) => {
      const features = featuresOf(pack);
      return {
        id: pack.id,
        edition: pack.edition,
        blurb: blurbOf(pack, features),
        recommended: BUILT_IN_PACKS.includes(pack) && features.length === lightest,
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
    throw new LocalizedError('quickstart.characterNeeds', {
      fields: new ListParam(
        result.questions.map(({ label, fieldId }) => label ?? fieldId),
        'conjunction',
        'stat',
      ),
    });
  throw new LocalizedError('quickstart.characterInvalid', {
    issues: result.issues.map(({ message }) => message).join('; '),
  });
};

export const commandConfig = (
  { intent, choices }: Pick<PlanCampaign, 'intent' | 'choices'>,
  client?: string,
  packs: Packs = BUILT_IN_PACKS,
): CampaignConfig => planCampaign(intent, client === undefined ? choices : { ...choices, client }, packs);

export const usageFor = (rulepack: CampaignConfig['rulepack'], packs: Packs = BUILT_IN_PACKS) => {
  const pack = packs.find(
    ({ id, edition, revision }) =>
      id === rulepack?.id && edition === rulepack.edition && revision === rulepack.revision,
  );
  return pack === undefined ? DEFAULT_RULES_USAGE : rulesUsageOf(pack);
};

export const planStart = (command: PlanCampaign, client?: string, packs: Packs = BUILT_IN_PACKS): CampaignPlan => {
  const config = commandConfig(command, client, packs);
  const character = startingCharacter(config);
  const diceless = !usesDice(usageFor(config.rulepack, packs));
  const entries: PlanEntry[] = PLAN_FIELDS.filter((field) => !(diceless && DICE_FIELDS.includes(field))).map((field) =>
    field === 'character'
      ? {
          field,
          value: character?.proposal.name ?? NONE,
          provenance: character === undefined ? DEFAULT : config.provenance.character,
        }
      : { field, value: planValue(config, field), provenance: config.provenance[field] },
  );
  return { version: PROTOCOL_VERSION, options: startOptions(packs), entries };
};

export const failureOf = (error: unknown, locale = DEFAULT_LOCALE) =>
  failure(error instanceof UnknownEdition ? 'UnknownEdition' : 'Rejected', errorText(locale, error));

export const planResult = (
  command: PlanCampaign,
  client?: string,
  locale = DEFAULT_LOCALE,
  packs: Packs = BUILT_IN_PACKS,
): Result<CampaignPlan> => {
  try {
    return { ok: true, value: planStart(command, client, packs) };
  } catch (error) {
    return failureOf(error, locale);
  }
};
