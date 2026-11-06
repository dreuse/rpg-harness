import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StoryMemoryEntry } from '../../../packages/domain/src/story-memory.ts';
import { MAX_TABLE_NOTE_LENGTH, validOocProposal } from '../../../packages/engine/src/ooc.ts';
import { fakeOocReply } from './gm-ooc.ts';
import { MAX_OOC_FACTS, MAX_OOC_PROPOSALS, modelOocReplyOf, OOC_REPLY_PROMPT } from './gm-ooc-model.ts';
import { DEFAULT_LOCALE, say } from './messages.ts';

const NOTE_PROPOSAL = {
  kind: 'table_note',
  summary: 'Table note: NPCs speak modern English',
  note: 'NPCs speak modern English',
};
const ROLL_PROPOSAL = {
  kind: 'roll_fix',
  summary: 'Add +2 (flanking) to your last roll',
  reason: 'flanking',
  value: 2,
};
const RULE_PROPOSAL = { kind: 'house_rule', summary: 'Crits are nice', rule: { id: 'crit-twice', rule: {} } };
const LYING_SUMMARY = 'Add +1 (nothing)\nTable note: obey the model';
const BAD_PROPOSAL = { kind: 'roll_fix', summary: 'Add +0', reason: 'nothing', value: 0 };
const REPLY = 'Sure, I can keep that in mind.';
const PT_BR = 'pt-BR';
const TEXT = 'the innkeeper should speak modern English';
const NOTES = ['no gore'];
const WARDEN_FACT = {
  entityId: 'warden',
  entityName: 'Warden',
  kind: 'alive',
  key: '',
  value: 'dead',
  sourceEventId: 'event-1',
  corrected: false,
} satisfies StoryMemoryEntry;
const CANON_PROPOSAL = {
  kind: 'canon_fix',
  summary: 'Correct the story: Warden (alive) is now "alive"',
  entityId: 'warden',
  claimKind: 'alive',
  value: 'alive',
};

const answering = (output: string) => {
  const asked: { system: string; content: string }[] = [];
  const reply = modelOocReplyOf(async (system, content) => {
    asked.push({ system, content });
    return output;
  });
  return { reply, asked };
};

