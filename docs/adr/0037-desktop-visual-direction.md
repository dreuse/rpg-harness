# ADR 0037 — Desktop visual direction: candlelit manuscript

**Status:** Accepted (rpg-42a.158). **Decision:** The desktop app looks like a lit manuscript. Parchment and ink in the light theme, a candlelit dark room in the dark theme, a gold accent in both, serif type for the story and sans type for controls. All values are CSS tokens in `apps/desktop/src/tokens.css`. System fonts only.

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

**Consequences:** One accent family and one type system for all screens. Visual baselines in `apps/desktop/visual-baselines/darwin` were regenerated with `RPG_DESKTOP_UPDATE_BASELINES=1`. A future theme changes `tokens.css` only.
