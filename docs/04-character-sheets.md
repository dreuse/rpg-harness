# 04 — Dynamic character sheets (*fichas*)

## Goal

Make the character profile a first-class, versioned, ruleset-dependent projection. Built-in and imported character sheets must be editable conversationally and optionally through a visual editor; data remains canonical in the engine, not in an editable UI document.

## Types and relationships

`CharacterProfile` holds identity, appearance, personality, goals, background and public/private narratives. `CharacterState` holds mechanical stats, status effects, equipment and resources. `CharacterSheetSchema` declares typed groups, conditional fields, computed expressions, form widgets and visibility rules. `CharacterSheetView` is a filtered renderable projection. The schema may be sparse or completely nonnumeric.

Each field should identify: ID, type, display label, default, constraints, source rule, edit policy, visibility, current value, computed dependency set, optional local formatting hints. Do not embed executable code in templates.

## Creation and updates

- Conversational builder: interpret character concept and map to allowed RulePack fields. Ask only material choices; show honest incomplete state where necessary.
- Manual builder: generated from the schema; full and quick modes; validation lives in engine not client.
- Ficha import: PDF, image, spreadsheet, YAML/JSON, text. Extract with source provenance. Show mapping confidence and unrecognized fields.
- In-game changes: events like `equipment_equipped`, `damage_taken`, `resource_spent`, `relationship_changed`, `character_history_corrected`; recalculations happen after validated commit.
- Ruleset changes: preview field migration; preserve original and historical state; reject incompatible transforms without explicit approval.

## Visibility

Separate player sheet, GM sheet and NPC visible profile. An NPC can start with name/goals and later be promoted to a detailed sheet. Player does not automatically see NPC private motives or stats.

## Renderer contracts

TUI may use grouped stat tables; desktop can show responsive panels, accessibility labels, progress bars and roll animations. A card-based game may show decks/resources and an investigative mystery may show clues/sanity. Unknown field types display a safe generic representation rather than blank data.

## Acceptance examples

1. Narrative character with only background, motivation and ties; valid, playable and editable.
2. d20 rogue equips armor; dependent values recalculate and persist.
3. Imported sheet references attribute absent from active rulepack; import pauses for reconciliation, without deleting content.
4. An NPC's secret appears in GM view but not in player export.
5. A character changes backstory via explicit edit; story memory uses new truth but event history shows correction provenance.
6. Multiple timeline branches diverge in HP and equipment without overwriting each other.