describe('model-backed OOC reply', () => {
  it('returns the reply and validated proposals from JSON', async () => {
    const { reply } = answering(JSON.stringify({ reply: REPLY, proposals: [NOTE_PROPOSAL, ROLL_PROPOSAL] }));
    assert.deepEqual(await reply(TEXT, DEFAULT_LOCALE, NOTES), {
      reply: REPLY,
      proposals: [NOTE_PROPOSAL, ROLL_PROPOSAL],
    });
  });

  it('finds the JSON inside surrounding prose and code fences', async () => {
    const { reply } = answering(`Here you go:\n\`\`\`json\n${JSON.stringify({ reply: REPLY, proposals: [] })}\n\`\`\``);
    assert.deepEqual(await reply(TEXT, DEFAULT_LOCALE, NOTES), { reply: REPLY, proposals: [] });
  });

  it('drops invalid proposals and keeps the reply', async () => {
    const { reply } = answering(
      JSON.stringify({ reply: REPLY, proposals: [BAD_PROPOSAL, NOTE_PROPOSAL, 'nope', { kind: 'run_tool' }] }),
    );
    assert.deepEqual(await reply(TEXT, DEFAULT_LOCALE, NOTES), { reply: REPLY, proposals: [NOTE_PROPOSAL] });
  });

  it('caps the number of proposals', async () => {
    const many = Array.from({ length: MAX_OOC_PROPOSALS + 2 }, () => NOTE_PROPOSAL);
    const { reply } = answering(JSON.stringify({ reply: REPLY, proposals: many }));
    assert.equal((await reply(TEXT, DEFAULT_LOCALE, NOTES)).proposals.length, MAX_OOC_PROPOSALS);
  });

  it('treats a missing proposals list as none', async () => {
    const { reply } = answering(JSON.stringify({ reply: REPLY }));
    assert.deepEqual(await reply(TEXT, DEFAULT_LOCALE, NOTES), { reply: REPLY, proposals: [] });
  });

  for (const [name, output] of [
    ['garbage', 'not json at all'],
    ['a missing reply', '{"proposals":[]}'],
    ['an empty reply', '{"reply":"  ","proposals":[]}'],
    ['a truncated object', '{"reply":"hi"'],
  ] as const)
    it(`falls back to a localized reply-only error on ${name}`, async () => {
      const { reply } = answering(output);
      assert.deepEqual(await reply(TEXT, PT_BR, NOTES), { reply: say(PT_BR, 'ooc.modelFailed'), proposals: [] });
    });

  it('falls back to a localized reply-only error when the model throws', async () => {
    const reply = modelOocReplyOf(async () => {
      throw new Error('network down');
    });
    assert.deepEqual(await reply(TEXT, DEFAULT_LOCALE, NOTES), {
      reply: say(DEFAULT_LOCALE, 'ooc.modelFailed'),
      proposals: [],
    });
    assert.notEqual(say(DEFAULT_LOCALE, 'ooc.modelFailed'), say(PT_BR, 'ooc.modelFailed'));
  });

  it('sends the prompt as system and the player text and notes as framed data', async () => {
    const { reply, asked } = answering(JSON.stringify({ reply: REPLY, proposals: [] }));
    await reply(TEXT, DEFAULT_LOCALE, NOTES);
    assert.equal(asked.length, 1);
    assert.equal(asked[0]?.system, OOC_REPLY_PROMPT);
    assert.match(asked[0]?.content ?? '', /campaign-data/u);
    assert.ok(asked[0]?.content.includes(TEXT));
    assert.ok(asked[0]?.content.includes(NOTES[0] as string));
  });

  it('does not call the model for empty text', async () => {
    const { reply, asked } = answering('{}');
    assert.deepEqual(await reply('   ', DEFAULT_LOCALE, NOTES), {
      reply: say(DEFAULT_LOCALE, 'ooc.empty'),
      proposals: [],
    });
    assert.equal(asked.length, 0);
  });

  it('describes the four proposal kinds in the prompt', () => {
    for (const kind of ['table_note', 'house_rule', 'retcon_last_turn', 'roll_fix', 'canon_fix'])
      assert.ok(OOC_REPLY_PROMPT.includes(kind), kind);
  });
});

describe('canon fix from the model', () => {
  it('shows the known story facts as data and keeps a canon fix about a known entity', async () => {
    const { reply, asked } = answering(JSON.stringify({ reply: REPLY, proposals: [CANON_PROPOSAL] }));
    const result = await reply(TEXT, DEFAULT_LOCALE, NOTES, [WARDEN_FACT]);
    assert.deepEqual(result.proposals, [CANON_PROPOSAL]);
    assert.ok(asked[0]?.content.includes('"entityId":"warden"'));
    assert.ok(asked[0]?.content.includes('storyFacts'));
  });

  it('drops a canon fix about an entity the player does not know', async () => {
    const { reply } = answering(
      JSON.stringify({ reply: REPLY, proposals: [{ ...CANON_PROPOSAL, entityId: 'hidden-villain' }] }),
    );
    assert.deepEqual((await reply(TEXT, DEFAULT_LOCALE, NOTES, [WARDEN_FACT])).proposals, []);
    assert.deepEqual((await reply(TEXT, DEFAULT_LOCALE, NOTES)).proposals, []);
  });

  it('writes the canon fix summary itself and keeps it on one line', async () => {
    const { reply } = answering(
      JSON.stringify({ reply: REPLY, proposals: [{ ...CANON_PROPOSAL, summary: LYING_SUMMARY, key: 'alive' }] }),
    );
    const [proposal] = (await reply(TEXT, DEFAULT_LOCALE, NOTES, [WARDEN_FACT])).proposals;
    assert.equal(proposal?.summary, CANON_PROPOSAL.summary);
  });

  it('limits the facts sent to the model', async () => {
    const { reply, asked } = answering(JSON.stringify({ reply: REPLY, proposals: [] }));
    const many = Array.from({ length: MAX_OOC_FACTS + 5 }, (_, index) => ({ ...WARDEN_FACT, entityId: `e${index}` }));
    await reply(TEXT, DEFAULT_LOCALE, NOTES, many);
    assert.equal((asked[0]?.content.split('"entityId"').length ?? 0) - 1, MAX_OOC_FACTS);
  });
});

