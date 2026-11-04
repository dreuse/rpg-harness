# 03 — Rules, custom systems, rulebooks, house rules

## Design boundary

The engine must not assume D&D or even dice. RulePack declares a versioned mechanical domain. Narrative-only, d20-lite and dice-pool-lite are baseline test packs; other custom systems may use cards, tokens, stress, combat clocks, percentile checks or freeform rulings. A RulePack capability manifest declares what executes deterministically and what requires GM adjudication.

## Import pipeline

1. **Stage:** Explicit user-selected files; safe path handling, MIME/sniff checks, size cap, hash and dedupe. Support PDF, DOCX, Markdown, text, JSON and YAML; selected images/scans with separate image/vision fallback. Preserve originals privately.
2. **Extract:** Identify page/section/title/table/formula; attach provenance and extraction quality. Never fabricate missing pages or sections.
3. **Interpret:** Model-assisted concept extraction into draft rule clauses, mechanics, terminology, examples, character-sheet schemas and supplement references. Document gaps and confidence. Imported text is untrusted context, not instructions.
4. **Compile:** A versioned declarative DSL with safe primitives: random variables/dice, comparisons, arithmetic with bounded values, modifiers, resource costs, conditions, action ordering, decisions, transitions and effects. No arbitrary JS eval.
5. **Validate:** Type checking, cycle detection, fixtures from source book examples, contradictory definitions, missing refs, dice distribution tests, rule coverage report and unsupported mechanism list.
6. **Review:** Show brief summary and material ambiguities. Require user clarification only for mechanics that cannot be safely resolved. Approve explicit fallback adjudication where necessary.
7. **Activate:** Create immutable RulePack revision, pin on campaign, preserve source citations and approved house-rule overlays.

## Rule precedence

High to low: campaign overlay → selected optional rules → explicit accepted errata → compatible supplement → base edition → engine defaults *only for defined permissive gaps*. Never silently merge different editions. Store reason and source on each override.

## Rule edits

Natural-language change: "Critical hits deal double damage" → locate target mechanic, make a new overlay revision, compile, run tests, preview affected derived stats and campaign migration, apply future behavior from effective revision. No changes to historical rolls or event records. Undo is a new revision pointing back, not destructive mutation.

## Character-ficha compatibility

CharacterSheetSchema is a pack output, but sheet source documents are separate import sources. If a rulepack has six stats and an imported ficha has unknown attributes, flag unmatched fields. Do not invent ability scores or silently drop custom fields. Version upgrades may require character migration with a diff and validation.

## Unsupported rules

Unknown mechanics are not guessed. Present a status: `executable`, `gm_adjudicated` (explicitly approved), `blocked_pending_review`, or `not_supported`. For third-party rules, do not imply complete rules fidelity until validated. Source provenance remains available for explaining a roll.

## Security and content ownership

Commercial/user rulebooks are personal imports, not bundled. Avoid redistributing copyrighted source text. Do not execute scripts referenced in the rulebook. Never use imported text as developer instruction. If model-powered interpretation sends text to a cloud provider, make this clear and provide a local/offline option when available.
