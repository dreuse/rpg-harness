import { contentText } from '../../../packages/client-protocol/src/content-names.ts';
import { DEFAULT_LOCALE } from '../../../packages/client-protocol/src/locale.ts';
import type { CampaignPanels, CitationEntry } from '../../../packages/client-protocol/src/protocol.ts';
import type { SheetSchema, SheetValueType } from '../../../packages/client-protocol/src/sheet-widgets.ts';
import {
  type CampaignEvent,
  type CampaignState,
  CHECK_RESOLVED,
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
import { usesSheet } from '../../../packages/domain/src/rules-usage.ts';
import { CHARACTER_CREATED, playTurns, profileOf } from '../../../packages/engine/src/character.ts';
import { proposalEventsOf } from '../../../packages/engine/src/check-offer.ts';
import type { EncounterAction } from '../../../packages/engine/src/encounter.ts';
import { campaignLanguageOf } from '../../../packages/engine/src/engine.ts';
import { HIT_EVENTS, MISS_EVENTS } from '../../../packages/engine/src/gameplay.ts';
import { ENTITY_INTRODUCED } from '../../../packages/engine/src/memory.ts';
import { oocStateOf } from '../../../packages/engine/src/ooc.ts';
import { campaignConfigOf } from '../../../packages/engine/src/turn.ts';
import { parseCampaignConfig } from '../../../packages/intent/src/config.ts';
import { PLAYER_VIEWER, type Scoped, type Viewer, visibleTo } from '../../../packages/memory/src/knowledge.ts';
import { D20_LITE_MANIFEST } from '../../../packages/rules/src/d20-lite.ts';
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
  type ComputedDescriptor,
  exportSheet,
  type SheetView,
  type SheetViewer,
  type SheetViewInput,
} from '../../../packages/rules/src/sheet-view.ts';
import {
  audienceOf,
  QUEST_COMPLETED,
  QUEST_FAILED,
  QUEST_OBJECTIVE_COMPLETED,
  visibleFoldsOf,
} from '../../../packages/timelines/src/live-folds.ts';
import { say } from './messages.ts';
import { creationRulesFor, type Packs, usageFor } from './quickstart.ts';

export const VIEW_NAMES = ['sheet', 'sheet-export', 'inventory', 'journal', 'quests', 'encounter', 'recap'] as const;
export type ViewName = (typeof VIEW_NAMES)[number];
export type ReadView = Exclude<ViewName, 'recap'>;

export type FoldEvent = CampaignEvent & Scoped;

export type ViewSource = {
  readonly state: CampaignState;
  readonly entities: readonly CampaignEntity[];
  readonly relationships: readonly Relationship[];
  readonly eventScopes: readonly (Scoped & { readonly id: EventId })[];
  readonly foldEvents?: readonly FoldEvent[];
  readonly packs?: Packs;
};

const NO_FOLD_EVENTS: readonly FoldEvent[] = [];
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
const DONE = '[x]';
const LIST_SEPARATOR = ', ';
const REPLY_SEPARATOR = ' - ';
const JSON_INDENT = 2;
const OPEN = '[ ]';
const SHEET_COMPONENT = 'field';
const EXPLANATION_SEPARATOR = '; ';
const CONSTRAINT_STATUSES: readonly string[] = ['clamped', 'violated'];
const RULEPACK_KEYS = ['id', 'edition', 'revision'] as const;
const ACTOR_SCOPE: Viewer['scope'] = 'actor';
const UNPRINTABLE = /[^\P{Cc}\n]|\p{Cf}/gu;

export const printable = (text: string) => text.replace(UNPRINTABLE, '');

export type Panels = Omit<CampaignPanels, 'version' | 'campaignId' | 'revision'>;

const section = (title: string, rows: readonly string[], empty: string) =>
  rows.length === 0 ? `${title}\n${empty}` : [title, ...rows].join('\n');

const labelLocale = (rulepackId: string, locale: string) =>
  rulepackId === D20_LITE_MANIFEST.id ? locale : DEFAULT_LOCALE;

