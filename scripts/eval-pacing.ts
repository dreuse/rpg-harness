import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeCodeGameMaster,
  createEngineGateway,
  openClientSession,
  readCampaignState,
} from '../apps/cli/src/engine-gateway.ts';
import { claudeBinOf } from '../apps/cli/src/gm-api.ts';
import { claudeCodeRouteOf } from '../apps/cli/src/gm-claude-code.ts';
import { PROTOCOL_VERSION } from '../packages/client-protocol/src/protocol.ts';
import { CHECK_RESOLVED } from '../packages/domain/src/campaign.ts';
import { ENTITY_INTRODUCED } from '../packages/engine/src/memory.ts';
import { attackVerdict, chapelVerdict, type EvalTurn, type Verdict } from './eval-pacing-judge.ts';

const FAILURE_EXIT_CODE = 1;
const NONE = 0;
const CHARACTER = 'Wren, a scout. Might 3, Agility 2, Wits 2, Presence 1';
const CHAPEL = {
  campaign: 'drowned-chapel',
  pitch: 'A fantasy story using the d20-lite rules, set in a drowned chapel where a bell hums beneath dark water',
  inputs: [
    'I call out into the dark chapel.',
    'I challenge whoever is down here to show themselves.',
    'I demand to know who rings the bell.',
    'I charge across the flooded nave toward the altar.',
    'I shout that I am not leaving without answers.',
    'I charge the altar again and grab the bell rope.',
  ],
};
const HOLLOW_LANTERN = {
  campaign: 'hollow-lantern',
  pitch: 'A fantasy story using the d20-lite rules, set in the Hollow Lantern tavern, where Old Tam tends the bar',
  inputs: ["I slashed my sword on Old Tam's head", 'i will attempt the attack', 'I press the attack on Old Tam'],
};

type Replay = typeof CHAPEL;
type Result = { readonly name: string; readonly turns: readonly EvalTurn[] };

const nameOf = (payload: Readonly<Record<string, unknown>>): string => {
  const entity = payload.entity as { name?: unknown } | undefined;
  return typeof entity?.name === 'string' ? entity.name : 'unnamed';
};

const play = async (replay: Replay): Promise<Result> => {
  const bin = claudeBinOf(process.env);
  if (bin === undefined) throw new Error('claude CLI not found on PATH; set RPG_CLAUDE_BIN');
  const gm = claudeCodeGameMaster(claudeCodeRouteOf(bin, process.env));
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-eval-pacing-'));
  try {
    for await (const _ of createEngineGateway(dataDir, gm).create(
      replay.campaign,
      replay.pitch,
      async () => CHARACTER,
    ));
    const { session, campaignId, close, narrate } = openClientSession(dataDir, replay.campaign, gm);
    try {
      const envelope = { version: PROTOCOL_VERSION, campaignId } as const;
      const turns: EvalTurn[] = [];
      for (const input of replay.inputs) {
        const snapshot = session.getSnapshot({ ...envelope, type: 'GetCampaignSnapshot' });
        if (!snapshot.ok) throw new Error(snapshot.error.message);
        const before = snapshot.value;
        const known = readCampaignState(dataDir, replay.campaign).events.length;
        const submitted = session.submitPlayerAction({
          ...envelope,
          type: 'SubmitPlayerAction',
          actionId: randomUUID(),
          expectedRevision: before.revision,
          sceneId: before.currentScene?.id ?? '',
          actorId: before.characters[NONE]?.id ?? '',
          input,
          ...(before.rollOffer === undefined ? {} : { rollOfferId: before.rollOffer.offerId }),
        });
        if (!submitted.ok) throw new Error(submitted.error.message);
        await narrate();
        const events = readCampaignState(dataDir, replay.campaign).events;
        const after = session.getSnapshot({ ...envelope, type: 'GetCampaignSnapshot' });
        if (!after.ok) throw new Error(after.error.message);
        turns.push({
          narration: after.value.turns.at(-1)?.narration ?? '',
          introduced: events
            .slice(known)
            .filter(({ type }) => type === ENTITY_INTRODUCED)
            .map(({ payload }) => nameOf(payload)),
          rolled: events.slice(known).some(({ type }) => type === CHECK_RESOLVED),
        });
        process.stdout.write(`\n> ${input}\n${turns.at(-1)?.narration}\n`);
      }
      return { name: replay.campaign, turns };
    } finally {
      close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
};

const report = ({ name, turns }: Result, verdict: Verdict) => {
  const rolls = turns.filter(({ rolled }) => rolled).length;
  const introduced = turns.map(({ introduced: names }, index) => `turn ${index + 1}: ${names.join(', ') || '-'}`);
  process.stdout.write(
    `\n== ${name}: ${verdict.pass ? 'PASS' : 'FAIL'} (rolls: ${rolls}) ==\nintroduced\n${introduced.join('\n')}\n${verdict.failures.join('\n')}\n`,
  );
  return verdict.pass;
};

const main = async () => {
  const chapel = await play(CHAPEL);
  const attack = await play(HOLLOW_LANTERN);
  const passed = [report(chapel, chapelVerdict(chapel.turns)), report(attack, attackVerdict(attack.turns))];
  if (!passed.every(Boolean)) process.exitCode = FAILURE_EXIT_CODE;
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = FAILURE_EXIT_CODE;
});
