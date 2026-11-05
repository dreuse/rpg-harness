import type { CampaignPanels, CitationEntry } from '../../../packages/client-protocol/src/protocol.ts';
import type { SheetSchema, SheetValueType } from '../../../packages/client-protocol/src/sheet-widgets.ts';
import {
  type CampaignEvent,
  type CampaignState,
  type Character,
  type EventId,
  OPENING_ACTION_ID,
  type Turn,
} from '../../../packages/domain/src/campaign.ts';
import {
  CHARACTER_KIND,
  isProfileVisibility,
  type ProfileVisibility,
  parseCharacterProfile,
} from '../../../packages/domain/src/character.ts';
import type { CampaignEntity, EntityKind, Relationship } from '../../../packages/domain/src/entity.ts';
import { CHARACTER_CREATED, playTurns, profileOf } from '../../../packages/engine/src/character.ts';
import { currentEncounter, type EncounterAction } from '../../../packages/engine/src/encounter.ts';
import { questLog } from '../../../packages/engine/src/quest.ts';
import { PLAYER_VIEWER, type Scoped, type Viewer, visibleTo } from '../../../packages/memory/src/knowledge.ts';
import type { RollEvent } from '../../../packages/rules/src/dice.ts';
import {
  type Visibility as FieldVisibility,
  SHEET_SCHEMA_VERSION,
  type SheetField,
  VISIBILITIES,
  type WidgetType,
} from '../../../packages/rules/src/sheet-schema.ts';
import {
  buildSheetView,
  exportSheet,
  type SheetViewer,
  type SheetViewInput,
} from '../../../packages/rules/src/sheet-view.ts';

export const VIEW_NAMES = ['sheet', 'sheet-export', 'inventory', 'journal', 'quests', 'encounter', 'recap'] as const;
export type ViewName = (typeof VIEW_NAMES)[number];
export type ReadView = Exclude<ViewName, 'recap'>;

export type ViewSource = {
  readonly state: CampaignState;
  readonly entities: readonly CampaignEntity[];
  readonly relationships: readonly Relationship[];
  readonly eventScopes: readonly (Scoped & { readonly id: EventId })[];
};

const ITEM_KIND: EntityKind = 'item';
const OWNER_FIELD: FieldVisibility = 'owner';
const HIDDEN_FIELD: FieldVisibility = 'hidden';
const PLAYER_OWNER = { role: 'player', owner: true } as const;
const OWNER_PROFILE: ProfileVisibility = 'player';
const WIDGET_BY_TYPE: Readonly<Record<string, WidgetType>> = { number: 'number', boolean: 'toggle', string: 'text' };
const EDIT_TYPE_BY_VALUE: Readonly<Record<string, SheetValueType>> = {
  number: 'number',
  boolean: 'flag',
  string: 'text',
};
const EDITABLE_FIELDS: readonly FieldVisibility[] = ['public', OWNER_FIELD];
const NO_CHARACTER = 'No character yet.';
const NO_SHEET = 'No character sheet yet.';
const NO_ITEMS = 'No items yet.';
const NO_QUESTS = 'No quests yet.';
const NO_EVENTS = 'No events yet.';
const NO_ENCOUNTER = 'No encounter yet.';
const DONE = '[x]';
const LIST_SEPARATOR = ', ';
const REPLY_SEPARATOR = ' - ';
const JSON_INDENT = 2;
const OPEN = '[ ]';
const RULEPACK_KEYS = ['id', 'edition', 'revision'] as const;
const ACTOR_SCOPE: Viewer['scope'] = 'actor';
const UNPRINTABLE = /[^\P{Cc}\n]|\p{Cf}/gu;

export const printable = (text: string) => text.replace(UNPRINTABLE, '');

export type Panels = Omit<CampaignPanels, 'version' | 'campaignId' | 'revision'>;

const section = (title: string, rows: readonly string[], empty: string) =>
  rows.length === 0 ? `${title}\n${empty}` : [title, ...rows].join('\n');

const storedProfile = ({ entities, state }: ViewSource, hero: Character) => {
  const entity = entities.find(({ id, kind }) => id === hero.id && kind === CHARACTER_KIND);
  if (entity !== undefined)
    return visibleTo([entity], PLAYER_VIEWER).length === 0
      ? undefined
      : { data: entity.data, visibility: entity.visibility, traitVisibility: undefined };
  const created = state.events.findLast(
    ({ type, payload }) => type === CHARACTER_CREATED && payload.actorId === hero.id,
  );
  if (created === undefined) return undefined;
  const { traitVisibility } = created.payload;
  return {
    data: profileOf(state.events, hero.id),
    visibility: OWNER_PROFILE,
    traitVisibility: isRecord(traitVisibility) ? traitVisibility : undefined,
  };
};

const fieldVisibility = (declared: Readonly<Record<string, unknown>> | undefined, id: string): FieldVisibility => {
  if (declared === undefined) return OWNER_FIELD;
  const visibility = declared[id];
  return VISIBILITIES.find((known) => known === visibility) ?? HIDDEN_FIELD;
};

