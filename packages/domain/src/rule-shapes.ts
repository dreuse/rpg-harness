import type { CharacterId } from './campaign.ts';

export type ManifestIssue = { path: string; message: string };

export const SUPPORTED_PRIMITIVES = [
  'random',
  'comparison',
  'arithmetic',
  'modifier',
  'resourceCost',
  'condition',
  'actionOrder',
  'decision',
  'transition',
  'effects',
] as const;

export type Primitive = (typeof SUPPORTED_PRIMITIVES)[number];

export const ROLL_EVENT_TYPE = 'roll.resolved';

export type DieTerm = { readonly count: number; readonly sides: number };
export type DicePool = { readonly dice: readonly DieTerm[]; readonly modifier: number };
export type RollEvent = {
  readonly type: typeof ROLL_EVENT_TYPE;
  readonly rollId: string;
  readonly pool: DicePool;
  readonly draws: readonly (readonly number[])[];
  readonly total: number;
};

export const DERIVED_OPS = ['sum', 'min', 'max'] as const;

export type DerivedOp = (typeof DERIVED_OPS)[number];
export type TraitValue = string | number | boolean;

export type Trait =
  | { id: string; kind: 'trait'; value: TraitValue }
  | { id: string; kind: 'resource'; current: number; max: number }
  | { id: string; kind: 'tag' }
  | { id: string; kind: 'condition'; stacks?: number; remaining?: number }
  | { id: string; kind: 'derived'; op: DerivedOp; refs: string[]; offset: number };

export type TraitSheet = { characterId: CharacterId; traits: Trait[] };

export const RESOLUTION_ERROR_CODES = [
  'InvalidAction',
  'PreconditionFailed',
  'InsufficientResource',
  'UnknownReference',
  'InvalidAmount',
  'RollFailed',
] as const;

export type ResolutionErrorCode = (typeof RESOLUTION_ERROR_CODES)[number];
export type ResolutionError = { code: ResolutionErrorCode; issues: ManifestIssue[] };
export type TraitChange = { id: string; from: TraitValue; to: TraitValue };
export type RuleEvent = { actionId: string; ruleId: string; event: string };

export const RULE_DSL_VERSION = 1;
export const INVALID_RULE_DSL = 'InvalidRuleDsl';
export const GM_ADJUDICATED = 'gm-adjudicated';
export const ARITH_OPS = ['add', 'sub', 'mul', 'min', 'max'] as const;
export const COMPARE_OPS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'] as const;
export const KEEP_WHICH = ['highest', 'lowest'] as const;

export type ArithOp = (typeof ARITH_OPS)[number];
export type CompareOp = (typeof COMPARE_OPS)[number];
export type KeepWhich = (typeof KEEP_WHICH)[number];

export type DiceKeep = { which: KeepWhich; count: number };

export type NumberExpr =
  | { kind: 'const'; value: number }
  | { kind: 'dice'; count: number; sides: number; modifier: number; keep?: DiceKeep }
  | { kind: 'ref'; id: string }
  | { kind: 'arith'; op: ArithOp; left: NumberExpr; right: NumberExpr };

export type Condition =
  | { kind: 'compare'; op: CompareOp; left: NumberExpr; right: NumberExpr }
  | { kind: 'and'; all: Condition[] }
  | { kind: 'or'; any: Condition[] }
  | { kind: 'not'; condition: Condition };

export type ResourceCost = { kind: 'cost'; resource: string; amount: NumberExpr };

export type RuleEffect =
  | { kind: 'adjustResource'; resource: string; amount: NumberExpr }
  | { kind: 'setTrait'; trait: string; value: string | boolean | NumberExpr }
  | { kind: 'emitEvent'; event: string };

export type RuleDsl = {
  dslVersion: typeof RULE_DSL_VERSION;
  id: string;
  when?: Condition;
  costs?: ResourceCost[];
  effects: RuleEffect[];
};

export type InvalidRuleDsl = { code: typeof INVALID_RULE_DSL; issues: ManifestIssue[] };
export type CapabilityDisabled = { code: 'CapabilityDisabled'; issues: ManifestIssue[] };
export type RulePackPin = { id: string; edition: string; revision: string };

export type CompiledRule = Readonly<{
  rule: RuleDsl;
  rulePack: RulePackPin;
  sourceRefs: readonly string[];
  primitives: readonly Primitive[];
  adjudicated: readonly Primitive[];
  deterministic: boolean;
}>;
export type AdjudicationReason = 'AdjudicatedCapability' | CapabilityDisabled['code'] | InvalidRuleDsl['code'];
export type MechanicSource = Readonly<{
  kind: string;
  sourceRef: string;
  revision: string;
  overlayHash?: string;
  depth?: number;
}>;
export type EffectiveMechanic = Readonly<{
  ruleId: string;
  rulePack: CompiledRule['rulePack'];
  source: MechanicSource;
}> &
  (
    | Readonly<{ kind: 'deterministic'; rule: CompiledRule }>
    | Readonly<{ kind: typeof GM_ADJUDICATED; reason: AdjudicationReason; issues: readonly ManifestIssue[] }>
  );
