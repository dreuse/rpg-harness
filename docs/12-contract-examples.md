# 12 — Illustrative typed API contracts

These are design examples, not validated production schemas. TypeScript implementation should derive generated runtime validation from a single source of truth and version all external/client protocols.

```ts
interface CampaignIntent {
  requestedRulePack?: { system: string; edition?: string; source?: string };
  requestedGenre?: string;
  characterConcept?: string;
  preferences?: {
    simulation?: 'off' | 'ambient' | 'balanced' | 'dynamic' | 'custom';
    storyIntensity?: number; worldAutonomy?: number; consequenceSeverity?: number;
    voice?: 'off' | 'narrator' | 'dialogue' | 'full';
    pacing?: 'relaxed' | 'balanced' | 'intense';
  };
  provenance: Record<string, 'explicit' | 'inferred' | 'default'>;
}

interface RulePackManifest {
  id: string; edition: string; revision: string;
  capabilities: Record<string, boolean | 'adjudicated'>;
  characterSheetSchemaId?: string;
  sourceRefs: string[];
}

interface ActionProposal {
  actionId: string; actorId: string; branchId: string;
  expectedRevision: number;
  intent: string; parameters: unknown;
  rulePackRevision: string;
}

interface CommittedTurn {
  turnId: string; resultingRevision: number;
  appliedEvents: readonly DomainEvent[];
  narrationContext: unknown;
}

interface DomainEvent {
  eventId: string; campaignId: string; branchId: string;
  type: string; actorId?: string;
  causationId?: string; actionId: string;
  logicalTime: number; payload: unknown;
  visibility: 'public' | 'player' | 'gm' | 'actor-scoped';
}

interface ViewDescriptor {
  id: string; type: string; schemaVersion: number;
  visibility: 'player' | 'gm'; components: readonly unknown[];
}
```

## Example interaction: valid action

1. Player asks to steal a merchant's sword.
2. GM requests current scene, inventory, relevant RulePack actions and merchant visibility.
3. GM proposes a `steal_item` action, and engine checks the item's availability, awareness conditions and required check.
4. Engine rolls/checks and commits `item_transferred`, `npc_suspicion_changed` and perhaps `quest_triggered` in one transaction.
5. Narrative Director decides whether the guard rumors become player-visible immediately or later.
6. Voice/UI present committed events with source references as appropriate.

## Example interaction: invalid edition

Player asks for "D&D 1.9". Rules registry cannot match an installed edition or a recognized edition name, and must request a correction or offer imports. It must not create an internally made-up 1.9 RulePack labeled official.

## Example interaction: voice interruption

GM narrative about a committed event streams to TTS. Player interrupts; TTS output stops, transcript shows delivered segments, and a new user turn is started. Prior event persists and is not re-committed.