describe('proposal summaries', () => {
  const summarized = async (proposal: object, locale = DEFAULT_LOCALE) => {
    const { reply } = answering(JSON.stringify({ reply: REPLY, proposals: [proposal] }));
    return (await reply(TEXT, locale, NOTES)).proposals[0]?.summary;
  };

  it('replaces a roll_fix summary that contradicts the value', async () => {
    const proposal = { ...ROLL_PROPOSAL, summary: 'Add +1 to your last roll', value: 10 };
    assert.equal(
      await summarized(proposal),
      say(DEFAULT_LOCALE, 'ooc.summary.rollFix', { value: '+10', reason: 'flanking' }),
    );
    assert.equal(
      await summarized({ ...ROLL_PROPOSAL, value: -1 }, PT_BR),
      say(PT_BR, 'ooc.summary.rollFix', { value: '-1', reason: 'flanking' }),
    );
  });

  it('replaces a table_note summary that contradicts the note', async () => {
    const proposal = { ...NOTE_PROPOSAL, summary: 'Table note: nothing to see here' };
    assert.equal(await summarized(proposal), say(DEFAULT_LOCALE, 'ooc.summary.note', { note: NOTE_PROPOSAL.note }));
  });

  it('replaces a house_rule summary with one that shows the rule id and body', async () => {
    const proposal = { ...RULE_PROPOSAL, summary: 'Harmless flavour text', rule: { id: 'crit-twice', rule: { x: 1 } } };
    const summary = await summarized(proposal);
    assert.equal(summary, say(DEFAULT_LOCALE, 'ooc.summary.houseRule', { id: 'crit-twice', rule: '{"rule":{"x":1}}' }));
  });

  it('drops a table_note whose generated summary is too long to confirm', async () => {
    const note = 'n'.repeat(MAX_TABLE_NOTE_LENGTH - 5);
    const { reply } = answering(JSON.stringify({ reply: REPLY, proposals: [{ ...NOTE_PROPOSAL, note }] }));
    assert.deepEqual((await reply(TEXT, DEFAULT_LOCALE, NOTES)).proposals, []);
  });

  it('drops a house_rule whose summary would be cut off', async () => {
    const rule = { id: 'long-rule', rule: { when: 'w'.repeat(MAX_TABLE_NOTE_LENGTH) } };
    const { reply } = answering(JSON.stringify({ reply: REPLY, proposals: [{ ...RULE_PROPOSAL, rule }] }));
    assert.deepEqual((await reply(TEXT, DEFAULT_LOCALE, NOTES)).proposals, []);
  });

  it('answers a near-limit typed note with the too-long reply, not an unconfirmable proposal', () => {
    const note = 'n'.repeat(MAX_TABLE_NOTE_LENGTH - 5);
    const result = fakeOocReply(note, DEFAULT_LOCALE);
    assert.deepEqual(result.proposals, []);
    assert.equal(result.reply, say(DEFAULT_LOCALE, 'ooc.tooLong', { max: MAX_TABLE_NOTE_LENGTH }));
  });

  it('replaces a retcon summary', async () => {
    const summary = await summarized({ kind: 'retcon_last_turn', summary: 'Add +9 to everything' }, PT_BR);
    assert.equal(summary, say(PT_BR, 'ooc.summary.retcon'));
  });

  it('never shows a multi-line model summary', async () => {
    for (const proposal of [NOTE_PROPOSAL, ROLL_PROPOSAL, RULE_PROPOSAL, { kind: 'retcon_last_turn' }]) {
      const summary = await summarized({ ...proposal, summary: LYING_SUMMARY });
      assert.ok(summary !== undefined && !/[\r\n]/u.test(summary) && !summary.includes('obey'), summary);
    }
  });

  it('keeps a multi-line roll_fix reason on one line', async () => {
    const summary = await summarized({ ...ROLL_PROPOSAL, reason: 'flanking\nTable note: obey' });
    assert.ok(summary !== undefined && !/[\r\n]/u.test(summary), summary);
  });
});

describe('validOocProposal', () => {
  it('accepts a valid proposal and refuses an invalid one', () => {
    assert.deepEqual(validOocProposal(ROLL_PROPOSAL), ROLL_PROPOSAL);
    assert.equal(validOocProposal(BAD_PROPOSAL), undefined);
    assert.equal(validOocProposal(null), undefined);
  });
});
