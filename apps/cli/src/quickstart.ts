import { type ContentKind, contentAliases, contentText } from '../../../packages/client-protocol/src/content-names.ts';
import { DICE_LABELS } from '../../../packages/client-protocol/src/guided-start.ts';
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
import type { RulesDocument } from '../../../packages/engine/src/own-rules.ts';
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
import { type BuilderIssue, type BuildInput, buildCharacter } from '../../../packages/rules/src/character-builder.ts';
import { D20_LITE_CREATION } from '../../../packages/rules/src/d20-lite.ts';
import { DICE_POOL_LITE_CREATION } from '../../../packages/rules/src/dice-pool-lite.ts';
import { NARRATIVE_CREATION } from '../../../packages/rules/src/narrative.ts';
import { type RulePackManifest, rulesUsageOf } from '../../../packages/rules/src/rulepack.ts';
import { describedBuild, premadeBuild } from './character-creation.ts';
import { BUILT_IN_PACKS } from './import-gateway.ts';
import { baseIdOf, type InstalledRuleset, installedRulesets } from './installed-rulesets.ts';
import { DEFAULT_LOCALE, errorText, ListParam, LocalizedError, say } from './messages.ts';

export const CREATION_RULES = [D20_LITE_CREATION, DICE_POOL_LITE_CREATION, NARRATIVE_CREATION];
const GENRE_PACKS: readonly {
  genre: Pick<GenrePack, 'id' | 'version' | 'name' | 'examples' | 'archetypes' | 'style'>;
  story?: StoryKit;
}[] = [FANTASY_PACK, SCIENCE_FICTION_PACK, HORROR_PACK, MYSTERY_PACK, MODERN_ADVENTURE_PACK, BLANK_WORLD_PACK];
const isBuiltInGenre = ({ id, version }: { id: string; version: string }) =>
  GENRE_PACKS.some(({ genre }) => genre.id === id && genre.version === version);
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
const FALLBACK = 'fallback';
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
export type Packs = readonly RulePackManifest[];

export const packsIn = (dataDir: string): Packs => [...BUILT_IN_PACKS, ...installedRulesets(dataDir)];

export const packsWith = (load?: () => InstalledRuleset | undefined): Packs => {
  try {
    const installed = load?.();
    return installed === undefined ? BUILT_IN_PACKS : [...BUILT_IN_PACKS, installed.manifest];
  } catch {
    return BUILT_IN_PACKS;
  }
};

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

type Words = Partial<Record<IntentField, string>>;
const NO_WORDS: Words = {};
const NAMED_FIELDS: readonly string[] = [...MECHANICAL_FIELDS, ...UI_REQUIREMENTS.map(([field]) => field)];
const wordsOf = (words: Words, field: string) =>
  words[field as IntentField] ??
  (NAMED_FIELDS.includes(field) ? new LocalizedError(`quickstart.field.${field}`) : field);

const conflictText = ({ code, entries: [entry] }: IntentConflict, words: Words) =>
  new LocalizedError(code === REQUIRES_DICE ? 'quickstart.needsDice' : 'quickstart.unsupported', {
    words: wordsOf(words, entry?.field ?? ''),
  });

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

const issueLine = ({ code, path }: ConfigIssue | IntentIssue, words: Words = NO_WORDS) =>
  new LocalizedError('quickstart.issue', {
    words: wordsOf(words, path),
    reason: new LocalizedError(`quickstart.code.${code}`),
  });

const issueText = (intent: CampaignIntent, issue: ConfigIssue, words: Words) =>
  issue.path === 'genre' && issue.code === 'not_installed'
    ? new LocalizedError('quickstart.genreMissing', {
        genre: intent.genre.value,
        available: listed(GENRE_REGISTRY.map(({ id }) => id)),
      })
    : issueLine(issue, words);

const canonicalGenre = (registry: Registry, intent: CampaignIntent): CampaignIntent => {
  if (intent.genre.value === null) return intent;
  const match = matchGenre(registry, { id: intent.genre.value, version: null });
  return match.ok ? { ...intent, genre: { value: match.genre.id, provenance: intent.genre.provenance } } : intent;
};

