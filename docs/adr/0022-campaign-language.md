# ADR 0022 — Campaign language

**Status:** Accepted. **Decision:** Each campaign has a language. The language is set at creation, defaults to the UI locale, and the player can change it later (rpg-42a.67). The GM writes narration and summaries in it on every route. The intent parser reads English and pt-BR together. The voice locale follows the language when a provider speaks it.

**Context:** rpg-42a.40. A pt-BR player got English narration, English summaries and an English voice, and the parser ignored pt-BR phrasing.

## Storage

- The language is an optional `language` field in the `CampaignCreated` payload. Old campaigns have no field. `campaignLanguageOf` returns `undefined` for them, so they keep their old behaviour: no language line, no `language` in the snapshot, and the system voice locale.
- `engine.createCampaign(name, language?)` rejects a value that is not a BCP 47 tag. `CreateCampaign` validates `language` as a locale at the protocol boundary.
- A `CampaignLanguageChanged {language}` event records a later change. `SetCampaignLanguage` (desktop "Story language", TUI `/language <locale>`) validates it as a locale and writes it at the expected revision. The next GM request and spoken turn use it. History is not translated.
- `campaignLanguageOf(events)` reads the latest of the two events back. The snapshot sends `language` only when one is recorded.
- `rpg new` sends the CLI locale. The guided start sends the client locale.

## GM

- When the campaign has a language, the packet `instructions` section holds the system prompt plus one language line: `Write all narration, dialogue and summaries in <English name> (<tag>), whatever language the data uses.`
- The `api` route already used the packet instructions as its system prompt. The `claude-code` route now does the same, instead of a fixed prompt, so both routes get the line.
- Summaries get the same line through `summaryPrompt(language)`, or the plain summary prompt when no language is recorded. `summarizeCampaign` passes the language to every summarizer call.

## Parser and packs

- The parser has no language parameter. It always reads English and pt-BR cues, which follows "everything supported". pt-BR cues use `\p{L}` lookarounds, because `\b` is ASCII-only.
- In pt-BR, `no` means "in the". Each cue therefore carries its own negation words. English cues use the English and pt-BR words. pt-BR cues use only `não`, `sem`, `nunca`, `nada` and `nenhum(a)`. The shared edition cues (`D&D 5e`, `D&D 5ª edição`) use every word except a bare `no`.
- pt-BR editions accept `ª`, `º` and `a` (`5ª edição`). The resolver reads them as the same edition number, so `D&D 5ª edição` resolves to the `5e` pack.
- Built-in genre and rules packs stay in English. pt-BR genre names (`fantasia`, `terror`, `ficção científica`, `mistério`, `moderna`, `mundo em branco`) are genre aliases. On the genre and rules steps, a player with a non-English locale sees a notice that the packs are in English and that the GM still narrates in their language.

## Voice

- A campaign without a recorded language keeps the system locale.
- `voiceLocaleFor(campaignLanguage, fallback)` returns the campaign language when a provider in `LANGUAGE_VOICES` speaks it, else the fallback. The TUI and the desktop app use it for the default voice locale, with the system locale as the fallback. Saved voice settings still win.
