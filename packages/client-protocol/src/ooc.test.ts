import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseOocInput } from './ooc.ts';
import { PROTOCOL_VERSION, parseCommand } from './protocol.ts';

const CAMPAIGN = 'campaign-1';
const envelope = { version: PROTOCOL_VERSION, campaignId: CAMPAIGN } as const;

test('rpg-42a.91: /gm and (( )) prefixes mark out-of-character input', () => {
  assert.equal(parseOocInput('/gm you forgot my +2 for high ground'), 'you forgot my +2 for high ground');
  assert.equal(parseOocInput('  /GM   stop rolling for me '), 'stop rolling for me');
  assert.equal(parseOocInput('(( NPCs speak modern English ))'), 'NPCs speak modern English');
  assert.equal(parseOocInput('((undo that))'), 'undo that');
  assert.equal(parseOocInput('/gm'), '');
  assert.equal(parseOocInput('/gmail the baron'), undefined);
  assert.equal(parseOocInput('I open the door'), undefined);
  assert.equal(parseOocInput('(( unclosed'), undefined);
});

test('rpg-42a.91: the three out-of-character commands parse and reject unknown fields', () => {
  const message = { ...envelope, type: 'SubmitOocMessage', actionId: 'a1', text: 'hello' };
  assert.ok(parseCommand(message).ok);
  const confirm = {
    ...envelope,
    type: 'ConfirmOocProposal',
    actionId: 'a2',
    expectedRevision: 3,
    proposal: { kind: 'retcon_last_turn', summary: 'Undo' },
  };
  assert.ok(parseCommand(confirm).ok);
  assert.ok(parseCommand({ ...envelope, type: 'UndoOocChange', actionId: 'a3', expectedRevision: 4 }).ok);
  assert.equal(parseCommand({ ...message, extra: 1 }).ok, false);
  assert.equal(parseCommand({ ...message, text: 5 }).ok, false);
  assert.equal(parseCommand({ ...confirm, proposal: 'retcon' }).ok, false);
});
