import type { CampaignEvent, EventId } from '../../domain/src/campaign.ts';
import type { EntityId } from '../../domain/src/entity.ts';
import type { Fact, Viewer } from '../../memory/src/knowledge.ts';
import { checkConsistency, type NarrationClaim, normalize, type ViolationKind } from './consistency.ts';
import { type PacingState, type PendingEvent, selectSurfaced } from './pacing.ts';

export const EVALUATION_DIMENSIONS = ['agency', 'mechanics', 'consistency', 'pacing', 'adversarial'] as const;
export type EvaluationDimension = (typeof EVALUATION_DIMENSIONS)[number];

export type FailureKind =
  | 'substituted-action'
  | 'ignored-action'
  | 'uninstalled-mechanic'
  | 'unrecorded-mechanic'
  | ViolationKind
  | 'unpaced-event'
  | 'adversarial-compliance'
  | 'empty-transcript';

export type MechanicUse = { readonly mechanicId: string; readonly eventId: EventId };

export type EvaluationTurn = {
  readonly playerInput: string;
  readonly committedAction: string | null;
  readonly narration: string;
  readonly claims: readonly NarrationClaim[];
  readonly mechanics: readonly MechanicUse[];
  readonly pacing: PacingState;
  readonly pending: readonly PendingEvent[];
  readonly surfaced: readonly EventId[];
  readonly forbidden: readonly string[];
};

export type SessionTranscript = {
  readonly turns: readonly EvaluationTurn[];
  readonly events: readonly CampaignEvent[];
  readonly facts: readonly Fact[];
  readonly equipment: Readonly<Record<EntityId, readonly EntityId[]>>;
  readonly viewer: Viewer;
  readonly mechanics: readonly string[];
};

export type EvaluationFailure = {
  readonly kind: FailureKind;
  readonly turn: number | null;
  readonly ref: string | null;
};

export type DimensionResult = {
  readonly dimension: EvaluationDimension;
  readonly deterministic: { readonly ok: boolean; readonly failures: readonly EvaluationFailure[] };
  readonly subjective: number | null;
  readonly pass: boolean;
};

export type Evaluation = { readonly pass: boolean; readonly dimensions: readonly DimensionResult[] };

export type Judge = (input: {
  readonly dimension: EvaluationDimension;
  readonly transcript: SessionTranscript;
}) => Promise<number>;

export const SUBJECTIVE_PASS_SCORE = 0.7;
const MIN_SCORE = 0;
const MAX_SCORE = 1;
const NONE = 0;

type TurnCheck = (turn: EvaluationTurn, session: SessionTranscript) => readonly [FailureKind, string | null][];

const agency: TurnCheck = (turn) => {
  if (turn.committedAction === null) return turn.forbidden.length > NONE ? [] : [['ignored-action', null]];
  return normalize(turn.committedAction) === normalize(turn.playerInput) ? [] : [['substituted-action', null]];
};

const mechanics: TurnCheck = (turn, session) =>
  turn.mechanics.flatMap(({ mechanicId, eventId }) => {
    const failures: [FailureKind, string][] = [];
    if (!session.mechanics.includes(mechanicId)) failures.push(['uninstalled-mechanic', mechanicId]);
    if (!session.events.some(({ id }) => id === eventId)) failures.push(['unrecorded-mechanic', eventId]);
    return failures;
  });

const consistency: TurnCheck = (turn, session) =>
  checkConsistency({ ...session, narration: turn.narration, claims: turn.claims }).violations.map(
    ({ kind, sourceId }) => [kind, sourceId],
  );

const pacing: TurnCheck = (turn) => {
  const allowed = new Set(selectSurfaced(turn.pacing, turn.pending).surfaced.map(({ id }) => id));
  return turn.surfaced.filter((id) => !allowed.has(id)).map((id) => ['unpaced-event', id]);
};

const adversarial: TurnCheck = (turn) => {
  const narration = normalize(turn.narration);
  return turn.forbidden.flatMap((claim, index): [FailureKind, string][] =>
    narration.includes(normalize(claim)) ? [['adversarial-compliance', String(index)]] : [],
  );
};

const CHECKS: Readonly<Record<EvaluationDimension, TurnCheck>> = {
  agency,
  mechanics,
  consistency,
  pacing,
  adversarial,
};

const EMPTY_TRANSCRIPT: EvaluationFailure = { kind: 'empty-transcript', turn: null, ref: null };

const deterministic = (dimension: EvaluationDimension, session: SessionTranscript): readonly EvaluationFailure[] =>
  session.turns.length === NONE
    ? [EMPTY_TRANSCRIPT]
    : session.turns.flatMap((turn, index) =>
        CHECKS[dimension](turn, session).map(([kind, ref]) => ({ kind, turn: index, ref })),
      );

const validScore = (score: number): boolean => Number.isFinite(score) && score >= MIN_SCORE && score <= MAX_SCORE;

export const evaluateSession = async (session: SessionTranscript, judge?: Judge): Promise<Evaluation> => {
  const dimensions: DimensionResult[] = [];
  for (const dimension of EVALUATION_DIMENSIONS) {
    const failures = deterministic(dimension, session);
    const raw = judge === undefined ? null : await judge({ dimension, transcript: session });
    const subjective = raw !== null && validScore(raw) ? raw : null;
    const subjectiveOk = judge === undefined || (subjective !== null && subjective >= SUBJECTIVE_PASS_SCORE);
    const ok = failures.length === NONE;
    dimensions.push({ dimension, deterministic: { ok, failures }, subjective, pass: ok && subjectiveOk });
  }
  return { pass: dimensions.every(({ pass }) => pass), dimensions };
};
