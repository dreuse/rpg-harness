import { SIMULATION_MODES, type SimulationMode } from '../../domain/src/simulation.ts';

export { SIMULATION_MODES, type SimulationMode };
export const DEFAULT_MODE: SimulationMode = 'off';
export const DEFAULT_MAX_ACTORS = 8;
export const DEFAULT_MAX_ACTIONS = 8;
export const MAX_BUDGET = 1000;
export const MIN_BUDGET = 1;
export const MIN_KNOB = 0;
export const MAX_KNOB = 1;
export const KNOB_FIELDS = ['worldAutonomy', 'storyIntensity', 'consequenceSeverity'] as const;
export const MALFORMED_ACTION = 'malformed action';
export const ACTION_BUDGET_EXCEEDED = 'action budget exceeded';
export const ACTOR_BUDGET_EXCEEDED = 'actor budget exceeded';
const KNOB_LOW = 0.25;
const KNOB_MID = 0.5;
const KNOB_HIGH = 0.75;

export type Trigger =
  | { readonly kind: 'tick'; readonly at: number }
  | { readonly kind: 'interval'; readonly every: number; readonly from: number }
  | { readonly kind: 'event'; readonly eventType: string };
export type AttentionBudget = { readonly maxActors: number; readonly maxActions: number };
export type WorldConfig = {
  readonly mode: SimulationMode;
  readonly budget: AttentionBudget;
  readonly triggers: readonly Trigger[];
  readonly worldAutonomy?: number;
  readonly storyIntensity?: number;
  readonly consequenceSeverity?: number;
};
export type ActorAction = {
  readonly actionId: string;
  readonly actorId: string;
  readonly kind: string;
  readonly knowledgeRefs: readonly string[];
  readonly tick: number;
};
export type Knobs = { readonly [K in (typeof KNOB_FIELDS)[number]]: number };
export type SimulationDiagnostics = {
  readonly mode: SimulationMode;
  readonly knobs: Knobs;
  readonly budget: AttentionBudget;
  readonly applied: readonly string[];
  readonly skipped: readonly { readonly actionId: string | null; readonly reason: string }[];
};
export type LogicalClock = { readonly tick: number; readonly events: readonly string[] };
export type Rejection = { readonly action: ActorAction; readonly reason: string };
export type ConfigResult =
  | { ok: true; config: WorldConfig }
  | { ok: false; issues: { path: string; message: string }[] };

export const DEFAULT_WORLD_CONFIG: WorldConfig = {
  mode: DEFAULT_MODE,
  budget: { maxActors: DEFAULT_MAX_ACTORS, maxActions: DEFAULT_MAX_ACTIONS },
  triggers: [],
};

const knobsAt = (value: number): Knobs => ({ worldAutonomy: value, storyIntensity: value, consequenceSeverity: value });
export const MODE_KNOBS: Readonly<Record<Exclude<SimulationMode, 'custom'>, Knobs>> = {
  off: knobsAt(MIN_KNOB),
  ambient: knobsAt(KNOB_LOW),
  balanced: knobsAt(KNOB_MID),
  dynamic: knobsAt(KNOB_HIGH),
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isTick = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isBudgetValue = (v: unknown): v is number =>
  Number.isInteger(v) && (v as number) >= MIN_BUDGET && (v as number) <= MAX_BUDGET;
const isKnob = (v: unknown): v is number => typeof v === 'number' && v >= MIN_KNOB && v <= MAX_KNOB;
const isPositiveSafeInteger = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

const parseTrigger = (raw: unknown, path: string, issues: { path: string; message: string }[]) => {
  if (isRecord(raw)) {
    if (raw.kind === 'tick' && isTick(raw.at)) return { kind: 'tick', at: raw.at } as const;
    if (raw.kind === 'interval' && isPositiveSafeInteger(raw.every) && (raw.from === undefined || isTick(raw.from)))
      return { kind: 'interval', every: raw.every, from: raw.from ?? 0 } as const;
    if (raw.kind === 'event' && isNonEmpty(raw.eventType)) return { kind: 'event', eventType: raw.eventType } as const;
  }
  issues.push({ path, message: 'must be a logical-time trigger' });
  return undefined;
};

export const resolveWorldConfig = (input: unknown): ConfigResult => {
  if (input === undefined) return { ok: true, config: DEFAULT_WORLD_CONFIG };
  const issues: { path: string; message: string }[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: '$', message: 'must be an object' }] };
  const mode = input.mode ?? DEFAULT_MODE;
  if (!SIMULATION_MODES.includes(mode as SimulationMode)) issues.push({ path: 'mode', message: 'unknown mode' });
  const rawBudget = input.budget ?? {};
  const budget = { ...DEFAULT_WORLD_CONFIG.budget, ...(isRecord(rawBudget) ? rawBudget : { maxActors: undefined }) };
  if (!isBudgetValue(budget.maxActors))
    issues.push({ path: 'budget.maxActors', message: 'must be a bounded positive integer' });
  if (!isBudgetValue(budget.maxActions))
    issues.push({ path: 'budget.maxActions', message: 'must be a bounded positive integer' });
  const knobs: Partial<Record<(typeof KNOB_FIELDS)[number], number>> = {};
  for (const field of KNOB_FIELDS) {
    if (input[field] === undefined) continue;
    if (isKnob(input[field])) knobs[field] = input[field];
    else issues.push({ path: field, message: 'must be a number between 0 and 1' });
  }
  const rawTriggers = input.triggers ?? [];
  const triggers: Trigger[] = [];
  if (!Array.isArray(rawTriggers)) issues.push({ path: 'triggers', message: 'must be an array' });
  else
    rawTriggers.forEach((raw, i) => {
      const trigger = parseTrigger(raw, `triggers[${i}]`, issues);
      if (trigger) triggers.push(trigger);
    });
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    config: {
      mode: mode as SimulationMode,
      budget: { maxActors: budget.maxActors as number, maxActions: budget.maxActions as number },
      triggers,
      ...knobs,
    },
  };
};

