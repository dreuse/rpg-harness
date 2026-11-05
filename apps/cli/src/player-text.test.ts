import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasProposalsBlock, playerTextOf } from './player-text.ts';

const PROSE = 'The door creaks open. Dust falls.';

test('plain prose passes through untouched', () => {
  assert.equal(playerTextOf(PROSE), PROSE);
  assert.equal(playerTextOf('A\n\nB'), 'A\n\nB');
});

test('labelled list lines and arithmetic in real narration are kept', () => {
  const choices = 'You can:\n- Talk to Tam: he seems nervous.\n- Leave: the rain waits.';
  assert.equal(playerTextOf(choices), choices);
  assert.equal(playerTextOf('- Sente-se: disse ele.'), '- Sente-se: disse ele.');
  assert.equal(playerTextOf('He counts 5*3*2 coins.'), 'He counts 5*3*2 coins.');
});

test('removes bold labels such as **Narration:** and **Old Tam:**', () => {
  assert.equal(playerTextOf(`**Narration:** ${PROSE}`), PROSE);
  assert.equal(playerTextOf('**Old Tam:** "Sit down, stranger."'), '"Sit down, stranger."');
  assert.equal(playerTextOf('**Old Tam**: "Sit."'), '"Sit."');
  assert.equal(playerTextOf('__Narration:__ Rain falls.'), 'Rain falls.');
});

test('strips emphasis, heading and code markers but keeps the words', () => {
  assert.equal(playerTextOf('The **old** man *smiles* and _nods_.'), 'The old man smiles and nods.');
  assert.equal(playerTextOf('## The Hollow Lantern\nRain falls.'), 'The Hollow Lantern\nRain falls.');
  assert.equal(playerTextOf('He holds `a key`.'), 'He holds a key.');
  assert.equal(playerTextOf('The old_tam_id stays'), 'The old_tam_id stays');
});

test('drops labelled list lines that carry internal ids', () => {
  const leaked = `${PROSE}\n\n**Proposals:**\n- Entity: old-tam (npc)\n- Thread: tam-thornwood-lights\n* Fact: tam-knows-lights\n- Entidade: velho-tam`;
  assert.equal(playerTextOf(leaked), PROSE);
  assert.equal(playerTextOf('- Entity: old-tam'), '');
  assert.equal(playerTextOf('- Pendente: fio-das-luzes'), '');
});

test('drops a bare Proposals label line', () => {
  assert.equal(playerTextOf(`${PROSE}\nProposals:\nNothing else.`), `${PROSE}\n\nNothing else.`);
});

test('hasProposalsBlock spots a proposals heading in any markdown dress', () => {
  assert.equal(hasProposalsBlock(`${PROSE}\n\n**Proposals:**\n- Entity: x`), true);
  assert.equal(hasProposalsBlock('Proposals:\n- a'), true);
  assert.equal(hasProposalsBlock('## Proposals\n- a'), true);
  assert.equal(hasProposalsBlock(PROSE), false);
  assert.equal(hasProposalsBlock('The council made proposals: none were kind.'), false);
});