const sheetInput = (source: ViewSource, hero: Character, viewer: SheetViewer): SheetViewInput | undefined => {
  const stored = storedProfile(source, hero);
  const parsed = stored === undefined ? undefined : parseCharacterProfile(stored.data);
  if (stored === undefined || !parsed?.ok || !isProfileVisibility(stored.visibility)) return undefined;
  const { profile } = parsed;
  const rulepack = { ...profile.rulepack, sourceRefs: [] };
  const fields: SheetField[] = profile.traits.map(({ id, value }) => ({
    id,
    widget: WIDGET_BY_TYPE[typeof value] ?? 'text',
    custom: false,
    visibility: fieldVisibility(stored.traitVisibility, id),
  }));
  return {
    schema: { schemaVersion: SHEET_SCHEMA_VERSION, rulepack, fields },
    profile,
    stats: { ok: true, rulepack, order: [], values: {}, appliedBonuses: [], constraints: [] },
    visibility: stored.visibility,
    viewer,
  };
};

const sheet = (hero: Character, source: ViewSource, viewer: SheetViewer) => {
  const input = sheetInput(source, hero, viewer);
  if (input === undefined) return `${hero.name}\n${NO_SHEET}`;
  const { rulepack } = input.schema;
  const rows = buildSheetView(input).groups.flatMap((group) =>
    group.fields.map((field) => `  ${field.label ?? field.id}: ${field.value}`),
  );
  return section(`${hero.name} (${rulepack.id} ${rulepack.edition})`, rows, NO_SHEET);
};

const GM_SHEET_VIEWER: SheetViewer = { role: 'gm' };
const GM_SCOPE: Viewer['scope'] = 'gm';

const sheetViewerOf = (viewer: Viewer, hero: Character): SheetViewer | undefined => {
  if (viewer.scope === GM_SCOPE) return GM_SHEET_VIEWER;
  if (viewer.scope === ACTOR_SCOPE && viewer.actorId !== hero.id) return undefined;
  return PLAYER_OWNER;
};

export const editableSheet = (
  source: ViewSource,
  actorId: string,
): { readonly schema: SheetSchema; readonly values: Readonly<Record<string, unknown>> } | undefined => {
  const hero = source.state.characters.find(({ id }) => id === actorId);
  const stored = hero === undefined ? undefined : storedProfile(source, hero);
  const parsed = stored === undefined ? undefined : parseCharacterProfile(stored.data);
  if (stored === undefined || !parsed?.ok) return undefined;
  const fields = parsed.profile.traits.flatMap(({ id, value }) => {
    const type = EDIT_TYPE_BY_VALUE[typeof value];
    const editable = EDITABLE_FIELDS.includes(fieldVisibility(stored.traitVisibility, id));
    return type === undefined || !editable ? [] : [{ id, label: id, type, editable, value }];
  });
  return {
    schema: { fields: fields.map(({ value: _, ...field }) => field) },
    values: Object.fromEntries(fields.map(({ id, value }) => [id, value])),
  };
};

export const sheetFields = (source: ViewSource, viewer: Viewer) => {
  const [hero] = source.state.characters;
  const sheetViewer = hero === undefined ? undefined : sheetViewerOf(viewer, hero);
  const input = hero === undefined || sheetViewer === undefined ? undefined : sheetInput(source, hero, sheetViewer);
  return input === undefined ? [] : buildSheetView(input).groups.flatMap((group) => group.fields);
};

const sheetExport = (hero: Character, source: ViewSource, viewer: SheetViewer) => {
  const input = sheetInput(source, hero, viewer);
  return input === undefined ? `${hero.name}\n${NO_SHEET}` : JSON.stringify(exportSheet(input), null, JSON_INDENT);
};

const heldItems = (hero: Character, { entities, relationships }: ViewSource) => {
  const held = new Set(relationships.filter(({ sourceId }) => sourceId === hero.id).map(({ targetId }) => targetId));
  return entities.filter(({ id, kind }) => kind === ITEM_KIND && held.has(id));
};

const inventory = (hero: Character, source: ViewSource) =>
  section(
    'Inventory:',
    heldItems(hero, source).map(({ name }) => `  - ${name}`),
    NO_ITEMS,
  );

const visibleEvents = ({ state, eventScopes }: ViewSource, viewer: Viewer) => {
  const shown = new Set(visibleTo(eventScopes, viewer).map(({ id }) => id));
  return state.events.filter(({ id }) => shown.has(id));
};

const playerEvents = (source: ViewSource) => visibleEvents(source, PLAYER_VIEWER);

const quests = (source: ViewSource) => {
  const rows = questLog(playerEvents(source)).flatMap((quest) => [
    `  - ${quest.title} (${quest.status})`,
    ...quest.objectives.map(({ done, summary }) => `    ${done ? DONE : OPEN} ${summary}`),
  ]);
  return section('Quests:', rows, NO_QUESTS);
};

