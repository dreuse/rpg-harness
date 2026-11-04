# ADR 0013 — One visual design system for desktop and TUI, in plain CSS and a small terminal theme module

**Status:** Accepted. **Decision:** The desktop page uses plain CSS with custom properties ("tokens") on `:root`. The TUI uses `apps/cli/src/theme.ts` for color depth, pane borders and styles. No CSS framework, no icon font, no new dependency.

**Context:** rpg-42a.11. The desktop page and TUI panes worked but looked plain. The look must stay fantasy-neutral, because every GenrePack (fantasy, noir, sci-fi, user worlds) shares one client. The page loads under a strict CSP (`style-src 'self'`, ADR 0011/UI08), so styles must be same-origin files.

## Desktop tokens

All tokens live in `apps/desktop/src/tokens.css`. View rules live in `apps/desktop/src/view.css` and may only reference tokens for color. `design-tokens.test.ts` fails on any hex, `rgb()`, `hsl()` or named color in view CSS.

| Group | Tokens | Rule |
|---|---|---|
| Color | `--surface`, `--surface-raised`, `--text`, `--text-muted`, `--border`, `--border-strong`, `--accent`, `--focus`, `--danger` | Each is `light-dark(light, dark)`. Text pairs pass WCAG AA (4.5:1); high-contrast pairs pass 7:1; accent, focus and control borders pass 3:1. Checked by test. |
| Type scale | `--text-sm` 0.875rem, `--text-md` 1rem, `--text-lg` 1.25rem, `--text-xl` 1.5625rem | Ratio 1.25. Multiplied by the saved `--font-scale`. `system-ui` stack, line height 1.5, weights 400 and 600. |
| Spacing | `--space-1` … `--space-8` (0.25rem steps: 1, 2, 3, 4, 6, 8) | 4 px base grid. |
| Shape | `--radius-1` 4px, `--radius-2` 8px, `--border-width`, `--marker-width` | High contrast doubles the border width. |
| Focus | `--focus`, `--focus-width`, `--focus-offset` | `:focus-visible` on every element draws a solid outline. Views never remove outlines. |
| Motion | `--duration-fast` 120ms, `--duration-base` 200ms, `--ease` | Only color, border and shadow transitions. No motion that carries meaning. Durations become 0 under `prefers-reduced-motion: reduce` or the saved reduced-motion preference (`data-animate="false"`). |
| Layout | `--content-max` 90rem, `--sidebar` 16rem, `--target-min` 2.75rem | CSS grid on `main[data-layout]`. Breakpoints stay in `layoutFor` (720/1200 px); CSS only maps `compact`, `medium` and `wide` to 1, 2 or 3 columns. |

- **Themes:** `color-scheme: light dark` plus `light-dark()` follows the OS (`prefers-color-scheme`). `@media (prefers-contrast: more)` swaps in the high-contrast values. Windows forced-colors mode is left to the browser.
- **GenrePack accent:** `--accent` is the only token a GenrePack may change. It marks the selected campaign and hover borders. Keyboard focus uses the separate `--focus` token. The accent never carries body text, so a pack color cannot break text contrast. Packs that set it should keep 3:1 against `--surface`.
- **Iconography:** no icons today. When added: inline SVG on a 20 px grid, 1.5 px stroke, `currentColor`, always next to a text label, `aria-hidden="true"`. No icon fonts and no remote images (CSP `img-src 'self'`).

## TUI theme

- **Color depth:** `colorDepthOf(env, stdout)` uses Node's `tty.WriteStream#getColorDepth`. Result is `truecolor`, `256`, `16` or `none`. `NO_COLOR` and `TERM=dumb` give `none`. Piped output gives `none` unless `FORCE_COLOR` is set. `FORCE_COLOR` wins over `NO_COLOR` (Node's order).
- **Roles:** `title` (bold), `muted` (faint), `accent` (cyan / 256-color 67 / `#6f86c6`). Body text keeps the terminal's own colors, so light and dark terminal themes both stay readable.
- **Borders:** rounded box drawing (`╭─╮`) for panes, heavy lines (`┏━┓`) for the focused pane, so focus shows without color. ASCII fallback (`+-|`, focused `=`) when the locale is not UTF-8 or `TERM=dumb`.
- **Layout:** tab row, panes, status row; the screen fills the terminal height. Below 120 columns one focused pane shows. From 120 columns the conversation stays on the left (60%) and the focused pane, or the sheet, shows on the right. Conversation, log and mechanics show the latest rows; sheet and help show the first rows.
- **Piped mode** stays linear plain text with no borders, for screen readers and logs.

## Rationale

- Plain CSS covers everything needed: custom properties, `light-dark()`, `prefers-contrast`, `prefers-reduced-motion`, `:focus-visible`, grid and `:has()` ship in Electron's Chromium. A framework would add a build step the no-bundler renderer (UI08) does not have, and its class names would leak into `view.ts` markup.
- Tokens in one file make the contrast check and the hard-coded color check mechanical.
- Node already detects color depth and honors `NO_COLOR` and `FORCE_COLOR`, so the TUI adds no detection code of its own.

## Consequences

- `serveAsset` also serves `.css` files, with the same CSP header.
- Screenshots: `RPG_DESKTOP_CAPTURE_DIR=<dir>` with the smoke mode makes Electron save `<layout>-<theme>.png` for `compact`, `medium` and `wide` in `light`, `dark`, `high-contrast-light` and `high-contrast-dark` (CDP media emulation). `electron-smoke.test.ts` runs it when the Electron binary is installed.
- Not done: a GenrePack field that sets `--accent`, and a matching TUI accent. Both need a content and protocol change.