const fires = (trigger: Trigger, clock: LogicalClock) => {
  if (trigger.kind === 'tick') return clock.tick === trigger.at;
  if (trigger.kind === 'interval')
    return clock.tick >= trigger.from && (clock.tick - trigger.from) % trigger.every === 0;
  return clock.events.includes(trigger.eventType);
};

export const firingTriggers = (config: WorldConfig, clock: LogicalClock): Trigger[] =>
  config.mode === 'off' ? [] : config.triggers.filter((t) => fires(t, clock));

export const isActorAction = (v: unknown): v is ActorAction =>
  isRecord(v) &&
  isNonEmpty(v.actionId) &&
  isNonEmpty(v.actorId) &&
  isNonEmpty(v.kind) &&
  isTick(v.tick) &&
  Array.isArray(v.knowledgeRefs) &&
  v.knowledgeRefs.every(isNonEmpty);

export const admitProposals = (config: WorldConfig, proposals: readonly ActorAction[]) => {
  const accepted: ActorAction[] = [];
  const rejected: Rejection[] = [];
  const actors = new Set<string>();
  const ids = new Set<string>();
  for (const action of proposals) {
    const reject = (reason: string) => rejected.push({ action, reason });
    if (config.mode === 'off') reject('world simulation is off');
    else if (!isActorAction(action)) reject(MALFORMED_ACTION);
    else if (action.knowledgeRefs.length === 0) reject('missing knowledge refs');
    else if (ids.has(action.actionId)) reject('duplicate action id');
    else if (accepted.length >= config.budget.maxActions) reject(ACTION_BUDGET_EXCEEDED);
    else if (!actors.has(action.actorId) && actors.size >= config.budget.maxActors) reject(ACTOR_BUDGET_EXCEEDED);
    else {
      ids.add(action.actionId);
      actors.add(action.actorId);
      accepted.push(action);
    }
  }
  return { accepted, rejected };
};

const effectiveKnobs = (config: WorldConfig): Knobs => {
  if (config.mode !== 'custom') return MODE_KNOBS[config.mode];
  const base = MODE_KNOBS.balanced;
  return Object.fromEntries(KNOB_FIELDS.map((field) => [field, config[field] ?? base[field]])) as Knobs;
};

export const simulationDiagnostics = (
  config: WorldConfig,
  admission: { readonly accepted: readonly ActorAction[]; readonly rejected: readonly Rejection[] },
): SimulationDiagnostics => ({
  mode: config.mode,
  knobs: effectiveKnobs(config),
  budget: config.budget,
  applied: admission.accepted.map(({ actionId }) => actionId),
  skipped: admission.rejected.map(({ action, reason }) => ({
    actionId: isRecord(action) && isNonEmpty(action.actionId) ? action.actionId : null,
    reason,
  })),
});