const storedProfile = ({ entities, state }: ViewSource, hero: Character) => {
  const entity = entities.find(({ id, kind }) => id === hero.id && kind === CHARACTER_KIND);
  if (entity !== undefined)
    return visibleTo([entity], PLAYER_VIEWER).length === 0
      ? undefined
      : {
          data: profileOf(state.events, hero.id, entity.data),
          visibility: entity.visibility,
          traitVisibility: undefined,
        };
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

const traitLabels = (rulepack: Parameters<typeof creationRulesFor>[0]) =>
  new Map(
    (creationRulesFor(rulepack)?.schema.fields ?? []).flatMap(({ id, label }) =>
      label === undefined ? [] : [[id, label] as const],
    ),
  );

const labelOf = (labels: ReadonlyMap<string, string>, id: string) => {
  const label = labels.get(id);
  return label === undefined ? {} : { label };
};

const sheetInput = (source: ViewSource, hero: Character, viewer: SheetViewer): SheetViewInput | undefined => {
  const stored = storedProfile(source, hero);
  const parsed = stored === undefined ? undefined : parseCharacterProfile(stored.data);
  if (stored === undefined || !parsed?.ok || !isProfileVisibility(stored.visibility)) return undefined;
  const { profile } = parsed;
  const rulepack = { ...profile.rulepack, sourceRefs: [] };
  const labels = traitLabels(profile.rulepack);
  const fields: SheetField[] = profile.traits.map(({ id, value }) => ({
    id,
    ...labelOf(labels, id),
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

const sheetless = ({ state, packs }: ViewSource) => {
  const saved = parseCampaignConfig(campaignConfigOf(state.events));
  return saved.ok && !usesSheet(usageFor(saved.config.rulepack, packs));
};

const description = (hero: Character, source: ViewSource) => {
  const stored = storedProfile(source, hero);
  const parsed = stored === undefined ? undefined : parseCharacterProfile(stored.data);
  return parsed?.ok === true && parsed.profile.background.trim() !== '' ? [parsed.profile.background.trim()] : [];
};

const sheetlessText = (hero: Character, source: ViewSource, locale: string) =>
  [hero.name, ...description(hero, source), say(locale, 'view.sheetless')].join('\n');

const sheet = (hero: Character, source: ViewSource, viewer: SheetViewer, locale: string) => {
  if (sheetless(source)) return sheetlessText(hero, source, locale);
  const input = sheetInput(source, hero, viewer);
  const noSheet = say(locale, 'view.noSheet');
  if (input === undefined) return `${hero.name}\n${noSheet}`;
  const { rulepack } = input.schema;
  const shownLocale = labelLocale(rulepack.id, locale);
  const rows = buildSheetView(input).groups.flatMap((group) =>
    group.fields.map(
      ({ id, label, value }) =>
        `  ${label === undefined ? id : contentText(shownLocale, 'stat', label, label)}: ${value}`,
    ),
  );
  return section(`${hero.name} (${rulepack.id} ${rulepack.edition})`, rows, noSheet);
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
  const labels = traitLabels(parsed.profile.rulepack);
  const fields = parsed.profile.traits.flatMap(({ id, value }) => {
    const type = EDIT_TYPE_BY_VALUE[typeof value];
    const editable = EDITABLE_FIELDS.includes(fieldVisibility(stored.traitVisibility, id));
    return type === undefined || !editable ? [] : [{ id, label: labels.get(id) ?? id, type, editable, value }];
  });
  return {
    schema: { fields: fields.map(({ value: _, ...field }) => field) },
    values: Object.fromEntries(fields.map(({ id, value }) => [id, value])),
  };
};

const explanationOf = ({ expression, bonuses, constraints }: ComputedDescriptor, locale: string) =>
  [
    ...(expression === undefined ? [] : [`= ${expression}`]),
    ...bonuses.map(({ source, amount }) => `${signed(amount)} ${source}`),
    ...constraints.flatMap(({ status, raw }) => {
      return CONSTRAINT_STATUSES.includes(status) ? [`${say(locale, `view.constraint.${status}`)} ${raw}`] : [];
    }),
  ].join(EXPLANATION_SEPARATOR);

export const sheetComponents = ({ rulepack, groups, computed }: SheetView, locale: string = DEFAULT_LOCALE) => {
  const sheetLocale = labelLocale(rulepack.id, locale);
  const explained = new Map(computed.map((descriptor) => [descriptor.field, explanationOf(descriptor, locale)]));
  return groups.flatMap(({ id: group, fields }) =>
    fields.map(({ id, label, value, edit }) => {
      const explanation = explained.get(id);
      return {
        kind: SHEET_COMPONENT,
        id,
        label: label === undefined ? id : contentText(sheetLocale, 'stat', label, label),
        value,
        group,
        editable: edit.editable,
        ...(edit.min === undefined ? {} : { min: edit.min }),
        ...(edit.max === undefined ? {} : { max: edit.max }),
        ...(explanation === undefined || explanation === '' ? {} : { explanation }),
      };
    }),
  );
};

const IDENTITY_FIELDS = ['name', 'description'] as const;

const identityComponents = (hero: Character, source: ViewSource, locale: string) => {
  const [text = ''] = description(hero, source);
  return IDENTITY_FIELDS.flatMap((id) => {
    const value = id === 'name' ? hero.name : text;
    return value === ''
      ? []
      : [{ kind: SHEET_COMPONENT, id, label: say(locale, `view.${id}`), value, editable: false }];
  });
};

export const sheetFields = (source: ViewSource, viewer: Viewer, locale: string = DEFAULT_LOCALE) => {
  const [hero] = source.state.characters;
  const sheetViewer = hero === undefined ? undefined : sheetViewerOf(viewer, hero);
  if (hero !== undefined && sheetViewer !== undefined && sheetless(source))
    return identityComponents(hero, source, locale);
  const input = hero === undefined || sheetViewer === undefined ? undefined : sheetInput(source, hero, sheetViewer);
  return input === undefined ? [] : sheetComponents(buildSheetView(input), locale);
};

const sheetExport = (hero: Character, source: ViewSource, viewer: SheetViewer, locale: string) => {
  if (sheetless(source)) return sheetlessText(hero, source, locale);
  const input = sheetInput(source, hero, viewer);
  return input === undefined
    ? `${hero.name}\n${say(locale, 'view.noSheet')}`
    : JSON.stringify(exportSheet(input), null, JSON_INDENT);
};

const heldItems = (hero: Character, { entities, relationships }: ViewSource) => {
  const held = new Set(relationships.filter(({ sourceId }) => sourceId === hero.id).map(({ targetId }) => targetId));
  return entities.filter(({ id, kind }) => kind === ITEM_KIND && held.has(id));
};

const inventory = (hero: Character, source: ViewSource, locale: string) =>
  section(
    say(locale, 'view.inventory'),
    heldItems(hero, source).map(({ name }) => `  - ${name}`),
    say(locale, 'view.noItems'),
  );

const visibleEvents = ({ state, eventScopes }: ViewSource, viewer: Viewer) => {
  const shown = new Set(visibleTo(eventScopes, viewer).map(({ id }) => id));
  return state.events.filter(({ id }) => shown.has(id));
};

const isRetconned = ({ changes }: CampaignState) => oocStateOf(changes).retconned.length > 0;

export const encounterOf = (state: CampaignState, foldEvents: readonly FoldEvent[] = NO_FOLD_EVENTS) =>
  isRetconned(state) ? visibleFoldsOf(foldEvents).encounter : state.folds.gm.encounter;

const foldsFor = ({ state, foldEvents = NO_FOLD_EVENTS }: ViewSource, viewer: Viewer) =>
  isRetconned(state) ? visibleFoldsOf(visibleTo(foldEvents, viewer)) : audienceOf(state.folds, viewer);

const quests = (source: ViewSource, locale: string) => {
  const rows = foldsFor(source, PLAYER_VIEWER).quests.flatMap((quest) => [
    `  - ${quest.title} (${quest.status})`,
    ...quest.objectives.map(({ done, summary }) => `    ${done ? DONE : OPEN} ${summary}`),
  ]);
  return section(say(locale, 'view.quests'), rows, say(locale, 'view.noQuests'));
};

const signed = (value: number) => (value < 0 ? `${value}` : `+${value}`);

const rollText = (locale: string, { pool, draws, total }: RollEvent) => {
  const dice = pool.dice.map(({ count, sides }) => `${count}d${sides}`).join('+');
  const modifier = pool.modifier === 0 ? '' : signed(pool.modifier);
  return `    ${say(locale, 'view.roll')} ${dice}${modifier} [${draws.flat().join(LIST_SEPARATOR)}] = ${total}`;
};

const actionRows = (locale: string, name: string, { ruleId, modifiers, resolution }: EncounterAction) => {
  const applied = Object.entries(modifiers).map(([id, value]) => `${id} ${signed(value)}`);
  const results = resolution.ok
    ? resolution.events.map(({ event }) => event)
    : [say(locale, 'view.failed', { code: resolution.error.code })];
  const changes = resolution.ok ? resolution.changes.map(({ id, from, to }) => `${id} ${from} -> ${to}`) : [];
  return [
    `  - ${name}: ${ruleId}`,
    ...resolution.rolls.map((roll) => rollText(locale, roll)),
    ...(applied.length === 0 ? [] : [`    ${say(locale, 'view.modifiers')} ${applied.join(LIST_SEPARATOR)}`]),
    ...(results.length === 0 ? [] : [`    ${say(locale, 'view.result')} ${results.join(LIST_SEPARATOR)}`]),
    ...(changes.length === 0 ? [] : [`    ${say(locale, 'view.changes')} ${changes.join(LIST_SEPARATOR)}`]),
  ];
};

const encounter = (source: ViewSource, locale: string) => {
  const current = foldsFor(source, PLAYER_VIEWER).encounter;
  if (current === undefined) return say(locale, 'view.noEncounter');
  const names = new Map(source.state.characters.map(({ id, name }) => [id, name]));
  const rows = current.actions.flatMap((action) =>
    actionRows(locale, names.get(action.actorId) ?? action.actorId, action),
  );
  const outcome = current.outcome === undefined ? [] : [say(locale, 'view.outcome', { value: current.outcome })];
  const title = say(locale, 'view.encounter', { status: current.status, round: current.round });
  return [title, ...rows, ...outcome].join('\n');
};

export const JOURNAL_LINE_MAX = 80;

const turnText = (
  names: ReadonlyMap<string, string>,
  { actionId, actorId, input, narration, rollOfferId }: Turn,
  locale: string,
) => {
  if (actionId === OPENING_ACTION_ID) return narration;
  const said =
    rollOfferId === undefined
      ? `${names.get(actorId) ?? actorId}: ${input}`
      : say(locale, 'turn.rollAccepted', { label: input });
  return narration.trim() === '' ? said : `${said}${REPLY_SEPARATOR}${narration}`;
};

const namesOf = ({ characters }: CampaignState) => new Map(characters.map(({ id, name }) => [id, name]));

const FIRST_SENTENCE = /^.*?[.!?](?=\s|$)/s;
const ELLIPSIS = '…';
const WHITESPACE_RUN = /\s+/g;

const NPC_KIND: EntityKind = 'npc';
const PART_SEPARATOR = '; ';

const QUEST_OUTCOME_KEYS = new Map([
  [QUEST_COMPLETED, 'journal.questCompleted'],
  [QUEST_FAILED, 'journal.questFailed'],
  [QUEST_OBJECTIVE_COMPLETED, 'journal.objectiveCompleted'],
]);

const resolvedNamesOf = ({ payload }: CampaignEvent): readonly string[] => {
  const { resolution } = payload as { resolution?: { events?: readonly { event?: unknown }[] } };
  return (resolution?.events ?? []).flatMap(({ event }) => (typeof event === 'string' ? [event] : []));
};

const outcomeKeyOf = (event: CampaignEvent): string | undefined => {
  if (event.type !== CHECK_RESOLVED) return QUEST_OUTCOME_KEYS.get(event.type);
  const names = resolvedNamesOf(event);
  if (names.some((name) => HIT_EVENTS.includes(name))) return 'journal.hit';
  return names.some((name) => MISS_EVENTS.includes(name)) ? 'journal.miss' : undefined;
};

const introducedOf = ({ type, payload }: CampaignEvent) => {
  const { entity } = payload as { entity?: { kind?: unknown; name?: unknown } };
  return type === ENTITY_INTRODUCED && typeof entity?.name === 'string'
    ? [{ kind: entity.kind, name: entity.name.replace(WHITESPACE_RUN, ' ').trim() }]
    : [];
};

const eventSummary = (events: readonly CampaignEvent[], locale: string) => {
  const introduced = events.flatMap(introducedOf).filter(({ name }) => name !== '');
  const namesOfKind = (people: boolean) =>
    introduced
      .filter(({ kind }) => (kind === NPC_KIND) === people)
      .map(({ name }) => name)
      .join(LIST_SEPARATOR);
  const met = namesOfKind(true);
  const found = namesOfKind(false);
  const outcomes = events.flatMap((event) => outcomeKeyOf(event) ?? []).map((key) => say(locale, key));
  return [
    met === '' ? '' : say(locale, 'journal.met', { names: met }),
    found === '' ? '' : say(locale, 'journal.found', { names: found }),
    outcomes.join(LIST_SEPARATOR),
  ]
    .filter((part) => part !== '')
    .join(PART_SEPARATOR);
};

const narrationLine = (names: ReadonlyMap<string, string>, turn: Turn, locale: string) => {
  const narration = turn.narration.replace(WHITESPACE_RUN, ' ').trim();
  return narration === ''
    ? turnText(names, turn, locale).replace(WHITESPACE_RUN, ' ').trim()
    : (FIRST_SENTENCE.exec(narration)?.[0] ?? narration);
};

const journalLine = (names: ReadonlyMap<string, string>, turn: Turn, shown: CampaignState, locale: string) => {
  const summary = eventSummary(
    [...shown.events.filter(({ turnId }) => turnId === turn.id), ...proposalEventsOf(shown, turn.actionId)],
    locale,
  );
  const text = summary === '' ? narrationLine(names, turn, locale) : summary;
  const points = Array.from(text);
  return points.length <= JOURNAL_LINE_MAX
    ? text
    : `${points.slice(0, JOURNAL_LINE_MAX - ELLIPSIS.length).join('')}${ELLIPSIS}`;
};

const journal = (source: ViewSource, locale: string) => {
  const { state } = source;
  const names = namesOf(state);
  const shown = { ...state, events: visibleEvents(source, PLAYER_VIEWER) };
  const rows = playTurns(state)
    .map((turn) => journalLine(names, turn, shown, locale))
    .filter((line) => line !== '')
    .map((line, index) => `  ${index + 1}. ${line}`);
  return section(say(locale, 'view.journal'), rows, say(locale, 'view.noEvents'));
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
    quests: foldsFor(source, viewer).quests.map(({ id, title, status, objectives }) => ({
      id,
      title,
      status,
      objectives: objectives.map(({ summary, done }) => ({ summary, done })),
    })),
    citations: events.flatMap(citationOf),
    recap: {
      scene: state.currentScene?.title,
      latest:
        last === undefined
          ? undefined
          : turnText(namesOf(state), last, campaignLanguageOf(state.changes) ?? DEFAULT_LOCALE),
    },
  };
};

const renderStored = (view: ReadView, source: ViewSource, viewer: SheetViewer, locale: string): string => {
  if (view === 'journal') return journal(source, locale);
  if (view === 'quests') return quests(source, locale);
  if (view === 'encounter') return encounter(source, locale);
  const [hero] = source.state.characters;
  if (hero === undefined) return say(locale, 'view.noCharacter');
  if (view === 'sheet') return sheet(hero, source, viewer, locale);
  if (view === 'sheet-export') return sheetExport(hero, source, viewer, locale);
  return inventory(hero, { ...source, entities: visibleTo(source.entities, PLAYER_VIEWER) }, locale);
};

export const renderView = (
  view: ReadView,
  source: ViewSource,
  viewer: SheetViewer = PLAYER_OWNER,
  locale: string = DEFAULT_LOCALE,
): string => printable(renderStored(view, source, viewer, locale));
