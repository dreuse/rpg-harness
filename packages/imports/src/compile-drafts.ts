import { compileRule } from '../../rules/src/compile.ts';
import type { CapabilityDisabled, CompiledRule, InvalidRuleDsl } from '../../rules/src/dsl.ts';
import type { RulePackManifest } from '../../rules/src/rulepack.ts';
import type { DraftMechanic } from './interpretation.ts';

export const PLUGIN_MECHANIC_KINDS = ['card', 'token', 'custom'] as const;
export type PluginMechanicKind = (typeof PLUGIN_MECHANIC_KINDS)[number];

export type MechanicDraft = DraftMechanic & { readonly kind?: PluginMechanicKind };
export type ApprovedPlugin = { readonly id: string; readonly kinds: readonly PluginMechanicKind[] };

export type UnsupportedReason = 'needs_plugin' | 'flagged' | 'missing_rule' | 'compile_failed';
export type UnsupportedMechanic = {
  reason: UnsupportedReason;
  draft: MechanicDraft;
  error?: InvalidRuleDsl | CapabilityDisabled;
};
export type DraftCompilation = {
  compiled: { rule: CompiledRule; draft: MechanicDraft }[];
  plugins: { pluginId: string; draft: MechanicDraft }[];
  unsupported: UnsupportedMechanic[];
};

export const compileDrafts = (
  drafts: readonly MechanicDraft[],
  rulePack: RulePackManifest,
  approvedPlugins: readonly ApprovedPlugin[],
): DraftCompilation => {
  const result: DraftCompilation = { compiled: [], plugins: [], unsupported: [] };
  for (const draft of drafts) {
    const { kind, rule } = draft;
    const plugin = kind && approvedPlugins.find((candidate) => candidate.kinds.includes(kind));
    if (draft.flagged) result.unsupported.push({ reason: 'flagged', draft });
    else if (plugin) result.plugins.push({ pluginId: plugin.id, draft });
    else if (kind) result.unsupported.push({ reason: 'needs_plugin', draft });
    else if (!rule) result.unsupported.push({ reason: 'missing_rule', draft });
    else {
      const compiled = compileRule({ rule, rulePack, sourceRefs: [draft.provenance.sourceHash] });
      if (compiled.ok) result.compiled.push({ rule: compiled.rule, draft });
      else result.unsupported.push({ reason: 'compile_failed', draft, error: compiled.error });
    }
  }
  return result;
};
