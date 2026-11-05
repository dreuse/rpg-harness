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
import { BUILT_IN_PACKS } from './import-gateway.ts';

const GENRE_PACKS: readonly { genre: Pick<GenrePack, 'id' | 'version' | 'name'>; story?: StoryKit }[] = [
  FANTASY_PACK,
  SCIENCE_FICTION_PACK,
  HORROR_PACK,
  MYSTERY_PACK,
  MODERN_ADVENTURE_PACK,
  BLANK_WORLD_PACK,
];
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
const DICE_LABELS: Record<CapabilityMode, string> = { rulepack: 'as the ruleset decides', on: 'on', off: 'off' };

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
  if (resolution.status !== 'resolved') throw new Error(rulesetError(resolution));
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
