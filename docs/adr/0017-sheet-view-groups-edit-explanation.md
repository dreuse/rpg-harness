# ADR 0017 — Sheet view components carry group, edit right and explanation

**Status:** Accepted. **Decision:** Each sheet view component may carry three optional plain-data keys: `group`, `editable` and `explanation`. The CLI views layer fills them from `buildSheetView` in `packages/rules/src/sheet-view.ts`. Clients edit through the existing `EditSheetField` command. The engine stays the only state writer.

**Context:** rpg-42a.21. The desktop and the TUI showed the sheet as one flat list. They could not edit a field or show how a computed value came out.

## Protocol

| Key | Type | Meaning |
|---|---|---|
| `group` | non-empty string | SheetView group id: `core`, `custom` or `computed` |
| `editable` | boolean | The viewer may send `EditSheetField` for this field |
| `explanation` | string | Formula, bonuses and constraint notes of a computed value |

- `parseViewDescriptor` accepts only these keys in addition to the existing ones. A wrong type fails with `MalformedCommand`.
- All three keys are optional. Older clients ignore them.
- Labels are the RulePack display names. The field id is the fallback.
- The explanation is text, for example `= might + 2; +3 Shield; limited from 11`. Clients never evaluate it.

## Refresh after an edit

- The engine stores `SheetFieldEdited` with `player` visibility. Before this change it used the `gm` default, so player subscriptions never received it.
- The daemon pushes `EventCommitted` for the edit to player and GM subscribers. An open sheet view reloads.
- Actor-scoped subscribers do not receive the event, because they read only public events and events scoped to their own actor.
- For a non-GM viewer, the subscribe path strips `fieldId` and `value` from the event when the field's trait visibility does not show it to that viewer. A profile without `traitVisibility` shows the edit only to its owner. The event still triggers the refresh, and the reloaded view applies the same rules.

## Clients

- Desktop: one titled section per group. An editable field is a labelled input with a Save button. An engine rejection shows as an alert tied to the input. A computed value is focusable and shows its explanation as a tooltip on hover and on focus.
- TUI: group headings in the sheet pane. `/edit <field> <value>` sends `EditSheetField`. The TUI checks the value type before it sends and prints the engine error on rejection.

## Consequences

- No new package and no new dependency.
- The TUI does not show explanations yet.
- `editable` follows the SheetView edit rules for the viewer. The engine still rejects any edit that `editableSheet` does not allow.