const chosenIntent = (registry: Registry, choices: Choices, derived: CampaignIntentInput = {}): CampaignIntent => {
  const chosen = Object.entries(choices).map(([field, value]) => [field, { value, provenance: CHOSEN }]);
  const parsed = parseCampaignIntent({ ...derived, ...Object.fromEntries(chosen) });
  if (!parsed.ok)
    throw new LocalizedError('quickstart.lines', { lines: parsed.issues.map((issue) => issueLine(issue)) });
  return resolvedIntent(registry, parsed.intent);
};

const BLANK_WORLD_ID = BLANK_WORLD_PACK.genre.id;
const DERIVED: Provenance = 'derived';

const unmatchedGenre = (registry: Registry, { genre }: CampaignIntentInput) => {
  const phrase = genre?.value;
  return typeof phrase === 'string' && matchGenre(registry, { id: phrase, version: null }).ok === false
    ? phrase
    : undefined;
};

const mechanicalRuleset = (registry: Registry, input: CampaignIntentInput): CampaignIntentInput => {
  const wanted = MECHANICAL_FIELDS.filter((field) => input[field]?.value === 'on');
  if (input.ruleset?.value != null || wanted.length === 0) return input;
  for (const { id, edition } of registry.rulepacks) {
    const match = matchRuleset(registry, { id, edition }, MECHANICAL_FIELDS);
    if (match.ok && wanted.every((field) => match.capabilities.advertised.includes(field)))
      return { ...input, ruleset: { value: { id, edition }, provenance: DERIVED } };
  }
  return input;
};

const conflictLine = (candidates: readonly { value: unknown; evidence: { text: string } }[]) => {
  const [first] = candidates;
  const opposite = candidates.every(({ value }) => typeof value === 'boolean');
  return opposite
    ? new LocalizedError('quickstart.intentPolarity', { words: first?.evidence.text })
    : new LocalizedError('quickstart.intentConflict', {
        words: new ListParam([...new Set(candidates.map(({ evidence }) => evidence.text))], 'conjunction'),
      });
};

const intentFrom = (registry: Registry, text: string, choices: Choices) => {
  const proposed = proposeCampaignIntent(text);
  if (!proposed.ok) throw new LocalizedError('quickstart.intentTooLong', { max: MAX_INTENT_TEXT_LENGTH });
  const { conflicts, input, settings } = proposed.proposal;
  const words: Words = Object.fromEntries(settings.map(({ field, evidence }) => [field, evidence.text]));
  if (conflicts.length > 0)
    throw new LocalizedError('quickstart.lines', {
      lines: conflicts.map(({ candidates }) => conflictLine(candidates)),
    });
  const known =
    unmatchedGenre(registry, input) === undefined
      ? input
      : { ...input, genre: { value: BLANK_WORLD_ID, provenance: DERIVED } };
  return { intent: chosenIntent(registry, choices, mechanicalRuleset(registry, known)), words };
};

export const pitchNotes = (text: string | undefined, locale = DEFAULT_LOCALE, packs: Packs = BUILT_IN_PACKS) => {
  const proposed = text === undefined ? undefined : proposeCampaignIntent(text);
  const phrase = proposed?.ok ? unmatchedGenre(registryOf(packs), proposed.proposal.input) : undefined;
  return phrase === undefined
    ? []
    : [
        say(locale, 'quickstart.genreKept', {
          phrase,
          genre: contentText(locale, 'genre', BLANK_WORLD_ID, BLANK_WORLD_PACK.genre.name),
        }),
      ];
};

const resolvedIntent = (registry: Registry, choices: CampaignIntent): CampaignIntent => {
  const intent = canonicalGenre(registry, choices);
  if (intent.ruleset.value === null) return intent;
  const resolution = resolveRuleset(registry, intent.ruleset.value);
  if (resolution.status !== 'resolved') throw rulesetError(resolution);
  const { id, edition } = resolution.rulepack;
  return { ...intent, ruleset: { value: { id, edition }, provenance: intent.ruleset.provenance } };
};

