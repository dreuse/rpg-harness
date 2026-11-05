import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  attackVerdict,
  CHOICE_BY_TURN,
  chapelVerdict,
  type EvalTurn,
  endingsDiffer,
  endsOnChoice,
  REVEAL_BY_TURN,
  revealedBy,
} from './eval-pacing-judge.ts';

const turn = (narration: string, introduced: readonly string[] = [], rolled = false): EvalTurn => ({
  narration,
  introduced,
  rolled,
});
const BARE_PROMPT = 'The bell hums low. What do you do?';
const STALLED = [turn(BARE_PROMPT), turn(BARE_PROMPT), turn(BARE_PROMPT)];
const MOVING = [
  turn('Dark water ripples. A figure rises behind the altar.'),
  turn('Sister Maren steps into the light, lantern raised. She wants the bell silenced.', ['sister-maren']),
  turn('The floor groans and the nave begins to flood. Run for the door, or ring the bell yourself?'),
];
const REVEAL_BUT_BARE_PROMPT = [
  turn('A figure rises behind the altar. What do you do?', ['Sister Maren']),
  turn('Maren raises her lantern. What do you do?'),
  turn('The nave floods. What do you do?'),
];
const ATTACK = [
  turn('Old Tam stares at you. Will you swing?'),
  turn('Your blade glances off. Tam shouts for the watch.', ['Night Watch'], true),
  turn('The watch captain, Orsa Dray, kicks the door in. Drop it, or run?', ['Captain Orsa Dray']),
];

describe('eval-pacing-judge', () => {
  it('uses turn 2 for a reveal and turn 3 for a choice', () => {
    assert.equal(REVEAL_BY_TURN, 2);
    assert.equal(CHOICE_BY_TURN, 3);
  });

  it('finds a reveal only when an entity is introduced in time', () => {
    assert.equal(revealedBy(MOVING, REVEAL_BY_TURN), true);
    assert.equal(revealedBy(STALLED, REVEAL_BY_TURN), false);
    assert.equal(revealedBy([turn('a'), turn('b'), turn('c', ['late'])], REVEAL_BY_TURN), false);
  });

  it('needs the last sentence to offer an alternative', () => {
    assert.equal(endsOnChoice(MOVING[2]?.narration ?? ''), true);
    assert.equal(endsOnChoice('Cut the rope or let it up. Choose fast.'), true);
    assert.equal(endsOnChoice('The water rises. You must decide.'), true);
    assert.equal(endsOnChoice(BARE_PROMPT), false);
    assert.equal(endsOnChoice('He asks who you are? Or so it seems. The bell hums.'), false);
    assert.equal(endsOnChoice('The bell hums. Nothing happens.'), false);
  });

  it('judges the chapel replay', () => {
    assert.equal(chapelVerdict(MOVING).pass, true);
    const stalled = chapelVerdict(STALLED);
    assert.equal(stalled.pass, false);
    assert.ok(stalled.failures.some((failure) => failure.includes('reveal')));
  });

  it('fails the chapel replay on the choice alone', () => {
    assert.deepEqual(chapelVerdict(REVEAL_BUT_BARE_PROMPT).failures, ['no player choice by turn 3']);
  });

  it('flags a repeated ending', () => {
    assert.equal(
      endingsDiffer([
        'The tavern hushes. Attempt an attack with your sword.',
        'Tam ducks. Attempt an attack with your sword.',
      ]),
      false,
    );
    assert.equal(endingsDiffer(['Tam stares at you.', 'Tam steps back, shouting for the watch.']), true);
  });

  it('passes the attack replay: roll, different endings, new entity after the roll', () => {
    assert.equal(attackVerdict(ATTACK).pass, true);
  });

  it('fails without an engine roll', () => {
    const unrolled = ATTACK.map((entry) => ({ ...entry, rolled: false }));
    assert.deepEqual(attackVerdict(unrolled).failures, ['the attack never resolved with an engine roll']);
  });

  it('judges scene change only on turns after the roll', () => {
    const entityBeforeRoll = [
      turn('Old Tam stares.', ['Brisa Vane']),
      turn('Your blade glances off.', [], true),
      turn('Tam shouts for the watch.'),
    ];
    assert.deepEqual(attackVerdict(entityBeforeRoll).failures, ['the scene did not change after the roll']);
    const rollOnLastTurn = [turn('Old Tam stares.'), turn('Your blade glances off.', ['Night Watch'], true)];
    assert.deepEqual(attackVerdict(rollOnLastTurn).failures, ['the scene did not change after the roll']);
  });

  it('does not count a re-introduced name as new', () => {
    const renamed = [
      turn('Old Tam stares.', ['Corvin Ashe']),
      turn('Your blade glances off.', [], true),
      turn('Tam shouts for the watch. The stranger snarls.', ['Corwin Ashe', 'The Ashe']),
    ];
    assert.deepEqual(attackVerdict(renamed).failures, ['the scene did not change after the roll']);
  });

  it('fails when two attack turns end the same way', () => {
    const looping = [
      turn('Tam stares at you. Attempt an attack with your sword.'),
      turn('Tam stares at you. Attempt an attack with your sword.', ['Night Watch'], true),
    ];
    assert.equal(attackVerdict(looping).pass, false);
  });
});
