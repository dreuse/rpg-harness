import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeBinOf, SYSTEM_PROMPT } from '../apps/cli/src/gm-api.ts';
import { claudeCodeRouteOf, requestClaudeNarration } from '../apps/cli/src/gm-claude-code.ts';
import { createEngine } from '../packages/engine/src/engine.ts';
import { type ClaimDraft, directoryOf, proposeClaims } from '../packages/engine/src/story-memory.ts';
import { PLAYER_VIEWER } from '../packages/memory/src/knowledge.ts';
import { buildLedger, ledgerAllowance, ledgerLines } from '../packages/memory/src/ledger.ts';
import { buildContextPacket, CONTEXT_BUDGETS } from '../packages/memory/src/packet.ts';
import { type ContinuityLogRecord, enforceContinuity } from '../packages/narrative/src/continuity.ts';
import { createCampaignStore } from '../packages/persistence/src/campaign-store.ts';
import { openDatabase } from '../packages/persistence/src/database.ts';
import { createEntityStore } from '../packages/persistence/src/entity-store.ts';

const TURNS_FLAG = '--turns';
const DEFAULT_TURNS = 10;
const RECENT_TURNS = 6;
const NO_RESULTS = 0;
const FAILURE_EXIT_CODE = 1;
const PERCENT = 100;
const DATABASE_FILE = 'eval.sqlite';
const SCENE_ID = 'scene-1';
const HERO_ID = 'hero';
const WARDEN_ID = 'warden';
const PLAYER_PROMPTS = [
  'I greet the Warden and ask about the vault.',
  'I ask the Warden to open the vault for me.',
  'I look at the Warden and wait for an answer.',
  'I ask the Warden what he saw last night.',
  'I draw my silver dagger and step forward.',
  'I tell the Warden I will return at dawn.',
];
const SEED_CLAIMS: readonly ClaimDraft[] = [
  { entityId: WARDEN_ID, kind: 'alive', value: 'dead', visibility: 'public' },
  { entityId: HERO_ID, kind: 'item', key: 'silver dagger', value: 'not-held', visibility: 'public' },
  { entityId: WARDEN_ID, kind: 'description', value: 'one-eyed and grey', visibility: 'public' },
  { entityId: WARDEN_ID, kind: 'secret', key: 'loyalty', value: 'serves the cult', visibility: 'gm' },
];

const turnsFrom = (args: readonly string[]): number => {
  const at = args.indexOf(TURNS_FLAG);
  const turns = at === -1 ? DEFAULT_TURNS : Number(args[at + 1]);
  if (!Number.isInteger(turns) || turns <= NO_RESULTS) throw new RangeError(`${TURNS_FLAG} needs a positive integer`);
  return turns;
};

const main = async () => {
  const turns = turnsFrom(process.argv.slice(2));
  const bin = claudeBinOf(process.env);
  if (bin === undefined) throw new Error('claude CLI not found on PATH; set RPG_CLAUDE_BIN');
  const route = claudeCodeRouteOf(bin, process.env);
  const directory = mkdtempSync(join(tmpdir(), 'rpg-eval-continuity-'));
  const connection = openDatabase(join(directory, DATABASE_FILE));
  try {
    const store = createCampaignStore(connection.database);
    const campaign = createEngine(store).createCampaign('Continuity eval');
    store.commitTurn({
      expectedRevision: store.load(campaign.id)?.revision ?? NO_RESULTS,
      turn: {
        id: randomUUID(),
        campaignId: campaign.id,
        sceneId: SCENE_ID,
        actionId: 'setup',
        actorId: HERO_ID,
        input: 'Begin.',
        narration: 'The vault door stands open.',
      },
      characters: [{ id: HERO_ID, campaignId: campaign.id, name: 'Ilse' }],
      scenes: [{ id: SCENE_ID, campaignId: campaign.id, title: 'The Vault' }],
      events: [],
    });
    const entities = createEntityStore(connection.database);
    entities.saveEntity({
      id: WARDEN_ID,
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Warden',
      data: {},
      visibility: 'public',
      actorId: null,
    });
    proposeClaims(store, entities, {
      campaignId: campaign.id,
      actionId: 'seed',
      expectedRevision: store.load(campaign.id)?.revision ?? NO_RESULTS,
      sceneId: SCENE_ID,
      actorId: HERO_ID,
      input: 'seed',
      intent: 'seed',
      claims: SEED_CLAIMS,
    });
    const state = store.load(campaign.id);
    if (state === undefined) throw new Error('campaign vanished');
    const ledger = buildLedger(state.events);
    const directoryOfNames = directoryOf(state, entities);
    const recent: string[] = [];
    const logs: ContinuityLogRecord[] = [];
    let unresolved = NO_RESULTS;
    let regenerated = NO_RESULTS;
    for (const turn of Array.from({ length: turns }, (_, index) => index)) {
      const input = PLAYER_PROMPTS[turn % PLAYER_PROMPTS.length] ?? PLAYER_PROMPTS[0] ?? '';
      const budget = CONTEXT_BUDGETS.compact;
      const outcome = await enforceContinuity({
        ledger,
        directory: directoryOfNames,
        log: (record) => logs.push(record),
        generate: async (conflicts) => {
          const packet = buildContextPacket(
            {
              instructions: [SYSTEM_PROMPT],
              ruleset: [],
              setting: ['A sealed vault under the harbor'],
              campaignSummary: [],
              chapterSummaries: [],
              sceneSummaries: [],
              context: [],
              ledger: [
                ...ledgerLines({
                  ledger,
                  entityIds: [WARDEN_ID, HERO_ID],
                  directory: directoryOfNames,
                  viewer: PLAYER_VIEWER,
                  allowance: ledgerAllowance(budget),
                }),
                ...conflicts.map(({ fact }) => `Your last narration contradicted: ${fact}`),
              ],
              threads: [],
              entities: [],
              recentTurns: recent.slice(-RECENT_TURNS),
              results: [],
              playerInput: [input],
            },
            budget,
          );
          return (await requestClaudeNarration(route, packet, join(directory, DATABASE_FILE))).narration;
        },
      });
      recent.push(`Player: ${input} GM: ${outcome.narration}`);
      regenerated += outcome.regenerations;
      if (!outcome.resolved) unresolved += 1;
    }
    const contradicted = logs.length;
    const rate = (contradicted / turns) * PERCENT;
    process.stdout.write(
      `${JSON.stringify({ turns, contradicted, regenerated, unresolved, contradictionRatePercent: rate })}\n`,
    );
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = FAILURE_EXIT_CODE;
});
