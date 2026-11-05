import { CONTEXT_BUDGETS, type ContextBudgetPreset, type ContextPacket } from '../../../packages/memory/src/packet.ts';
import { ProviderError } from './gm-api.ts';

export const MODEL_CONTEXT_WINDOW_TOKENS = 200_000;
export const CONTEXT_SAFETY_MARGIN = 0.8;
export const GM_CONTEXT_CEILING_TOKENS = MODEL_CONTEXT_WINDOW_TOKENS * CONTEXT_SAFETY_MARGIN;
export const TOO_LONG_MESSAGE =
  'The story context is too long for the AI game master. Try the compact memory setting or shorter rules.';

const SMALLER_PRESET: Readonly<Partial<Record<ContextBudgetPreset, ContextBudgetPreset>>> = {
  rich: 'standard',
  standard: 'compact',
};

type Fitting<Reply> = {
  readonly first: ContextBudgetPreset;
  readonly packetOf: (preset: ContextBudgetPreset) => ContextPacket;
  readonly send: (packet: ContextPacket) => Promise<Reply>;
  readonly ratio: number;
};

export const requestFitting = async <Reply>({ first, packetOf, send, ratio }: Fitting<Reply>) => {
  let preset: ContextBudgetPreset | undefined = first;
  let rejected = false;
  while (preset !== undefined) {
    const packet = packetOf(preset);
    if (packet.usedTokens * ratio <= GM_CONTEXT_CEILING_TOKENS) {
      try {
        return { packet, reply: await send(packet) };
      } catch (error) {
        if (!(error instanceof ProviderError && error.tooLong)) throw error;
        if (rejected) break;
        rejected = true;
      }
    }
    preset = SMALLER_PRESET[preset];
  }
  throw new ProviderError(TOO_LONG_MESSAGE);
};

export const budgetOf = (preset: ContextBudgetPreset, ratio: number) => Math.floor(CONTEXT_BUDGETS[preset] / ratio);
