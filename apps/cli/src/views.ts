import type { CampaignState, Character, EventId } from '../../../packages/domain/src/campaign.ts';
import { CHARACTER_KIND, isProfileVisibility, parseCharacterProfile } from '../../../packages/domain/src/character.ts';
import type { CampaignEntity, EntityKind, Relationship } from '../../../packages/domain/src/entity.ts';
import { questLog } from '../../../packages/engine/src/quest.ts';
import { PLAYER_VIEWER, type Scoped, visibleTo } from '../../../packages/memory/src/knowledge.ts';
import { SHEET_SCHEMA_VERSION, type SheetField, type WidgetType } from '../../../packages/rules/src/sheet-schema.ts';
import { buildSheetView, exportSheet, type SheetViewInput } from '../../../packages/rules/src/sheet-view.ts';

export const VIEW_NAMES = ['sheet', 'sheet-export', 'inventory', 'journal', 'quests', 'recap'] as const;
export type ViewName = (typeof VIEW_NAMES)[number];
export type ReadView = Exclude<ViewName, 'recap'>;

export type ViewSource = {
  readonly state: CampaignState;
  readonly entities: readonly CampaignEntity[];
  readonly relationships: readonly Relationship[];
  readonly eventScopes: readonly (Scoped & { readonly id: EventId })[];
};

const ITEM_KIND: EntityKind = 'item';
const OWNER_FIELD = 'owner';
const PLAYER_OWNER = { role: 'player', owner: true } as const;
const WIDGET_BY_TYPE: Readonly<Record<string, WidgetType>> = { number: 'number', boolean: 'toggle', string: 'text' };
const NO_CHARACTER = 'No character yet.';
const NO_SHEET = 'No character sheet yet.';
const NO_ITEMS = 'No items yet.';
const NO_QUESTS = 'No quests yet.';
const NO_EVENTS = 'No events yet.';
const DONE = '[x]';
const JSON_INDENT = 2;
const OPEN = '[ ]';

const section = (title: string, rows: readonly string[], empty: string) =>
  rows.length === 0 ? `${title}\n${empty}` : [title, ...rows].join('\n');

const sheetInput = (entities: readonly CampaignEntity[], hero: Character): SheetViewInput | undefined => {
  const entity = entities.find(({ id, kind }) => id === hero.id && kind === CHARACTER_KIND);
  const parsed = entity === undefined ? undefined : parseCharacterProfile(entity.data);
  if (entity === undefined || !parsed?.ok || !isProfileVisibility(entity.visibility)) return undefined;
  const { profile } = parsed;
  const rulepack = { ...profile.rulepack, sourceRefs: [] };
  const fields: SheetField[] = profile.traits.map(({ id, value }) => ({
    id,
    widget: WIDGET_BY_TYPE[typeof value] ?? 'text',
    custom: false,
    visibility: OWNER_FIELD,
  }));
  return {
    schema: { schemaVersion: SHEET_SCHEMA_VERSION, rulepack, fields },
    profile,
    stats: { ok: true, rulepack, order: [], values: {}, appliedBonuses: [], constraints: [] },
    visibility: entity.visibility,
    viewer: PLAYER_OWNER,
  };
};

const sheet = (hero: Character, entities: readonly CampaignEntity[]) => {
  const input = sheetInput(entities, hero);
  if (input === undefined) return `${hero.name}\n${NO_SHEET}`;
  const { rulepack } = input.schema;
  const rows = buildSheetView(input).groups.flatMap((group) =>
    group.fields.map((field) => `  ${field.label ?? field.id}: ${field.value}`),
  );
  return section(`${hero.name} (${rulepack.id} ${rulepack.edition})`, rows, NO_SHEET);
};

const sheetExport = (hero: Character, entities: readonly CampaignEntity[]) => {
  const input = sheetInput(entities, hero);
  return input === undefined ? `${hero.name}\n${NO_SHEET}` : JSON.stringify(exportSheet(input), null, JSON_INDENT);
};

const inventory = (hero: Character, { entities, relationships }: ViewSource) => {
  const held = new Set(relationships.filter(({ sourceId }) => sourceId === hero.id).map(({ targetId }) => targetId));
  const items = entities.filter(({ id, kind }) => kind === ITEM_KIND && held.has(id));
  return section(
    'Inventory:',
    items.map(({ name }) => `  - ${name}`),
    NO_ITEMS,
  );
};

const quests = ({ state, eventScopes }: ViewSource) => {
  const shown = new Set(visibleTo(eventScopes, PLAYER_VIEWER).map(({ id }) => id));
  const rows = questLog(state.events.filter(({ id }) => shown.has(id))).flatMap((quest) => [
    `  - ${quest.title} (${quest.status})`,
    ...quest.objectives.map(({ done, summary }) => `    ${done ? DONE : OPEN} ${summary}`),
  ]);
  return section('Quests:', rows, NO_QUESTS);
};

const journal = ({ characters, turns }: CampaignState) => {
  const names = new Map(characters.map(({ id, name }) => [id, name]));
  const rows = turns.map(({ actorId, input, narration }, index) => {
    const text = narration.trim() === '' ? `${names.get(actorId) ?? actorId}: ${input}` : narration;
    return `  ${index + 1}. ${text}`;
  });
  return section('Journal:', rows, NO_EVENTS);
};

export const renderView = (view: ReadView, source: ViewSource): string => {
  if (view === 'journal') return journal(source.state);
  if (view === 'quests') return quests(source);
  const [hero] = source.state.characters;
  if (hero === undefined) return NO_CHARACTER;
  const visible = { ...source, entities: visibleTo(source.entities, PLAYER_VIEWER) };
  if (view === 'sheet') return sheet(hero, visible.entities);
  return view === 'sheet-export' ? sheetExport(hero, visible.entities) : inventory(hero, visible);
};