const configFor = (registry: Registry, intent: CampaignIntent, words: Words = NO_WORDS): CampaignConfig => {
  const result = generateCampaignConfig(intent, registry);
  if (result.ok) return result.config;
  const conflicts = result.issues.some(({ code }) => code === CONFLICT)
    ? detectConflicts(intent, reportFor(intent, registry))
    : [];
  const unsupported = conflicts.flatMap(({ code, entries: [entry] }) =>
    code === CLIENT_UNSUPPORTED && entry !== undefined ? [entry.field] : [],
  );
  const lines = [
    ...result.issues.filter(({ code }) => code !== CONFLICT).map((issue) => issueText(intent, issue, words)),
    ...conflicts.filter(({ code }) => code !== CLIENT_UNSUPPORTED).map((conflict) => conflictText(conflict, words)),
  ];
  const clients = CLIENTS.filter((client) => unsupported.every((field) => supports(client, field)));
  const [client] = clients;
  if (unsupported.length === 0 || client === undefined) throw new LocalizedError('quickstart.lines', { lines });
  const advice = new LocalizedError('quickstart.useClient', {
    clients: new ListParam(clients, 'disjunction'),
    fields: new ListParam(
      unsupported.map((field) => wordsOf(words, field)),
      'conjunction',
    ),
  });
  throw new ClientUnsupported([...lines, advice], client);
};

export const planCampaign = (text?: string, choices: Choices = {}, packs: Packs = BUILT_IN_PACKS): CampaignConfig => {
  const registry = registryOf(packs);
  if (text === undefined) return configFor(registry, chosenIntent(registry, choices));
  const { intent, words } = intentFrom(registry, text, choices);
  return configFor(registry, intent, words);
};

const MAX_TITLE_WORDS = 4;
const MAX_TITLE_LENGTH = 40;
const WORD_SEPARATOR = /\s+/;

export const isPitch = (text: string) =>
  text.trim().split(WORD_SEPARATOR).length > MAX_TITLE_WORDS || text.trim().length > MAX_TITLE_LENGTH;

const TITLE_CLAUSE_END = /[,;!?](?=\s|$)/;
const MIN_TITLE_WORDS = 2;
const STRONG_PORTUGUESE_CUES = /(?<!\p{L})(?:uns|umas|não|história|aventura|mistério)(?!\p{L})/iu;
const PORTUGUESE_CUES = /(?<!\p{L})(?:uma?|uns|umas|sem|não|história|aventura|mistério|com|em)(?!\p{L})/giu;
const MIN_PORTUGUESE_CUES = 2;
const PORTUGUESE_LOCALE = 'pt-BR';

const splitWords = (text: string) => text.trim().split(WORD_SEPARATOR);
const fitted = (words: string[]) =>
  words.reduce(
    (title, word) => (`${title} ${word}`.trim().length <= MAX_TITLE_LENGTH ? `${title} ${word}`.trim() : title),
    '',
  );

export const titleOf = (pitch: string) => {
  const clause = splitWords(pitch.split(TITLE_CLAUSE_END, 1)[0] ?? '');
  const title = fitted(clause.length < MIN_TITLE_WORDS ? splitWords(pitch) : clause);
  return title || (splitWords(pitch)[0] ?? '').slice(0, MAX_TITLE_LENGTH);
};

export const pitchLanguage = (pitch: string | undefined) =>
  pitch !== undefined &&
  STRONG_PORTUGUESE_CUES.test(pitch) &&
  new Set([...pitch.matchAll(PORTUGUESE_CUES)].map(([word]) => word.toLowerCase())).size >= MIN_PORTUGUESE_CUES
    ? PORTUGUESE_LOCALE
    : undefined;

export type Opening = {
  title: string;
  narration: string;
  locationKind?: string;
  moodTags?: readonly string[];
};

export const openingFor = ({ genre }: CampaignConfig, fallback: Opening, locale = DEFAULT_LOCALE): Opening => {
  const pack = GENRE_PACKS.find((candidate) => candidate.genre.id === genre?.id);
  const scene = pack?.story?.openingScenes[0];
  return pack === undefined || scene === undefined
    ? fallback
    : {
        title: contentText(locale, 'genre', pack.genre.id, pack.genre.name),
        narration: `${contentText(locale, 'genre.opening', pack.genre.id, scene)}.`,
      };
};

const styleLine = (source: string, id: string, style: unknown) =>
  style === undefined ? [] : [`${source} ${id} style: ${JSON.stringify(style)}`];

export const rulesDocumentStyleLines = (documents: readonly RulesDocument[]): string[] =>
  documents.flatMap(({ name, style }) =>
    style === undefined || Object.keys(style).length === 0
      ? []
      : styleLine('rules-document', JSON.stringify(name), style),
  );

