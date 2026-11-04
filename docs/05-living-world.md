# 05 — Optional living-world simulation and Narrative Director

## Contract

The simulator is opt-in, capability-scoped and bound by **game time**, not wall-clock time. It may be disabled without affecting the core GM, narrative, dice, memory or rules. Genre packs recommend compatible settings; users retain control.

## Modes and sliders

`off`: zero autonomous jobs. `ambient`: modest minor developments. `balanced`: meaningful independent NPC/faction actions with moderated presentation. `dynamic`: dense strategic activity. `custom`: direct control of knobs:

- `worldAutonomy`: how frequently eligible agents initiate proposals (not a way to bypass rules).
- `storyIntensity`: how frequently major events are surfaced or foregrounded (does not suppress truly critical immediate results).
- `consequenceSeverity`: affects challenge generation, available recovery opportunities and prior disclosed difficulty policy; never cheats committed dice.
- Optional budget settings: maximum agent calls, LLM token spend, per-cycle actor count.

The campaign config field `simulation` stores the mode; players change it in conversation (N08). `MODE_KNOBS` gives the slider values for each preset mode. `custom` fills unset sliders from `balanced`. Sliders never reach the ruleset check port. `simulationDiagnostics` reports the mode, effective sliders, budget, and the action IDs applied or skipped with reasons.

"Dynamic world but relaxed pacing" = a high number of background developments combined with a low narrative-attention budget. This is not contradictory.

## NPC/faction data

WorldActor: goal list, resources, capabilities, current plan, relationships, knowledge/beliefs, time constraints, priority, risk appetite, previous decisions, current actor revision and branch. An actor can be an individual, organization, kingdom, faction, corporation, environment or supernatural system.

## Processing

1. Advance logical time from a validated gameplay event (turn, rest, travel, scene transition).
2. Select due actors within a strict budget.
3. Deterministic policy covers simple scheduled events and resource changes; optional LLM planner produces complex strategic proposals.
4. Validate knowledge, resources, preconditions, ruleset capabilities and expected branch revision.
5. Resolve simultaneous conflicts and apply one atomic event commit per accepted action.
6. Update projections; generate a relevance candidate for Narrative Director.
7. Present immediate consequences and select appropriate discoveries, rumors and plot hooks later.

## Conflict resolution

`resolveConflicts` in `packages/world/src/conflict.ts` takes a batch of proposals and a ruleset claim port. It returns accepted and rejected proposals with reasons. It writes no state.

1. The claim port returns each proposal's exclusive claim keys and a numeric priority. Keys are opaque strings, such as `item:relic`, `territory:valley` or `stance:elves-dwarves`.
2. Contested resources, races and incompatible actions all share one rule: two actions that claim the same key conflict.
3. Malformed proposals are rejected and take no part in resolution. Proposals that share an action ID are all rejected. Proposals with a malformed or failed claim are rejected.
4. The resolver sorts the rest by logical tick (earliest first), then priority (highest first), then action ID.
5. In that order, a proposal wins when none of its keys is taken. A winner takes all its keys. A loser takes none and records the key and the winner.

The order is total, so the result does not depend on input order. The engine still validates and commits each accepted action.

## Narrative Director

Pacing is not outcome manipulation. It operates on presentation timing and optional hook selection, not rule math. Event buckets: background, emerging, major, critical. Suggested balanced heuristics: introduce ~one new major optional storyline at a time, avoid repeated unsolicited interruptions, allow recovery after high tension; these are tunable heuristics, not hardcoded caps. Immediate, obvious major consequences still happen.

## Integrity and failure behavior

- An agent doesn't learn secret facts outside its epistemic scope.
- Simultaneous actions use optimistic concurrency and deterministic conflict resolution.
- Agent calls can time out without blocking player turns. Budget/cost cap degrades to deterministic policies.
- No retry duplicates actions; all proposals have action IDs and expected revision.
- Branch-aware jobs never write into another branch.
- No unattended real-world time skip on campaign close.
- A player can ignore optional leads without unfairly cascading punishment.

## Testing

Factions compete for one artifact; NPC betrayal and player intervention change the next faction plan; long periods elapse through game-time rest; many background events exist but the player is told only relevant ones; high autonomy/low story intensity combination; rewind/fork while scheduled agent plans are pending; LLM provider failure.
