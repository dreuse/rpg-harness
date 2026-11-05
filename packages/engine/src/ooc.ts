import { randomUUID } from 'node:crypto';
import {
  type CampaignEvent,
  type CampaignState,
  type CampaignStore,
  CHECK_RESOLVED,
  MAIN_BRANCH,
  OPENING_ACTION_ID,
  StaleRevisionError,
  SYSTEM_TURN,
  type Turn,
} from '../../domain/src/campaign.ts';
import {
  OOC_PROPOSAL_KINDS,
  OOC_STATE_SAVED,
  type OocApplied,
  type OocProposal,
  type OocProposalKind,
  ROLL_CORRECTED,
} from '../../domain/src/ooc.ts';
import { MAX_MODIFIER_TEXT_LENGTH, MAX_MODIFIER_VALUE } from '../../rules/src/modifiers.ts';
import { isRecord } from '../../rules/src/rulepack.ts';
import { commitSystem, InvalidActionError, loadState, requireValid } from './turn.ts';

export { OOC_STATE_SAVED, ROLL_CORRECTED };

export const MAX_TABLE_NOTES = 8;
export const MAX_TABLE_NOTE_LENGTH = 200;
export const MAX_HOUSE_RULES = 20;
export const MAX_HOUSE_RULE_ID_LENGTH = 60;
export const MAX_HOUSE_RULE_LENGTH = 2000;
export const MAX_OOC_SUMMARY_LENGTH = 200;
export const MAX_OOC_JOURNAL = 50;
export const OOC_CORRECTION_INPUT = 'GM correction ';
export const ROLL_FIX_ACTION_SUFFIX = ':roll-fix';

const LINE_BREAK = /[\r\n]/;
const CORRECTABLE_ROLL_EVENTS: readonly string[] = [CHECK_RESOLVED, ROLL_CORRECTED];
const NOT_FOUND = -1;

type Fields = Readonly<Record<string, unknown>>;
export type JournalEntry = {
  readonly id: string;
  readonly kind: OocProposalKind;
  readonly summary: string;
  readonly undone?: true;
  readonly note?: string;
  readonly ruleId?: string;
  readonly turnIds?: readonly string[];
};
export type OocState = {
  readonly notes: readonly string[];
  readonly houseRules: readonly Fields[];
  readonly retconned: readonly string[];
  readonly journal: readonly JournalEntry[];
};

export const EMPTY_OOC_STATE: OocState = { notes: [], houseRules: [], retconned: [], journal: [] };

export type RollFix = { readonly value: number; readonly reason: string };
export type RollCorrector = (resolution: unknown, fix: RollFix) => unknown;
export type OocApplication = {
  readonly campaignId: string;
  readonly actionId: string;
  readonly expectedRevision: number;
  readonly proposal: unknown;
  readonly correctRoll?: RollCorrector;
};
export type OocUndo = Omit<OocApplication, 'proposal' | 'correctRoll'>;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const journalEntryOf = (value: unknown): JournalEntry[] =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.summary === 'string' &&
  OOC_PROPOSAL_KINDS.some((kind) => kind === value.kind)
    ? [value as JournalEntry]
    : [];

export const oocStateOf = (changes: readonly Pick<CampaignEvent, 'type' | 'payload'>[]): OocState => {
  const saved = changes.findLast(({ type }) => type === OOC_STATE_SAVED)?.payload.state;
  if (!isRecord(saved)) return EMPTY_OOC_STATE;
  return {
    notes: strings(saved.notes),
    houseRules: Array.isArray(saved.houseRules) ? saved.houseRules.filter(isRecord) : [],
    retconned: strings(saved.retconned),
    journal: Array.isArray(saved.journal) ? saved.journal.flatMap(journalEntryOf) : [],
  };
};

export const withoutRetconned = (state: CampaignState): CampaignState => {
  const { retconned } = oocStateOf(state.changes);
  if (retconned.length === 0) return state;
  const hidden = new Set(retconned);
  return {
    ...state,
    turns: state.turns.filter(({ id }) => !hidden.has(id)),
    events: state.events.filter(({ turnId }) => !hidden.has(turnId)),
  };
};

