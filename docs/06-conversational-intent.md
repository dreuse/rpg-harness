# 06 — Natural-language campaign creation and preferences

## The resolver

A `CampaignIntentResolver` converts unstructured player wishes into a proposed typed `CampaignConfig`. It should distinguish explicit choices from assumed defaults. It MUST check installed RulePacks and edition/capabilities before claiming mechanical fidelity. It asks concise clarification only where an unresolved choice is essential.

Example: "I want D&D 5e, dark fantasy, dynamic world, balanced pacing, level-three rogue, and optional voice".

- System = D&D, edition 5e; discover installed/imported rules, not a bundled claim.
- Genre = dark fantasy.
- World simulation = dynamic, attention/pacing = balanced (orthogonal).
- Character request = rogue level 3, validated under selected edition.
- Voice = opt-in, provider selection pending if not configured.
- Missing preferences = reversible recommended defaults, tagged `source: default`.

Incorrect edition (e.g. "D&D 1.9") → acknowledge uncertainty and ask specific question. Other ambiguous aliases/house-rule conflicts need targeted clarification only when they materially change the mechanics.

## Typed config

`system` (id, edition, sourceRevision, enforcement), `genre`, `tone`, `contentBoundaries`, `characterStart`, `worldSimulation` (mode and 3 knobs), `narrative` (pace/structure), `mechanics` (dice policy/encounters/progression), `presentation` (client preferences, visualizations), `voice` (input/output/language), `autonomyBudget`, `provenance` (explicit/derived/default). Version configs and snapshots.

## Mid-campaign changes

Player can say "less random combat, more politics, reduce voice speed". Extract patch, validate against installed capabilities, detect migration for mechanical version changes and commit preference changes. Never retroactively rewrite prior events. A user can save reusable preference presets for future campaigns if opted in.

## Anti-wizard UX

Two good paths: `rpg play` → "Surprise me" → immediately start narrative; or user supplies one detailed sentence → compatibility check → start. Do not bury users in dozens of toggles. Advanced UI is discoverable but not mandatory.
