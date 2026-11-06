import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildContextPacket,
  CONTEXT_BUDGETS,
  type ContextBudgetPreset,
  type PacketInput,
  STABLE_SECTIONS,
  VARIABLE_SECTIONS,
} from '../../../packages/memory/src/packet.ts';
import { ProviderError } from './gm-api.ts';
import {
  contextCeilingOf,
  contextWindowOf,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  GM_CONTEXT_CEILING_TOKENS,
  requestFitting,
  TOO_LONG_MESSAGE,
} from './gm-limits.ts';

const EMPTY = Object.fromEntries(
  [...STABLE_SECTIONS, ...VARIABLE_SECTIONS].map((name) => [name, []]),
) as unknown as PacketInput;
const PLAYER_INPUT = 'I open the door';
const REPLY = { narration: 'It creaks.', segments: [] };
const TOO_LONG = new ProviderError('refused', 400, true);

const packetOf = (preset: ContextBudgetPreset, results: readonly string[] = []) =>
  buildContextPacket(
    {
      ...EMPTY,
      results,
      playerInput: [PLAYER_INPUT],
      context: Array.from({ length: 2000 }, (_, i) => `fact ${i} ${'x'.repeat(40)}`),
    },
    CONTEXT_BUDGETS[preset],
  );

const fakeProvider = (failures: readonly unknown[]) => {
  const sent: number[] = [];
  return {
    sent,
    send: async (packet: { usedTokens: number }) => {
      sent.push(packet.usedTokens);
      const failure = failures[sent.length - 1];
      if (failure !== undefined) throw failure;
      return REPLY;
    },
  };
};

describe('rpg-42a.44 GM request limits', () => {
  it('sends at the chosen preset when the provider accepts it', async () => {
    const provider = fakeProvider([]);
    const { packet, reply } = await requestFitting({ first: 'rich', packetOf, send: provider.send, ratio: 1 });
    assert.equal(packet.budget, CONTEXT_BUDGETS.rich);
    assert.equal(reply, REPLY);
    assert.equal(provider.sent.length, 1);
  });

  it('retries once with the next smaller preset after a too-long rejection', async () => {
    const provider = fakeProvider([TOO_LONG]);
    const { packet } = await requestFitting({ first: 'rich', packetOf, send: provider.send, ratio: 1 });
    assert.equal(packet.budget, CONTEXT_BUDGETS.standard);
    assert.equal(provider.sent.length, 2);
    assert.ok(Number(provider.sent[1]) < Number(provider.sent[0]));
  });

  it('gives a plain error after a second rejection and never tries a third time', async () => {
    const provider = fakeProvider([TOO_LONG, TOO_LONG, TOO_LONG]);
    await assert.rejects(
      requestFitting({ first: 'rich', packetOf, send: provider.send, ratio: 1 }),
      (error: unknown) => error instanceof ProviderError && error.message === TOO_LONG_MESSAGE,
    );
    assert.equal(provider.sent.length, 2);
  });

  it('gives a plain error when compact is rejected, with no smaller preset to try', async () => {
    const provider = fakeProvider([TOO_LONG]);
    await assert.rejects(requestFitting({ first: 'compact', packetOf, send: provider.send, ratio: 1 }), {
      message: TOO_LONG_MESSAGE,
    });
    assert.equal(provider.sent.length, 1);
  });

  it('passes other provider errors through without a retry', async () => {
    const provider = fakeProvider([new ProviderError('unavailable', 503)]);
    await assert.rejects(requestFitting({ first: 'rich', packetOf, send: provider.send, ratio: 1 }), {
      message: 'unavailable',
    });
    assert.equal(provider.sent.length, 1);
  });

  it('never sends a request above the ceiling and steps down first', async () => {
    const provider = fakeProvider([]);
    const ratio = GM_CONTEXT_CEILING_TOKENS / (CONTEXT_BUDGETS.standard - 100);
    const { packet } = await requestFitting({ first: 'rich', packetOf, send: provider.send, ratio });
    assert.equal(packet.budget, CONTEXT_BUDGETS.compact);
    assert.ok(provider.sent.every((tokens) => tokens * ratio <= GM_CONTEXT_CEILING_TOKENS));
  });

  it('refuses to send when even compact is over the ceiling', async () => {
    const provider = fakeProvider([]);
    await assert.rejects(
      requestFitting({ first: 'rich', packetOf, send: provider.send, ratio: GM_CONTEXT_CEILING_TOKENS }),
      { message: TOO_LONG_MESSAGE },
    );
    assert.equal(provider.sent.length, 0);
  });

  it('shrinks an oversized packet when the preset retry steps down', async () => {
    const huge = (preset: ContextBudgetPreset) => packetOf(preset, ['r'.repeat(GM_CONTEXT_CEILING_TOKENS * 8)]);
    const provider = fakeProvider([TOO_LONG]);
    await requestFitting({ first: 'rich', packetOf: huge, send: provider.send, ratio: 1 });
    assert.equal(provider.sent.length, 2);
    assert.ok(Number(provider.sent[1]) < Number(provider.sent[0]));
  });

  it('looks the context window up by model and falls back to the default', () => {
    assert.equal(contextWindowOf('sonnet[1m]'), 1_000_000);
    for (const model of ['claude-sonnet-5-5', 'default', '', undefined])
      assert.equal(contextWindowOf(model), DEFAULT_CONTEXT_WINDOW_TOKENS);
    assert.equal(contextCeilingOf(undefined), GM_CONTEXT_CEILING_TOKENS);
    assert.ok(contextCeilingOf('sonnet[1m]') > GM_CONTEXT_CEILING_TOKENS);
  });

  it('uses the ceiling of the model: a larger window keeps the preset the default window refuses', async () => {
    const ratio = GM_CONTEXT_CEILING_TOKENS / (CONTEXT_BUDGETS.standard - 100);
    const byDefault = await requestFitting({ first: 'rich', packetOf, send: fakeProvider([]).send, ratio });
    assert.equal(byDefault.packet.budget, CONTEXT_BUDGETS.compact);
    const large = await requestFitting({
      first: 'rich',
      packetOf,
      send: fakeProvider([]).send,
      ratio,
      model: 'sonnet[1m]',
    });
    assert.equal(large.packet.budget, CONTEXT_BUDGETS.rich);
  });
});
