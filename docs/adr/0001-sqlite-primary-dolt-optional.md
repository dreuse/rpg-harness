# ADR 0001 — SQLite first, Dolt optionally for campaign storage

**Status:** Accepted for planning. **Decision:** SQLite is default game storage; Dolt is optional later. Development Beads is entirely separate.

**Context:** The user wants a one-command game with durable data and branching. Requiring a database server complicates onboarding.

**Rationale:** SQLite provides robust local transactions and easy packaging. Event log + branch metadata can implement non-destructive timelines. A storage port allows Dolt to be added with history/diffs when it produces a demonstrable advantage.

**Consequences:** Maintain careful event replay/projection testing and storage adapter contract suite. Avoid conflating Beads' Dolt internals with player campaign data.
