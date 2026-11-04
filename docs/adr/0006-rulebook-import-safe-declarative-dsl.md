# ADR 0006 — Rulebook import compiles to safe declarative primitives

**Status:** Accepted. **Decision:** Importers preserve source citations, compile supported mechanics into versioned DSL and mark unsupported or ambiguous rules explicitly.

**Context:** Users bring PDFs, house rules and existing fichas; no monolithic engine covers every commercial/custom RPG.

**Rationale:** Declarative expressions allow deterministic checks, validation and sandboxing. Model-assisted interpretation is checked against source and generated tests. House rules overlay originals without modifying source documents or historical outcomes.

**Consequences:** No arbitrary code execution; coverage reports, user review on material uncertainty and migrations on rule changes.
