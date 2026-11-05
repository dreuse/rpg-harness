# ADR 0022 — Stream GM output into speech

**Status:** Accepted. Extends ADR 0020. **Decision:** Speech starts from streamed segments. The default `claude-code` narration call stays non-streaming.

- `streamClaudeNarration` runs `claude -p --output-format stream-json --verbose --include-partial-messages` without `--json-schema`. Text deltas become segments through `segmentDeltas`. The final `result` line still goes through `replyOf`.
- `--json-schema` returns the narration as a tool call, so the stream has no `text_delta` events. The schema route keeps the non-streaming `json` call and its speaker tags.
- The streaming route has no speaker tags. Its segments use the narrator voice.
- The `api` route parses SSE `content_block_delta` events with `sseTextDeltasOf`. It feeds the same `segmentDeltas`.
- Segments are held per turn. `StreamingSpeech.commit` releases them to synthesis. `reject` and `stop` discard them. Text renders at once.
- `pause` and `resume` call the optional `pause` and `resume` of the playback sink, so audio already playing pauses. A sink without them pauses at the next chunk boundary.
- stdout of the streaming call is capped at the same size as the non-streaming call. The child is killed past the cap and on any exit from the call.
- Metrics are `first-audio`, `synthesis` and `queue-depth`. They carry numbers only.