const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim() !== '' && value.length <= max ? value.trim() : undefined;

const proposalOf = (actionId: string, input: unknown): OocProposal => {
  const invalid = (reason: string) => new InvalidActionError(actionId, reason);
  if (!isRecord(input)) throw invalid('proposal must be an object');
  const summary = text(input.summary, MAX_OOC_SUMMARY_LENGTH);
  if (summary === undefined) throw invalid('proposal needs a short summary');
  if (input.kind === 'retcon_last_turn') return { kind: input.kind, summary };
  if (input.kind === 'table_note') {
    const note = text(input.note, MAX_TABLE_NOTE_LENGTH);
    if (note === undefined || LINE_BREAK.test(note)) throw invalid('table note must be one short line');
    return { kind: input.kind, summary, note };
  }
  if (input.kind === 'house_rule') {
    const { rule } = input;
    if (!isRecord(rule) || text(rule.id, MAX_HOUSE_RULE_ID_LENGTH) === undefined)
      throw invalid('house rule needs a short id');
    if (JSON.stringify(rule).length > MAX_HOUSE_RULE_LENGTH) throw invalid('house rule is too large');
    const note = isRecord(rule.source) ? rule.source.note : undefined;
    if (note !== undefined && (text(note, MAX_TABLE_NOTE_LENGTH) === undefined || LINE_BREAK.test(String(note))))
      throw invalid('house rule source note must be one short line');
    return { kind: input.kind, summary, rule };
  }
  if (input.kind === 'roll_fix') {
    const reason = text(input.reason, MAX_MODIFIER_TEXT_LENGTH);
    const { value } = input;
    if (reason === undefined) throw invalid('roll fix needs a reason');
    if (!Number.isInteger(value) || value === 0 || Math.abs(value as number) > MAX_MODIFIER_VALUE)
      throw invalid(`roll fix needs a non-zero integer within ±${MAX_MODIFIER_VALUE}`);
    return { kind: input.kind, summary, reason, value: value as number };
  }
  throw invalid('unknown proposal kind');
};

const lastPlayTurn = (state: CampaignState, actionId: string) => {
  const index = state.turns.findLastIndex(({ kind, actionId: id }) => kind !== SYSTEM_TURN && id !== OPENING_ACTION_ID);
  if (index === NOT_FOUND) throw new InvalidActionError(actionId, 'there is no turn to correct');
  return { index, turns: state.turns.slice(index) as readonly Turn[] };
};

const save = (
  store: CampaignStore,
  campaignId: string,
  actionId: string,
  expectedRevision: number,
  state: OocState,
) => {
  const journal = state.journal.slice(-MAX_OOC_JOURNAL);
  store.recordChange({
    expectedRevision,
    event: {
      id: randomUUID(),
      campaignId,
      branchId: MAIN_BRANCH,
      actionId,
      type: OOC_STATE_SAVED,
      payload: { state: { ...state, journal } },
    },
  });
};

const requireRevision = (state: CampaignState, expectedRevision: number) => {
  if (state.revision !== expectedRevision) throw new StaleRevisionError(expectedRevision, state.revision);
};

