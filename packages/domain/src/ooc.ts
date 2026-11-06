import type { ClaimKind } from './story-memory.ts';

export const OOC_STATE_SAVED = 'OocStateSaved';
export const ROLL_CORRECTED = 'RollCorrected';
export const OOC_PROPOSAL_KINDS = ['table_note', 'house_rule', 'retcon_last_turn', 'roll_fix', 'canon_fix'] as const;
export type OocProposalKind = (typeof OOC_PROPOSAL_KINDS)[number];

export type OocProposal =
  | { readonly kind: 'table_note'; readonly summary: string; readonly note: string }
  | { readonly kind: 'house_rule'; readonly summary: string; readonly rule: Readonly<Record<string, unknown>> }
  | { readonly kind: 'retcon_last_turn'; readonly summary: string }
  | { readonly kind: 'roll_fix'; readonly summary: string; readonly reason: string; readonly value: number }
  | {
      readonly kind: 'canon_fix';
      readonly summary: string;
      readonly entityId: string;
      readonly claimKind: ClaimKind;
      readonly key?: string;
      readonly value: string;
    };

export type OocReply = { readonly reply: string; readonly proposals: readonly OocProposal[] };
export type OocApplied = {
  readonly revision: number;
  readonly summary: string;
  readonly retconnedInput?: string;
};