const signed = (value: number) => (value < 0 ? `${value}` : `+${value}`);

const rollText = ({ pool, draws, total }: RollEvent) => {
  const dice = pool.dice.map(({ count, sides }) => `${count}d${sides}`).join('+');
  const modifier = pool.modifier === 0 ? '' : signed(pool.modifier);
  return `    Roll: ${dice}${modifier} [${draws.flat().join(LIST_SEPARATOR)}] = ${total}`;
};

const actionRows = (name: string, { ruleId, modifiers, resolution }: EncounterAction) => {
  const applied = Object.entries(modifiers).map(([id, value]) => `${id} ${signed(value)}`);
  const results = resolution.ok ? resolution.events.map(({ event }) => event) : [`failed (${resolution.error.code})`];
  const changes = resolution.ok ? resolution.changes.map(({ id, from, to }) => `${id} ${from} -> ${to}`) : [];
  return [
    `  - ${name}: ${ruleId}`,
    ...resolution.rolls.map(rollText),
    ...(applied.length === 0 ? [] : [`    Modifiers: ${applied.join(LIST_SEPARATOR)}`]),
    ...(results.length === 0 ? [] : [`    Result: ${results.join(LIST_SEPARATOR)}`]),
    ...(changes.length === 0 ? [] : [`    Changes: ${changes.join(LIST_SEPARATOR)}`]),
  ];
};

const encounter = (source: ViewSource) => {
  const current = currentEncounter(playerEvents(source));
  if (current === undefined) return NO_ENCOUNTER;
  const names = new Map(source.state.characters.map(({ id, name }) => [id, name]));
  const rows = current.actions.flatMap((action) => actionRows(names.get(action.actorId) ?? action.actorId, action));
  const outcome = current.outcome === undefined ? [] : [`Outcome: ${current.outcome}`];
  return [`Encounter (${current.status}, round ${current.round}):`, ...rows, ...outcome].join('\n');
};

const turnText = (names: ReadonlyMap<string, string>, { actionId, actorId, input, narration }: Turn) => {
  if (actionId === OPENING_ACTION_ID) return narration;
  const said = `${names.get(actorId) ?? actorId}: ${input}`;
  return narration.trim() === '' ? said : `${said}${REPLY_SEPARATOR}${narration}`;
};

const namesOf = ({ characters }: CampaignState) => new Map(characters.map(({ id, name }) => [id, name]));

const journal = (state: CampaignState) => {
  const names = namesOf(state);
  const rows = playTurns(state).map((turn, index) => `  ${index + 1}. ${turnText(names, turn)}`);
  return section('Journal:', rows, NO_EVENTS);
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;

const isText = (value: unknown): value is string => typeof value === 'string';

const citationOf = ({ id, payload }: CampaignEvent): CitationEntry[] => {
  const { citation } = payload;
  if (!isRecord(citation) || !isText(citation.ruleId) || !isText(citation.section)) return [];
  const { rulepack } = citation;
  if (!isRecord(rulepack) || !RULEPACK_KEYS.every((key) => isText(rulepack[key]))) return [];
  const pack = { id: String(rulepack.id), edition: String(rulepack.edition), revision: String(rulepack.revision) };
  return [{ eventId: id, ruleId: citation.ruleId, section: citation.section, rulepack: pack }];
};

export const panelsOf = (source: ViewSource, viewer: Viewer): Panels => {
  const { state } = source;
  const [hero] = state.characters;
  const events = visibleEvents(source, viewer);
  const visible = { ...source, entities: visibleTo(source.entities, viewer) };
  const last = playTurns(state).at(-1);
  return {
    inventory: hero === undefined ? [] : heldItems(hero, visible).map(({ id, name }) => ({ id, name })),
    quests: questLog(events).map(({ id, title, status, objectives }) => ({
      id,
      title,
      status,
      objectives: objectives.map(({ summary, done }) => ({ summary, done })),
    })),
    citations: events.flatMap(citationOf),
    recap: {
      scene: state.currentScene?.title,
      latest: last === undefined ? undefined : turnText(namesOf(state), last),
    },
  };
};

const renderStored = (view: ReadView, source: ViewSource, viewer: SheetViewer): string => {
  if (view === 'journal') return journal(source.state);
  if (view === 'quests') return quests(source);
  if (view === 'encounter') return encounter(source);
  const [hero] = source.state.characters;
  if (hero === undefined) return NO_CHARACTER;
  if (view === 'sheet') return sheet(hero, source, viewer);
  if (view === 'sheet-export') return sheetExport(hero, source, viewer);
  return inventory(hero, { ...source, entities: visibleTo(source.entities, PLAYER_VIEWER) });
};

export const renderView = (view: ReadView, source: ViewSource, viewer: SheetViewer = PLAYER_OWNER): string =>
  printable(renderStored(view, source, viewer));
