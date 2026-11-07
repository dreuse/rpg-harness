# ADR 0037 — Desktop visual direction: candlelit manuscript

**Status:** Accepted (rpg-42a.158, layout in rpg-42a.159). **Decision:** The desktop app looks like a lit manuscript. Parchment and ink in the light theme, a candlelit dark room in the dark theme, a gold accent in both, serif type for the story and sans type for controls. All values are CSS tokens in `apps/desktop/src/tokens.css`. System fonts only.

**Context:** The owner called the UI poor and generic. The old palette was neutral grey with a slate-blue accent, and every screen used the same sans stack. Player, GM and system lines were hard to tell apart. Narrow windows squeezed the action input to a few characters. With Settings open the action form was drawn over the settings text.

**Decision details:**
- Palette (light / dark): `--surface` parchment `#f2e9d6` / near-black brown `#171310`; `--surface-raised` `#fbf6ea` / `#211b16`; `--text` ink `#2a2017` / cream `#efe6d4`; `--accent` bronze `#7a5212` / candle gold `#e3b866`. Danger stays red, focus stays blue, so accent, failure and focus never share a hue.
- New token `--speaker-player` (blue ink `#2f4a75` / `#a9c0e6`). It has AA checks on both surfaces and an AAA override in the high-contrast block. `design-tokens.test.ts` covers it.
- Type: `--font-display` (Iowan Old Style, Palatino, Book Antiqua, Georgia) for h1 to h4, stat numerals, option labels and roll outcomes. `--font-narration` (Charter first) for GM text. `--font-body` for controls and player text. No web fonts, no download.
- Speakers: GM lines are serif with a gold rule on the start edge. Player lines sit on the end edge in blue ink with a blue rule. System and roll lines are small, muted, italic and centred. Out-of-character player lines use the player ink.
- NPC lines have no markup of their own in the transcript yet (narration is one string). No NPC style was added. Add a `--speaker-npc` token and a `[data-speaker="npc"]` rule when the engine marks NPC dialogue.
- Structure: a double rule under the header, section labels as small tracked capitals, a gold top edge on campaign cards, new tokens `--space-5`, `--text-2xl`, `--leading-tight`, `--tracking-label`, `--columns-min` and `--action-input-min`. Radii went from 4 and 8 px to 3 and 6 px.
- Motion: only hover shadow, a 1 px press and the existing roll animations. All use duration tokens, which are 0 ms under `prefers-reduced-motion` and in the motion setting. No entry animation on transcript lines, because the view re-renders the list and would replay it.
- Layout fixes found in screenshots: the play screen scrolls inside `main` with a minimum column height, so the action form no longer overlaps open settings. The action form wraps and the input has a minimum width. Inputs, selects and checkboxes use tokens instead of browser defaults.
- Kept: focus rings, 44 px targets (`--target-min`), `prefers-contrast: more` overrides, `prefers-reduced-motion`, no raw colours in `view.css`.

**Layout (rpg-42a.159):**
- Transcript: a flat reading column, no box. It is `--measure` (70ch) wide and centred in the main column, and it scrolls with everything below it. The roll result, roll offer and report form follow the last line inside the same column, so there is no gap and no separate card. The out-of-character panel stays a raised card. The roll result keeps only a start-edge rule.
- Side panel: at medium and wide widths the sheet, character and journal sit in a narrow column (`--side-panel-width`, 20rem at wide, one third at medium). A hairline on its start edge and hairlines between regions replace the boxes. The sheet has no nested boxes: the group name is a small capitals heading with a rule, and each stat is a row (label at the start, value and `roll +N` at the end) with a divider. Settings sections are flat too, split by a rule.
- Compact widths keep one column with the three pane buttons. The same flat styles apply.
- Action bar: the input, then Send as the only `data-primary` button, then Talk to the GM and What the story remembers as quiet text buttons (transparent, muted, border only when pressed or hovered). The replay button on narration lines is a muted icon with a 44 px target.
- Title focus: the campaign heading keeps programmatic focus for screen readers. The page records the last input device (keyboard or pointer) and passes `focusVisible` to `focus()`, so the ring shows after a keyboard load and not after a mouse load. The CSS rule stays on `:focus-visible`.
- Roll modifier: the roll card shows the modifier used at roll time. The sheet shows the current score. They differ only when the sheet is edited after the roll. The capture journey now edits Agility after the Might roll, so screenshots agree.

**Consequences:** One accent family and one type system for all screens. Visual baselines in `apps/desktop/visual-baselines/darwin` were regenerated with `RPG_DESKTOP_UPDATE_BASELINES=1`. A future theme changes `tokens.css` only.