export const applyOocProposal = (store: CampaignStore, application: OocApplication): OocApplied => {
  const { campaignId, actionId, expectedRevision } = application;
  const raw = loadState(store, campaignId);
  const done = oocStateOf(raw.changes).journal.find(({ id }) => id === actionId);
  if (done !== undefined) return { revision: raw.revision, summary: done.summary };
  requireRevision(raw, expectedRevision);
  const proposal = proposalOf(actionId, application.proposal);
  const ooc = oocStateOf(raw.changes);
  const visible = withoutRetconned(raw);
  const entry = { id: actionId, kind: proposal.kind, summary: proposal.summary };
  const journaled = (extra: Partial<OocState>, details: Fields = {}): OocState => ({
    ...ooc,
    ...extra,
    journal: [...ooc.journal, { ...entry, ...details } as JournalEntry],
  });
  if (proposal.kind === 'table_note') {
    const { note } = proposal;
    requireValid(actionId, ooc.notes.length < MAX_TABLE_NOTES, `at most ${MAX_TABLE_NOTES} table notes`);
    requireValid(actionId, !ooc.notes.includes(note), 'this table note already exists');
    save(store, campaignId, actionId, expectedRevision, journaled({ notes: [...ooc.notes, note] }, { note }));
  } else if (proposal.kind === 'house_rule') {
    const ruleId = proposal.rule.id as string;
    requireValid(actionId, ooc.houseRules.length < MAX_HOUSE_RULES, `at most ${MAX_HOUSE_RULES} house rules`);
    requireValid(
      actionId,
      ooc.houseRules.every(({ id }) => id !== ruleId),
      `house rule ${ruleId} is already applied`,
    );
    save(
      store,
      campaignId,
      actionId,
      expectedRevision,
      journaled({ houseRules: [...ooc.houseRules, proposal.rule] }, { ruleId }),
    );
  } else if (proposal.kind === 'retcon_last_turn') {
    const turnIds = lastPlayTurn(visible, actionId).turns.map(({ id }) => id);
    save(
      store,
      campaignId,
      actionId,
      expectedRevision,
      journaled({ retconned: [...ooc.retconned, ...turnIds] }, { turnIds }),
    );
  } else {
    const { index, turns } = lastPlayTurn(visible, actionId);
    const ids = new Set(turns.map(({ id }) => id));
    const source = visible.events.findLast(
      ({ type, turnId }) => CORRECTABLE_ROLL_EVENTS.includes(type) && ids.has(turnId),
    );
    if (source === undefined) throw new InvalidActionError(actionId, 'the last turn has no roll to correct');
    const resolution = application.correctRoll?.(source.payload.resolution, {
      value: proposal.value,
      reason: proposal.reason,
    });
    if (resolution === undefined) throw new InvalidActionError(actionId, 'the last roll cannot be corrected');
    const actor = visible.turns[index] as Turn;
    commitSystem(
      store,
      {
        campaignId,
        actionId: `${actionId}${ROLL_FIX_ACTION_SUFFIX}`,
        expectedRevision,
        sceneId: raw.currentScene?.id ?? actor.sceneId,
        actorId: actor.actorId,
        input: `${OOC_CORRECTION_INPUT}${proposal.kind}`,
        intent: `${OOC_CORRECTION_INPUT}${proposal.kind}`,
      },
      [[ROLL_CORRECTED, { correctsEventId: source.id, reason: proposal.reason, resolution }, 'player']],
    );
    save(store, campaignId, actionId, expectedRevision + 1, journaled({}));
  }
  return { revision: loadState(store, campaignId).revision, summary: proposal.summary };
};

export const undoOocChange = (
  store: CampaignStore,
  { campaignId, actionId, expectedRevision }: OocUndo,
): OocApplied => {
  const raw = loadState(store, campaignId);
  requireRevision(raw, expectedRevision);
  const ooc = oocStateOf(raw.changes);
  const index = ooc.journal.findLastIndex(({ undone }) => undone !== true);
  const entry = ooc.journal[index];
  if (entry === undefined) throw new InvalidActionError(actionId, 'there is no change to undo');
  const turnIds =
    entry.kind === 'roll_fix'
      ? [store.findTurn(campaignId, `${entry.id}${ROLL_FIX_ACTION_SUFFIX}`)?.turn.id ?? ''].filter(Boolean)
      : (entry.turnIds ?? []);
  const reverted: Partial<OocState> = {
    notes: entry.kind === 'table_note' ? ooc.notes.filter((note) => note !== entry.note) : ooc.notes,
    houseRules: entry.kind === 'house_rule' ? ooc.houseRules.filter(({ id }) => id !== entry.ruleId) : ooc.houseRules,
    retconned:
      entry.kind === 'retcon_last_turn'
        ? ooc.retconned.filter((id) => !turnIds.includes(id))
        : entry.kind === 'roll_fix'
          ? [...ooc.retconned, ...turnIds]
          : ooc.retconned,
  };
  const journal = ooc.journal.map((item, position) => (position === index ? { ...item, undone: true as const } : item));
  save(store, campaignId, actionId, expectedRevision, { ...ooc, ...reverted, journal });
  return { revision: loadState(store, campaignId).revision, summary: entry.summary };
};
