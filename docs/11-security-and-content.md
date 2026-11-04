# 11 — Security, privacy, licensing and cost boundaries

## Trust boundaries

- Player-imported books, character sheets, setting text, tool results, transcriptions and NPC dialogue are **untrusted input**.
- Never promote retrieved text to Claude Code system/developer instructions.
- Never execute embedded code, shell snippets, scripts, document macros or model-generated TS through imports.
- Rule DSL is interpreted with validated bounded primitives; plugins requiring real code must come from a separately trusted/approved installation path.
- Sanitize HTML/Markdown for view rendering and never allow arbitrary remote resources from user files.
- Validate archive paths and sizes. Reject path traversal, symlinks outside import root, zip bombs and unexpected file types.
- UI IPC/MCP tools only expose typed operations, authorization checks and campaign-scoped reads.
- Secrets are excluded from logs, telemetry and exports by default; player-known and GM-only data have distinct authorization views.

## Privacy

Local SQLite is the default. Only send text to external model/STT/TTS services when the user has configured them and understands provider processing. Provide a local processing path when supported and transparently describe limitations. Default to not retaining microphone audio, and provide retention controls and transcript deletion semantics.

## Commercial rules

Do not bundle proprietary RPG rulebooks, trademarked setting books or paid character packs. Let users import their lawful documents for personal use, with original source references, and avoid exporting full copyrighted documents into public packages. Built-in d20-lite and pool-lite mechanics must be original expressions and not misleadingly branded as official commercial editions.

## Provider authentication

Claude Code may be an initial development/play harness; independently distributed client integrations should use supported authentication mechanisms and comply with provider terms. Do not collect OAuth tokens from consumer Claude sessions or build an app that intermediates consumer credentials. Read latest official legal/auth docs before desktop distribution: https://code.claude.com/docs/en/legal-and-compliance .

## Cost and resource controls

Model-driven world actors have token quotas and agent-call budgets; deterministic fallback handles simple events. Voice providers offer explicit cost visibility and can be switched off. Never silently accrue uncapped costs for a closed campaign or runaway simulation.

## Failure classification

Treat invalid rule DSL, missing edition, unsupported voice, STT confidence loss, failed agent jobs, migrations, duplicate actions and stale branches as distinct typed failures. Default to refusing unsafe state changes while preserving the player's ability to continue text-only, narrative gameplay.
