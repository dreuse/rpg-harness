import { safeLocale } from './locale.ts';
import type { CampaignHealth, CampaignSummary } from './protocol.ts';

export const SEARCH_AFTER = 5;

export type HomeCard = {
  readonly name: string;
  readonly health: CampaignHealth;
  readonly playable: boolean;
  readonly characters: string;
  readonly rules?: string;
  readonly scene?: string;
  readonly narration?: string;
  readonly lastPlayedAt: string | null;
};

const SECOND_MS = 1000;
const SMALLEST_UNIT: readonly [Intl.RelativeTimeFormatUnit, number] = ['second', SECOND_MS];
const TIME_UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ['year', 365 * 24 * 60 * 60 * SECOND_MS],
  ['month', 30 * 24 * 60 * 60 * SECOND_MS],
  ['week', 7 * 24 * 60 * 60 * SECOND_MS],
  ['day', 24 * 60 * 60 * SECOND_MS],
  ['hour', 60 * 60 * SECOND_MS],
  ['minute', 60 * SECOND_MS],
  SMALLEST_UNIT,
];

export const hasSearch = (campaigns: readonly unknown[]): boolean => campaigns.length > SEARCH_AFTER;

const rulesOf = ({ ruleset, genre }: CampaignSummary): string | undefined => {
  const parts = [ruleset && `${ruleset.id} ${ruleset.edition}`, genre?.id].filter((part): part is string => !!part);
  return parts.length === 0 ? undefined : parts.join(', ');
};

const cardOf = (summary: CampaignSummary): HomeCard => {
  const rules = rulesOf(summary);
  return {
    name: summary.name,
    health: summary.health,
    playable: summary.health === 'ok' && summary.id !== null,
    characters: summary.characters.map(({ name }) => name).join(', '),
    ...(rules === undefined ? {} : { rules }),
    ...(summary.sceneTitle === null ? {} : { scene: summary.sceneTitle }),
    ...(summary.lastNarration === null ? {} : { narration: summary.lastNarration }),
    lastPlayedAt: summary.lastPlayedAt,
  };
};

const byLastPlayed = (left: HomeCard, right: HomeCard): number =>
  (right.lastPlayedAt ?? '').localeCompare(left.lastPlayedAt ?? '') || left.name.localeCompare(right.name);

const matches = (card: HomeCard, query: string): boolean =>
  [card.name, card.characters, card.rules, card.scene]
    .filter((field): field is string => field !== undefined)
    .some((field) => field.toLowerCase().includes(query));

export const homeCards = (campaigns: readonly CampaignSummary[], query = ''): readonly HomeCard[] => {
  const needle = query.trim().toLowerCase();
  return campaigns
    .map(cardOf)
    .filter((card) => needle === '' || matches(card, needle))
    .sort(byLastPlayed);
};

export const relativeTime = (iso: string | null, now: number, locale: string): string | undefined => {
  const at = iso === null ? Number.NaN : Date.parse(iso);
  if (Number.isNaN(at)) return undefined;
  const elapsed = at - now;
  const [unit, size] = TIME_UNITS.find(([, ms]) => Math.abs(elapsed) >= ms) ?? SMALLEST_UNIT;
  return new Intl.RelativeTimeFormat(safeLocale(locale), { numeric: 'auto' }).format(Math.round(elapsed / size), unit);
};
