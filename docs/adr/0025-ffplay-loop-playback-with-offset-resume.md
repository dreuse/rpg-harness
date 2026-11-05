# ADR 0025 — CLI sound loops use ffplay and resume at an offset on volume change

**Status:** Accepted. **Decision:** `createLoopSink` plays through `ffplay` when it is installed. It falls back to `afplay` (macOS) or `paplay` (Linux) when it is not.

**Context:** rpg-cm63.32. The sink respawned the player each time a loop ended, which left a gap. It restarted the track from the start whenever the volume moved by `VOLUME_RESTART_STEP`, so ducking and crossfade restarted the music. `afplay` cannot decode OGG, so bundled music was silent on macOS. A subprocess has no live volume control: `afplay`, `paplay` and `ffplay` fix the volume at launch.

## Decisions

- **Player.** `findFfplayOnSystem` looks in `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin` and `PATH`. With ffplay the sink runs `ffplay -nodisp -autoexit -loglevel quiet -volume <0-100> -loop 0 <file>`. `-loop 0` loops without a gap. ffplay also decodes OGG. On Windows the lookup searches for `ffplay.exe`; this path is untested.
- **Live volume.** A volume change kills the player and starts ffplay again at `-ss <elapsed>` with millisecond precision, so the track continues where it was. Crossfade respawns the player about every 200 ms, so the offset is never rounded to whole seconds. The offset is `elapsed % duration`. `start` probes the duration once with `ffprobe` (`ffprobe` or `ffprobe.exe` in the ffplay directory) and caches it per file. A volume change never probes.
- **ffprobe failure.** If ffprobe is missing or fails, the duration is unknown and the offset is the raw elapsed time. Once the offset passes the track length, ffplay exits at once and the sink restarts the loop from zero at the new volume. The track then restarts at most once per loop length. Playback keeps working.
- **Why no `-loop 0` on a resumed segment.** ffplay seeks back to the `-ss` value, not to zero, at the end of each loop. A resumed segment plays once. When it ends, the sink starts a normal looping player from zero. The only gap is the one at that wrap.
- **Fallback.** Without ffplay the sink keeps the old behaviour: `afplay` or `paplay`, respawn at loop end, restart on a volume change of `VOLUME_RESTART_STEP` or more. WAV, MP3 and AIFF keep working. OGG on macOS stays silent until ffplay is installed.
- **One-shot effects.** `effect:` layers play once, without `-loop`. A finished effect is not replayed by a later volume change, and starting the same effect again stops the first player. `dispose` kills every child, including effects that are still playing. The sink also calls `dispose` on process `exit`.
- **Testing.** The tests inject `spawn`, `findFfplay`, `durationOf` and `now`.

## Consequences

- A volume change still costs a short restart of the player process. Crossfade makes several of them. A true in-process mixer (decode to PCM and apply gain in Node) would remove them. It needs a PCM output device that stdlib Node does not provide.
- ffplay is an optional system dependency. The sound settings should tell the player to install ffmpeg when music is silent on macOS.