export const styleLinesOf = ({ rulepack, genre }: CampaignConfig, packs: Packs = BUILT_IN_PACKS): string[] => [
  ...styleLine(
    'rulepack',
    rulepack?.id ?? '',
    packs.find(
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
      value:
        genre === null
          ? none
          : `${isBuiltInGenre(genre) ? contentText(locale, 'genre', genre.id, genre.id) : genre.id} ${genre.version}`,
      provenance: how(provenance.genre),
    }),
    say(locale, 'config.dice', { value: say(locale, DICE_KEYS[values.dice]), provenance: how(provenance.dice) }),
  ].join('\n');
};

const featuresOf = ({ capabilities }: RulePackManifest) =>
  Object.entries(capabilities)
    .filter(([, mode]) => mode === true)
    .map(([feature]) => feature);

const sheetOf = (pack: RulePackManifest) =>
  (creationRulesFor(pack)?.schema.fields ?? [])
    .filter(({ derived }) => derived === undefined)
    .map(({ id: field, label }) => label ?? field);

const blurbOf = (pack: RulePackManifest, features: readonly string[]) => {
  const { resolution, sheet } = rulesUsageOf(pack);
  if (resolution !== 'dice' && sheet === 'none') return DICELESS_SHEETLESS;
  return features.length === 0 ? LIGHT_RULES : `Rules for ${LIST.format(features)}.`;
};

const PREMADE_NAMES = GENRE_PACKS.flatMap(({ genre }) =>
  genre.archetypes.flatMap(({ id, name }) => [name, ...contentAliases('archetype', id)]),
);
const premadeNameOf = (character: string) =>
  PREMADE_NAMES.find((name) => name.toLowerCase() === character.trim().toLowerCase());

const readyMadeOn = (pack: RulePackManifest) => {
  const rules = creationRulesFor(pack);
  return (
    rules === undefined ||
    GENRE_PACKS.every(({ genre }) =>
      genre.archetypes.every(({ name }) => buildCharacter(premadeBuild(rules, name)).status === 'created'),
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
      characters: genre.archetypes.map(({ id, name, summary }) => ({ id, name, summary })),
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
      rulepack !== null &&
      pack.id === baseIdOf(rulepack.id) &&
      pack.edition === rulepack.edition &&
      pack.revision === rulepack.revision,
  );

const STATIC_BUILDER_CODES: readonly BuilderIssue['code'][] = [
  'unknown_field',
  'derived_field',
  'override_not_permitted',
  'unsupported_equipment',
  'duplicate',
  'not_list',
];
const UNBOUNDED_MIN = '-∞';
const UNBOUNDED_MAX = '∞';

export const builderIssueText = ({ code, message, min, max, widget }: BuilderIssue): string | LocalizedError => {
  if (code === 'out_of_range' && (min !== undefined || max !== undefined))
    return new LocalizedError('quickstart.builder.out_of_range', {
      min: min ?? UNBOUNDED_MIN,
      max: max ?? UNBOUNDED_MAX,
    });
  if (code === 'invalid_value' && widget !== undefined)
    return new LocalizedError('quickstart.builder.invalid_value', { widget });
  return STATIC_BUILDER_CODES.includes(code) ? new LocalizedError(`quickstart.builder.${code}`) : message;
};

export const startingCharacter = ({ rulepack, values: { character } }: CampaignConfig): BuildInput | undefined => {
  const rules = creationRulesFor(rulepack);
  if (typeof character !== 'string' || rules === undefined) return undefined;
  const premade = premadeNameOf(character);
  const build = premade === undefined ? describedBuild(rules, character) : premadeBuild(rules, premade);
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
    issues: new ListParam(result.issues.map(builderIssueText), 'semicolon'),
  });
};

export const defaultCharacter = (rulepack: CampaignConfig['rulepack'], name: string): BuildInput | undefined => {
  const rules = creationRulesFor(rulepack);
  return rules === undefined ? undefined : premadeBuild(rules, name);
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
    const plan = planStart(command, client, packs);
    const notes = pitchNotes(command.intent, locale, packs);
    if (notes.length === 0) return { ok: true, value: plan };
    const entries = plan.entries.map((entry) =>
      entry.field === 'genre' && entry.provenance === DERIVED && entry.value === BLANK_WORLD_ID
        ? { ...entry, provenance: FALLBACK }
        : entry,
    );
    return { ok: true, value: { ...plan, entries, notes } };
  } catch (error) {
    return failureOf(error, locale);
  }
};
