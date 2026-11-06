import type { RulesStrictness } from '../../domain/src/rules-usage.ts';
import type { ManifestIssue } from './rulepack.ts';

export const MAX_MODIFIERS = 6;
export const MAX_MODIFIER_VALUE = 10;
export const MAX_MODIFIER_TEXT_LENGTH = 120;
export const MIN_DURATION = 1;
export const MAX_CONDITION_DURATION = 20;
export const DURATION_UNITS = ['turns', 'scenes'] as const;
export const KEEP_MODES = ['highest', 'lowest'] as const;

export type DurationUnit = (typeof DURATION_UNITS)[number];
export type KeepMode = (typeof KEEP_MODES)[number];
export type EffectKind = ModifierEffect['kind'];
export type ModifierEffect =
  | { readonly kind: 'flat'; readonly value: number }
  | { readonly kind: 'dice'; readonly count: number }
  | { readonly kind: 'keep'; readonly which: KeepMode }
  | { readonly kind: 'step'; readonly steps: number };
export type ModifierDef = { readonly id: string; readonly label: string; readonly effect: ModifierEffect };
export type ConditionDuration = { readonly unit: DurationUnit; readonly count: number };
export type ConditionDef = {
  readonly id: string;
  readonly label: string;
  readonly modifiers: readonly string[];
  readonly appliesTo?: readonly string[];
  readonly duration: ConditionDuration;
};
export type ModifierVocabulary = {
  readonly modifiers: readonly ModifierDef[];
  readonly conditions: readonly ConditionDef[];
  readonly difficulties: Readonly<Record<string, number>>;
  readonly effects: readonly EffectKind[];
};
export type ModifierRequest = {
  readonly id: string;
  readonly reason: string;
  readonly sourceRule?: string;
  readonly value?: number;
};
export type AppliedModifier = {
  readonly id: string;
  readonly reason: string;
  readonly sourceRule?: string;
  readonly effect: ModifierEffect;
  readonly condition?: string;
};
export type ModifierSummary = { flat: number; dice: number; step?: number; keep?: KeepMode };
export type ModifierResolution = { ok: true; applied: AppliedModifier[] } | { ok: false; issues: ManifestIssue[] };

export const NO_VOCABULARY: ModifierVocabulary = { modifiers: [], conditions: [], difficulties: {}, effects: ['flat'] };

const isReason = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '' && value.length <= MAX_MODIFIER_TEXT_LENGTH;

const isBoundedInteger = (value: unknown): value is number =>
  Number.isInteger(value) && Math.abs(value as number) <= MAX_MODIFIER_VALUE;

const appliedOf = (request: ModifierRequest, effect: ModifierEffect): AppliedModifier => ({
  id: request.id,
  reason: request.reason,
  ...(request.sourceRule === undefined ? {} : { sourceRule: request.sourceRule }),
  effect,
});

const effectOf = (
  request: ModifierRequest,
  vocabulary: ModifierVocabulary,
  strictness: RulesStrictness,
  path: string,
): ModifierEffect | ManifestIssue => {
  const declared = vocabulary.modifiers.find(({ id }) => id === request.id);
  if (declared !== undefined) {
    const { effect } = declared;
    return effect.kind === 'step' && !isBoundedInteger(effect.steps)
      ? { path, message: `modifier ${request.id} step must be an integer within ±${MAX_MODIFIER_VALUE}` }
      : effect;
  }
  if (strictness === 'as-written') return { path, message: `modifier ${request.id} is not in the rulepack` };
  if (!isBoundedInteger(request.value)) {
    return { path: `${path}.value`, message: `must be an integer within ±${MAX_MODIFIER_VALUE}` };
  }
  return { kind: 'flat', value: request.value };
};

export const resolveModifiers = (
  vocabulary: ModifierVocabulary,
  requests: readonly ModifierRequest[],
  strictness: RulesStrictness,
  applicable: readonly EffectKind[] = vocabulary.effects,
  cites?: (rule: string) => boolean,
): ModifierResolution => {
  if (requests.length > MAX_MODIFIERS) {
    return { ok: false, issues: [{ path: 'modifiers', message: `at most ${MAX_MODIFIERS} modifiers` }] };
  }
  const issues: ManifestIssue[] = [];
  const applied: AppliedModifier[] = [];
  requests.forEach((request, index) => {
    const path = `modifiers.${index}`;
    if (!isReason(request.reason)) {
      issues.push({ path: `${path}.reason`, message: `must be 1 to ${MAX_MODIFIER_TEXT_LENGTH} characters` });
      return;
    }
    if (request.sourceRule !== undefined && cites?.(request.sourceRule) === false) {
      issues.push({ path: `${path}.sourceRule`, message: `rule ${request.sourceRule} is not in the imported rules` });
      return;
    }
    const effect = effectOf(request, vocabulary, strictness, path);
    if ('message' in effect) issues.push(effect);
    else if (!applicable.includes(effect.kind)) {
      issues.push({ path, message: `modifier ${request.id} has a ${effect.kind} effect these checks cannot apply` });
    } else applied.push(appliedOf(request, effect));
  });
  return issues.length > 0 ? { ok: false, issues } : { ok: true, applied };
};

export const summarizeModifiers = (applied: readonly { readonly effect: ModifierEffect }[]): ModifierSummary => {
  let flat = 0;
  let dice = 0;
  let step = 0;
  const kept = new Set<KeepMode>();
  for (const { effect } of applied) {
    if (effect.kind === 'flat') flat += effect.value;
    else if (effect.kind === 'dice') dice += effect.count;
    else if (effect.kind === 'step') step += effect.steps;
    else kept.add(effect.which);
  }
  const [only] = kept.size === 1 ? kept : [];
  return { flat, dice, ...(step === 0 ? {} : { step }), ...(only === undefined ? {} : { keep: only }) };
};

export const applicableModifiers = <T extends { readonly effect: ModifierEffect }>(
  modifiers: readonly T[],
  applicable: readonly EffectKind[],
): T[] => modifiers.filter(({ effect }) => applicable.includes(effect.kind));
