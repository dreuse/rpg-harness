# P01 — Personas, journeys and capability matrix

Traces to: `docs/01-product-contract.md`, `docs/06-conversational-intent.md`, ADR 0003.

## Personas

| Persona | Wants | Must never face |
|---|---|---|
| Casual player | One sentence, then play | Forms, rule jargon, forced setup |
| Rules player | Exact mechanics of an installed system | Fake fidelity, silent edition swaps |
| Homebrewer | Import books, edit house rules | Untraceable rule changes |
| Story player | Narrative only, no numbers | Dice, stats or combat forced on them |
| Accessibility user | Voice or screen reader | A feature that works only in one modality |

## Onboarding journey

1. `rpg play`.
2. If campaigns exist, offer resume or new.
3. New: player types a sentence or "surprise me".
4. Resolver builds `CampaignIntent`; each field is tagged `explicit`, `derived` or `default`.
5. Resolver checks installed RulePacks.
   - Match: continue.
   - Missing pack: offer import or another installed pack. Never claim the pack exists.
   - Unknown edition ("D&D 1.9"): ask one targeted question.
6. Show only defaults that change play (ruleset, dice on/off). Player may accept or edit.
7. Create character from the concept, or skip stats for narrative packs.
8. Narrate the first scene.

## User stories

| ID | Story | Acceptance evidence (task) |
|---|---|---|
| US1 | Start a campaign from one sentence | N-epic resolver tests, V05 |
| US2 | Missing rules → offer import, no invented content | N-epic resolver fixture "missing pack" |
| US3 | Invalid edition → one clarifying question | N-epic fixture "D&D 1.9" |
| US4 | Play with every optional capability off | Q-epic full-off smoke test |
| US5 | Quit and resume with no state loss | V07/V08 save/resume |
| US6 | Change preferences mid-campaign by conversation | N-epic preference patch tests |
| US7 | Import a ficha and see ambiguities flagged | S-epic import tests |
| US8 | Turn voice on, then off, same campaign | A-epic toggle tests |

## Non-goals

Taken from the product contract "Out of scope initially": multiplayer, real-time offline progression, plugin marketplace, 3D/physics, bundled commercial rules, mandatory AI agents, stored unconsented audio, reuse of consumer Claude Code login in a distributed app.

## Capability matrix

`Core` = always on, required for safe play. Every other row is optional at runtime.

| Capability | Class | Default when unspecified | Who may enable | Disabled path |
|---|---|---|---|---|
| Storage, state validation, campaign identity | Core | on | — | n/a |
| Intent / context handling | Core | on | — | n/a |
| Dice / RNG | Optional | on only if the selected RulePack declares dice | player | GM-adjudicated outcomes, labeled |
| Numeric attributes | Optional | from RulePack | player | narrative character |
| Combat / encounters | Optional | from RulePack | player | narrative resolution |
| Living-world simulation | Optional | off | player | static world, GM-driven |
| Narrative Director pacing | Optional | balanced | player | no pacing hints |
| Voice input (STT) | Optional | off | player, after mic permission | text input |
| Voice output (TTS) | Optional | off | player | text output |
| Ambience audio | Optional | off | player | silence |
| Dice visualization | Optional | off | player | text roll result |
| TUI / desktop client | Optional | off (CLI) | player | CLI |
| Rulebook import | Optional | off | player | built-in packs |
| House rules overlay | Optional | none | player | base RulePack |
| Timeline branching | Optional | linear | player | single branch |
| Dolt storage | Optional | off (SQLite) | player | SQLite |

Rules:

- A pack can recommend a capability. It cannot force one unless the player accepts a rules-level requirement.
- Every default is reversible and stored with `provenance: default`.
- Unspecified voice, simulation and audio stay off. Dice follow the selected pack and can be turned off.
- Disabling a capability never deletes events. Re-enabling resumes from canonical state.

## Open questions

1. "Surprise me" default ruleset: a built-in lightweight pack with dice, or pure narrative? Decide in C/R epics.
2. Should the onboarding confirmation step be skippable by a saved preset? Decide in N epic.
