# ADR 0022 — Stream GM output into speech

**Status:** Accepted. Extends ADR 0020. **Decision:** Speech starts from streamed segments when spoken output is on. With spoken output off, the narration call stays non-streaming.

- `streamClaudeNarration` runs `claude -p --output-format stream-json --verbose --include-partial-messages` without `--json-schema`. Text deltas become segments through `segmentDeltas`. The final `result` line still goes through `replyOf`.
- `--json-schema` returns the narration as a tool call, so the stream has no `text_delta` events. The schema route keeps the non-streaming `json` call and its speaker tags.
- The streaming route has no speaker tags. Its segments use the narrator voice.
- The `api` route parses SSE `content_block_delta` events with `sseTextDeltasOf`. It feeds the same `segmentDeltas`.
- Segments are held per turn. `StreamingSpeech.commit` releases them to synthesis. `reject` and `stop` discard them. Text renders at once.
- `pause` and `resume` call the optional `pause` and `resume` of the playback sink, so audio already playing pauses. A sink without them pauses at the next chunk boundary.
- stdout of the streaming call is capped at the same size as the non-streaming call. The child is killed past the cap and on any exit from the call.
- Metrics are `first-audio`, `synthesis` and `queue-depth`. They carry numbers only.

## Live turn flow (rpg-cm63.17)

- The engine process speaks. The TUI and the desktop engine daemon both build a `StreamingSpeech` lazily on the first spoken turn. Nothing from the voice package loads while spoken output is `off`.
- `narrateLatest` asks the saved voice settings for the mode. `narrator`, `full` and `cinematic` stream: the gateway passes `onSegment` to the provider call. `dialogue` keeps the tagged non-streaming call and speaks only the non-narrator lines.
- The turn is already committed when narration starts. The first streamed sentence calls `commit(turnId)`. Each later sentence is held and goes straight to the queue because the turn is open.
- `reject(turnId)` discards held items and queued or in-flight audio of that turn, aborts what plays, and drops later segments. The gateway rejects when the stream fails, when the reply replaces the streamed text, or when narration is inconsistent. `stop` marks every known turn rejected, and a turn created before the stop drops its remaining segments by generation. `finish(turnId)` forgets the turn state.
- A reply that did not stream (fake or no-key narrator excluded) is held per segment with its speaker tags and committed once recorded.
- The claude-code stream call and the API stream call carry no speaker tags and no MCP game tools. The claude-code stream call spawns without `--mcp-config`, because tool turns would stream text that the final result does not contain. Tagged NPC voices and MCP reads return when spoken output is off or mode is `dialogue`. Streamed dialogue uses the narrator voice. Revisit when the API accepts a streamed tool call that yields `input_json_delta` segments.
- The API stream call sends `stream: true` without the `narrate` tool. Retries on 429 and 5xx happen before any text arrives, never after.
- The real sink is `createProcessSink`: a platform player process (`/usr/bin/afplay` on macOS, `paplay` on Linux) reading a private temp file. Pause and resume send `SIGSTOP` and `SIGCONT` to the playing process. Abort sends `SIGKILL`. Windows has no player, so the line stays in text.
- Playback commands: the TUI `/pause /resume /skip /stop` call the engine process control. The desktop sends `Playback` to the daemon over a dedicated IPC channel. The daemon answers it outside the request queue, so it works while a narration is still streaming.
- Metrics go to the runtime `VoiceDiagnostics` through `streamingMetricsSink`. They carry numbers only. The TUI reads them with `/voice`, which prints samples, first audio, synthesis time, peak queue depth and error count. The desktop panel does not show them yet.
- The speech runtime lives per data dir. The TUI disposes it on exit. The daemon disposes it before it exits on `Shutdown` and stops playback when it switches campaign. Dispose stops the queue, kills the playing player and removes the temp directory.
- The recorded API narration is the raw streamed text, so paragraph breaks survive. Only the segments handed to speech are trimmed.
- Known limits: the TUI input loop waits for the narration call, so `/pause` works once the reply ends while audio still plays. The desktop shows narration text after the whole reply is recorded. NPC voice assignment is not wired into the live flow, so non-important NPC lines use the narrator voice.
