#!/usr/bin/env python3
"""Build the human-readable and atomic Beads plans from the planning catalog."""
from pathlib import Path
import json, re, collections, hashlib
BASE = Path(__file__).resolve().parents[1]
EPICS = {
 'P': ('Product requirements and architecture','M0','product'),
 'V': ('First playable vertical slice','M1','foundation'),
 'D': ('Persistence and canonical memory','M2','memory'),
 'R': ('Ruleset engine and mechanical resolution','M2','rules'),
 'G': ('Game Master and core world engine','M2','gameplay'),
 'U': ('Player onboarding and CLI experience','M2','ux'),
 'C': ('Genre and setting packs','M2','content'),
 'T': ('History, checkpoints, and branching timelines','M2','timelines'),
 'I': ('Rulebook ingestion and house rules','M2','import'),
 'N': ('Natural-language campaign intent','M2','intent'),
 'S': ('Dynamic character sheets / fichas','M2','characters'),
 'W': ('Optional living-world simulation','M2','simulation'),
 'UI': ('Headless client API, TUI and desktop','M3','ui'),
 'A': ('Optional voice and audio','M3','audio'),
 'Q': ('Verification, security and release','M3','quality'),
 'X': ('Optional Dolt game-storage adapter','M4','storage'),
}
# Task syntax: KEY | title | blocking dependencies comma-separated | primary acceptance | essential edge case / regression criterion
TASKS = r'''
P01|Specify product journeys and capability policy||Define personas, onboarding journey, user stories, non-goals and a supported-not-enforced feature matrix|Unspecified preferences use reversible defaults; no player is forced to enable voice, dice, or simulation
P02|Define engine boundaries and domain architecture|P01|Document ports/adapters, domain modules, canonical state owner, and event/data flow|No UI, voice adapter or model provider owns game mechanics or database mutations
P03|Spike Claude Code skill, MCP and launch transport|P01|Demonstrate a local model call via project skill and typed MCP read tool|Do not conflate Claude Code subscription login with arbitrary third-party app API authentication
P04|Define data integrity and tool security policy|P02|Document transactions, idempotency, fact visibility, capabilities and untrusted document handling|A malicious rulebook cannot invoke shell commands or expose unrelated local files
P05|Define quality gates, ADR process and milestones|P02,P03,P04|Publish M0-M4 gate contracts, executable validation profiles and issue completion evidence policy|Planning/documentation issues have distinct verification from code issues
V01|Bootstrap strict TypeScript workspace and CI basics|P05|Create pnpm workspace, strict TS setup, test runner, formatting and lint commands|Clean checkout fails clearly if toolchain prerequisites are missing
V02|Implement basic rpg CLI shell|V01|Provide launch, new, play, resume and help scaffolding with accessible terminal output|Unsupported commands or invalid arguments do not corrupt campaign data
V03|Implement SQLite local database bootstrap|V01|Create local SQLite database, versioned migrations and repository connection lifecycle|Interrupted migration can be detected or recovered without deleting user data
V04|Expose minimal campaign MCP tools|V02,V03|MCP tools can create, read and update a tiny test campaign with typed schemas|Invalid or oversized tool requests are rejected cleanly
V05|Implement minimal campaign, character, scene and turn|V04|Store and retrieve a campaign, character, current scene and single turn|Opening the same campaign after process restart yields identical identifiers and state
V06|Build initial Claude GM skill|V05|Skill narrates one scene, reads engine state and interprets one player input|Narration never substitutes for persistent state mutation
V07|Implement first validated action commit|V06|Player can perform an action and persist a validated corresponding state change|A failed action produces no partial state mutation
V08|Pass create/play/restart/resume smoke test|V07|Scripted test creates a campaign, plays multiple turns, exits and resumes|Duplicate tool calls cannot duplicate the committed action
D01|Define versioned campaign database schema|V08|Implement migrations for campaign, entities, ruleset refs, facts, events, sessions and visibility|Upgrades preserve user data and reject incompatible schema versions predictably
D02|Implement append-only event repository|D01|Persist ordered immutable domain events with campaign, timeline, actor and logical time|Historical event writes cannot be silently overwritten
D03|Implement typed entity and relationship repositories|D01|Persist stable-ID NPCs, locations, factions, items and relationships|Dangling references and cross-campaign entity access are rejected
D04|Implement atomic idempotent turn transactions|D02,D03|Validate preconditions and commit effects/events with revision checks and idempotency keys|Concurrent turns or retry after timeout do not duplicate inventory or rewards
D05|Implement facts, beliefs, rumors and knowledge scopes|D02,D03|Separate canonical facts, character beliefs, player-known facts and GM secrets|An NPC rumor is not promoted to truth; player tools cannot retrieve secret facts
D06|Implement bounded relevant context retrieval|D04,D05|Retrieve current scene, related entities, active threads and provenance with token budget|Long campaign retrieval excludes irrelevant history without losing required constraints
D07|Implement historical search and summary projection|D06|Provide full-text event search, summaries and provenance-preserving condensation|Summaries cannot alter canonical fact records or claim non-existent evidence
D08|Implement recovery, migrations and persistence tests|D07|Pass crash, duplicate action, migration, backup-read and branch-scoping tests|Interrupted writes remain atomic and a resume returns the last committed turn
R01|Define RulePack API and capability manifest|V08|Specify versioned mechanical contracts, supported primitives and capability introspection|No default d20 stat, dice or combat field is required
R02|Implement extensible character trait domain|R01|Model typed traits, resources, tags, conditions and derived fields without hardcoded game stats|Narrative-only characters work with zero numerical attributes
R03|Implement authoritative randomness and roll audit|R01|Support dice pools, rolls and injectable seeded RNG with event capture|Claude cannot supply a fabricated result as a trusted engine roll
R04|Implement generic check and action resolution|R02,R03,D04|Execute typed preconditions, modifiers, resource costs and consequences as deterministic transactions|Invalid action or insufficient resources leaves all state unchanged
R05|Implement narrative ruleset|R04|Run full adventures without mandatory dice, HP, levels, classes or combat|Narrative adjudication is clearly marked rather than masquerading as strict mechanics
R06|Implement original d20-lite ruleset|R04|Support attributes, difficulty checks, combat turns, resources and progression|Edge cases such as critical effects and negative modifiers pass deterministic tests
R07|Implement original dice-pool-lite ruleset|R04|Support pool rolls, success counting, complications and configurable thresholds|Zero dice, mixed successes and opposed checks resolve consistently
R08|Implement inventory, equipment, effects and progression|R05,R06,D04|Track equipment, resources, effects and progression through ruleset-specific actions|Unequipped modifiers disappear; impossible item spend and illegal level-up are rejected
R09|Verify ruleset isolation and compatibility|R07,R08|Run same domain test suite across narrative, d20-lite and dice-pool-lite packs|Switching genre requires no core ruleset change and vice versa
G01|Build canonical GM context assembler|D06,R02|Construct scoped relevant context for Claude with rules and source references|No hidden NPC knowledge or GM-only secret appears in player-facing context
G02|Implement natural-language player action interpretation|G01,R04|Map freeform intent into typed action proposals including unexpected actions|Clarify only mechanically consequential ambiguity; do not railroad choices
G03|Implement persistent NPC goals, knowledge and relationships|G01,D05|NPC state, memory, relationships and information channels influence dialogue|NPCs cannot act on facts they have not learned
G04|Implement encounter lifecycle and actions|G01,R04|Persist encounter initiation, transitions, mechanical turns and resolution|Resume mid-encounter without rerolling previously committed mechanics
G05|Implement quests, objectives and dependencies|G02,G04|Track active/completed/failed quests and prerequisites linked to events|Quest cannot complete twice or activate unmet prerequisites silently
G06|Implement logical time, world clocks and consequences|G05|Advance event clocks and delayed effects only on approved game-time triggers|Closing the app does not unexpectedly advance game time
G07|Implement narrative pacing service|G03|Represent scene tension, pacing intent and player-attention budget without manipulating dice|Quiet scenes remain possible even with outstanding world activity
G08|Implement GM consistency checks and secret discipline|G06,G07,D05|Validate narration claims against committed events and known facts|Uncommitted damage, impossible equipment and secret leaks are detected
G09|Integrate end-to-end gameplay orchestration|G08,D08,R09|Commit mechanics before narrated results across combat, investigation and social scenes|Model interruption resumes from committed state without duplication
U01|Build accessible interactive CLI foundation|V08|CLI accepts freeform turns and supports keyboard-friendly history, help and errors|Gameplay does not require commands for normal actions
U02|Implement low-friction quickstart and resume flow|U01,N07|New users can start with default choices or one-sentence campaign intent|Missing ruleset files are surfaced honestly instead of invented
U03|Implement conversational and guided character creation|U02,S05|Create valid characters from descriptions or guided choices|An ambiguous required mechanical choice is asked once, not silently invented
U04|Implement campaign management and switching|U02,D06|Create, list, select, resume and archive campaigns without cross-campaign leakage|Deletion requires explicit intent and offers backup/export guidance
U05|Implement terminal sheets, inventory, journal and recap|U04,S04|Read character state, inventory, important events and quests using concise commands|Player-facing views never expose hidden GM-only data
U06|Implement dice and encounter terminal presentation|U03,G04|Display trusted rolls, modifiers and encounter outcomes in readable text|Hidden GM rolls and narrative-only rulesets do not expose invented dice
U07|Implement import/export, backups and restore|U04,D08|Round-trip campaigns and rulepack version pins through portable validated archives|Untrusted archives cannot write outside application data directory
U08|Implement packaged rpg launch and setup checks|U06,U07|Provide single-command play, install docs, first-run checks and clean error messages|System works without background services or user-managed SQLite setup
C01|Define genre templates and pack loader|G01,R01|Load versioned thematic templates independently of the RulePack mechanics|Genre packs cannot execute arbitrary code or mutate engine schemas
C02|Build fantasy and science-fiction genre packs|C01,R05|Provide distinct opening scenes, NPC archetypes, conflicts and tone for both|Both packs can run under narrative rules without assumed spell/space combat mechanics
C03|Build horror and investigative mystery packs|C01,R05,D05|Provide tension, clue tracking, information concealment and investigation pacing|Secret solutions cannot leak through generic memory retrieval
C04|Build modern adventure and blank world templates|C01,R07|Support grounded modern stories and entirely user-defined settings|Blank world does not force classes, combat or supernatural elements
C05|Implement coherent scenario and setting generation|C02,C03,C04|Generate consistent locations, factions, hooks and starting NPCs with provenance|Regeneration does not silently replace persistent canon in an existing campaign
C06|Verify genre-ruleset combinations and overrides|C05,R09|Exercise multiple genres with multiple compatible rule systems|Incompatibilities are reported rather than covered up by fallback d20 rules
T01|Build replayable event projections and checkpoints|D08|Reconstruct canonical state from events plus versioned snapshots|Replay state matches directly materialized state and recorded roll outcomes
T02|Implement checkpoint creation and restoration|T01|Create, list and restore checkpoint pointers without overwriting history|Invalid checkpoint or incompatible version produces no partial restore
T03|Implement branch ancestry and isolation|T02|Fork campaigns non-destructively with stable branch identifiers and shared ancestry|Background world actions cannot leak across branches
T04|Implement branch diff and history navigation|T03|Compare facts, relationships, quests, resources and inventory between two branches|Historical diff is deterministic and excludes secrets from player view
T05|Implement safe rewind and choose-timeline UX|T04,U04|Player can fork at checkpoint, inspect ramifications and select active branch|Rewind preserves previous timeline and presents clear confirmation of branch choice
T06|Stress-test branch replay, recovery and isolation|T05|Run forks, retries, restarts and replay consistency tests|No branch corruption even with concurrent scheduled world events
I01|Specify importer file formats and provenance model|P01,P02|Define PDF, DOCX, text, Markdown, YAML and JSON ingest journey with failure states|User content is untrusted and cannot imply permission to execute instructions
I02|Implement multi-document import staging|I01,V03|Stage multiple files with type/size validation, integrity hashes and source identity|Path traversal, oversized payload and unsupported file types produce safe errors
I03|Extract text, tables, pages and image fallback|I02,D01|Preserve page/section references, extraction confidence and tabular structure|Scanned material is marked incomplete if vision fallback is unavailable
I04|Define declarative rule DSL and compiler boundaries|I01,R01|Define typed expressions for dice, comparisons, resources, conditions and rule effects|No arbitrary JS/Python execution from user-authored rulebooks
I05|Implement provenance-aware AI rule interpretation|I03,I04|Convert source clauses into draft mechanics with exact source references and uncertainty|Interpretations lacking clear evidence remain flagged, not authoritative
I06|Implement ambiguity and conflicting-source review|I05|Report unknown editions, competing definitions, errata conflicts and suggested decisions|An ambiguous official edition cannot be silently converted to another edition
I07|Implement safe rule DSL compiler and runtime|I04,R04|Compile supported primitives to deterministic validated mechanics and test hooks|Unsupported card/token/custom mechanics are explicitly flagged or provided by approved plugins
I08|Implement rule import validation and preview|I06,I07|Generate import summary, executable coverage report and source-backed tests|Player can decline activation when material mechanics remain unresolved
I09|Implement layered house-rule overlays and undo|I08,D04|Apply user overrides to versioned effective rules without changing source docs|Undo restores prior effective rule and never rewrites historical rolls
I10|Implement ruleset revisions and campaign migration|I09,D08|Pin ruleset versions and preview/apply compatible or explicit migrations|Incompatible sheet fields block silent migration
I11|Implement conversational and CLI import/edit workflow|I08,U01|Import files, preview rules, change mechanics and select effective ruleset using conversation|User does not need to write schema by hand; import never silently completes with gaps
I12|Connect effective imported mechanics to GM and engine|I08,I10,G01|GM selects and cites imported rules while engine resolves supported mechanics|Unsupported mechanics use visibly designated adjudication, never a fake deterministic check
I13|Implement supplement order, editions and errata|I05,I10|Support precedence of campaign overrides, options, errata, supplements and base texts|Version conflicts require explicit resolution; mixed editions are not merged silently
I14|End-to-end imported rulebook and edit tests|I11,I12,I13|Import multi-document rules, play, change house rules, restart and verify source references|Failed conversion or malicious source cannot change canonical state or access tools
N01|Define structured CampaignIntent and preference schema|P01,P02|Represent ruleset+edition, genre, mood, simulation, pacing, character and optional features|Unspecified capabilities remain defaulted, not interpreted as explicit consent
N02|Implement natural-language campaign intent parser|N01,G01|Extract complex one-sentence requests into typed proposed settings with confidence|Mixed requests such as dynamic world plus relaxed pacing are not treated as contradictory
N03|Implement ruleset, genre and capability registry|N01,R01,C01|Match installed rulepack/genre versions and advertised optional capabilities|Absent commercial editions are not claimed installed or accurately enforced
N04|Implement system and edition resolution|N02,N03|Resolve exact, aliased, misspelled and ambiguous RPG version requests|Unknown 'D&D 1.9' requests clarification rather than guessing official mechanics
N05|Implement compatibility and preference conflict detection|N03,N04|Explain requested combinations that are unsupported by active rules or UI|A voice-disabled or dice-free campaign cannot be forced into incompatible settings
N06|Implement minimal-clarification defaults|N05|Ask only blocking questions and propose reversible default settings|Long questionnaires are never required just to start a narrative campaign
N07|Generate and validate versioned campaign config|N06,D04|Store effective config, provenance of explicit/default choices and capability decisions|Invalid inferred options do not produce a campaign or override user intent
N08|Implement conversational mid-game settings changes|N07,G09|Change simulation, tone, combat frequency or voice settings via dialogue|Config changes preserve prior events and check rulepack compatibility
N09|Integrate one-sentence setup into onboarding|N07,U02|From single prompt to scene opening without manual JSON editing|Ruleset not present triggers import/choice instead of invented rules enforcement
N10|Evaluate ambiguous and adversarial campaign requests|N09,I12|Test missing editions, unsupported requests, conflicting preferences and vague intent|Prompt injection in user-provided rules text cannot override intent constraints
S01|Define versioned, ruleset-driven SheetSchema|R01,R02|Support typed widgets, custom fields, visibility, derived expressions and stable IDs|Narrative character has valid sheet without numerical stats
S02|Implement canonical character profile persistence|S01,D03|Persist identity, motivations, background, traits, conditions and rulepack link|No second mutable copy of character truth is created by a UI renderer
S03|Implement derived stats and dependency evaluation|S01,R04|Recompute modifiers, bonuses and constraints from referenced attributes and equipment|Cycles, unknown fields or invalid formulas are rejected
S04|Implement dynamic sheet view-model and templates|S02,S03|Produce renderer-neutral field groups, values, allowed edits and computed descriptors|Private NPC fields and GM-only secrets never appear in player view
S05|Implement conversational character builder|S04,N07|Create validated characters from backstory and ask for necessary mechanical choices|AI cannot quietly grant unsupported high stats or illegal starting equipment
S06|Implement existing ficha import and reconciliation|S04,I03|Extract PDF/image/text/spreadsheet character data and map to sheet schema with review|Ambiguous handwritten or missing mechanical values require explicit resolution
S07|Implement lightweight and detailed NPC sheets|S04,G03|Support sparse NPC profiles and expand to full schema if narrative role grows|NPC player-facing preview cannot reveal secrets or private goals
S08|Implement character change audit and explicit edits|S04,D04|Track every resource, backstory and equipment revision with cause and source|Manual backstory correction is distinguishable from in-world character development
S09|Implement character effects, death and progression|S03,R08,S08|Apply temporary modifiers, conditions, recovery, mortality and progression per RulePack|Death/resurrection and effect stacking honor configured mechanics
S10|Implement ficha display and export|S04,U05|Show sheet on CLI and export structured portable representation with provenance|Import/export preserves custom fields without exposing private NPC knowledge
S11|Implement ruleset-version sheet migrations|S08,I10|Preview and apply safe field transformations on new ruleset versions|Historical sheets and events stay unchanged; incompatible migrations require approval
S12|Run character sheets across genre/rule systems|S05,S06,S07,S09,S10,S11|Validate narrative, d20, pool, imported and unconventional sheets end-to-end|Invalid stats, private fields and divergent branch changes are rejected
W01|Specify optional world simulator contracts and defaults|P02,R01,G01|Define logical-time triggers, actor action schema, simulation modes and attention budgets|Off means no autonomous activity; world simulation is never mandatory
W02|Implement WorldActor and faction state|W01,D03|Persist goals, resources, plans, memories, knowledge and decision cooldowns|Actors cannot know secret facts without an information path
W03|Implement bounded logical-time scheduler|W01,G06,D04|Advance scheduled actors and world events on approved in-game time transitions|App shutdown does not advance time; jobs resume idempotently
W04|Implement deterministic and LLM-driven actor planners|W02,W03,G03|Generate typed scoped action proposals with deterministic simple behaviors and optional LLM planning|An LLM agent cannot write directly to world state or invent actor resources
W05|Validate autonomous action preconditions and effects|W04,R04|Apply ruleset checks, resource costs, concurrency guards and event commits|Invalid or stale proposals do not alter canon
W06|Resolve conflicts between simultaneous actors|W05|Handle contested resources, races and incompatible actions with documented deterministic rules|Two actors cannot spend the same unique item or own exclusive territory simultaneously
W07|Build Narrative Director event relevance selection|W05,G07|Classify canonical events as background, emerging, major or critical based on player context|Critical direct effects cannot be suppressed just to hit a pacing target
W08|Implement pacing, recovery and fairness controls|W07|Enforce configurable narrative budgets and player attention load without manipulating mechanics|Dynamic world with relaxed story pace remains a valid combination
W09|Implement faction goals and strategic world consequences|W06,W08|Factions negotiate, compete, expand or retreat consistently from resources and goals|Player intervention changes faction plans instead of forcing predetermined outcomes
W10|Integrate genre and imported rule simulation policies|W09,C01,I12|World simulation respects time, faction and house-rule constraints where available|Unsupported mechanics are adjudicated visibly or simulation capability is disabled
W11|Implement budgeted agent jobs and recovery|W09,D08|Limit agent calls, concurrency, retries and spend; resume durable job state|A failed agent cannot stall player turns or duplicate events
W12|Surface world events naturally through GM context|W08,W10,G09|Reveal relevant information using knowledge scopes and narrative pacing|No notification floods; undiscovered distant events remain hidden
W13|Implement player simulation settings and diagnostics|W11,W12,N08|Off, ambient, balanced, dynamic and custom modes are persisted and editable conversationally|World autonomy, intensity and consequence-severity sliders do not cheat rolls
W14|Build deterministic multi-agent simulation tests|W10,W11,W13|Simulate factions over game days with budgets, conflicts and varying pacing|No out-of-order, leaked, or duplicated events even after failed agent call
W15|Test branching, long-run consistency and restart|W14,T06|Prove autonomous evolution in separate timelines and persistent paused/resumed sessions|Cross-branch faction actions never mutate another branch
UI01|Define headless gameplay API and event stream|G09|Provide versioned commands and typed events for UI clients; support snapshot + subscription|Clients cannot bypass the engine or trust unsolicited model state writes
UI02|Define schema-driven view descriptors and registry|UI01,S04|Represent sheet, inventory, quest, encounter, clock, map and investigation views|Renderers reject unapproved arbitrary UI code in imported packs
UI03|Build dynamic character sheet UI widgets|UI02|Render schema-driven fichas with computed labels, conditions and editable approved fields|Unknown custom fields degrade gracefully without data loss
UI04|Build inventory, journal and rule reference panels|UI02,U05|Display inventory, quest journal, rule citations and world recap with live updates|Secret facts are filtered server-side, not hidden only with CSS
UI05|Build dice, cards and mechanics visualization events|UI01,R03|Animate trusted engine results for d20, pools and supported non-dice mechanics|Animation never changes result; hidden rolls respect visibility policy
UI06|Implement optional keyboard-driven TUI|UI01,UI02,UI05|Provide accessible terminal conversation, sheet, log and mechanical indicators|Text-only and limited terminal environments still work without graphics
UI07|Spike Tauri vs Electron packaging and process model|V08,UI01|Validate Windows/macOS/Linux packaging, daemon lifecycle and Node engine embedding|Desktop does not require unsupported reuse of consumer Claude subscription credentials
UI08|Implement desktop app foundation and renderer|UI03,UI04,UI07|Provide responsive desktop conversation, sheets, panels and campaign selection|Offline / disconnected engine state is shown accurately with safe retry
UI09|Implement live state synchronization across clients|UI06,UI08,T03|Clients subscribe to canonical event revisions and can resume same campaign|Stale UI action cannot overwrite newer state from another client
UI10|Implement accessibility, localization and UI preferences|UI08|Support keyboard controls, font scaling, screen reader labels and locale strings|Dynamic fichas are readable without animation or color semantics
UI11|Package and smoke-test all desktop platforms|UI09,UI10|Produce and verify platform-specific installation/launch and local data directory handling|Missing model-provider configuration never results in data loss
UI12|Complete cross-client end-to-end gameplay tests|UI06,UI09,UI11|Play campaign in desktop, resume in TUI and compare identical state|No duplicate turns on reconnect, restart or renderer switch
A01|Define provider-agnostic audio, privacy and billing contracts|UI01,P04|Specify STT, TTS, realtime, transcript and voice-profile provider interfaces|All features remain available with voice completely disabled
A02|Implement microphone capture permissions and device selection|A01,UI08|Request consent, capture mic input, display state and handle device changes|Permission denial falls back to typing without crash
A03|Implement STT adapters and transcription quality status|A01,A02|Convert speech to time-stamped text using pluggable local or cloud adapters|Low-confidence recognition requires clarification for consequential actions
A04|Implement push-to-talk and voice turn detection|A02,A03|Provide push-to-talk and optional hands-free VAD with clear boundaries|Silence, noise and multiple rapid turns cannot duplicate game actions
A05|Implement multilingual voice input and transcript normalization|A03|Support locale hints and multilingual inputs with faithful named-entity handling|User language switch does not silently change rule terminology or names
A06|Define TTS adapters and streaming speech contract|A01|Support provider-neutral synthesized chunks, voice IDs and cancellation|Unavailable or unaffordable provider gracefully chooses text output
A07|Implement output queue and streaming playback|A06,UI08|Stream ordered utterances, synchronize subtitles and control playback speed|Interrupted playback never undoes already committed gameplay state
A08|Persist narrator and important NPC voice profiles|A06,G03|Store voice identity, locale, pronunciation and preferred delivery across sessions|Voice profile remains recognizable while secrets stay private
A09|Implement dialogue speaker routing and narration|A07,A08,G09|Route segments to narration or correct NPC voice after valid commit|No speaker attribution changes during interrupted output
A10|Implement expression, pronunciation and emotion hints|A09|Use validated SSML-equivalent styles where provider supports them|Unsupported prosody hints degrade gracefully, without modifying character emotions
A11|Implement barge-in, interruption and cancellation|A04,A07|Stop output when player interrupts and preserve exact committed turn boundary|An interrupted half-heard sentence is not treated as a completed player turn
A12|Implement subtitles and transcript synchronization|A07,A09|Keep text, speaker and timing aligned with playback and searchable history|Users can mute voice and still access full narrative transcript
A13|Implement optional ambient and effect audio layers|A07,UI08|Provide opt-in ambience, ducking, per-channel volume and accessible silence mode|Background audio cannot obscure narration or start without user selection
A14|Implement conversational voice settings|A04,A12,N08|Allow typed or spoken changes to mic mode, output mode, locale and speed|Changing modes mid-session preserves campaign and input continuity
A15|Implement provider setup, health and secret storage|A03,A06|Allow local/provider choice, API key safe storage and availability diagnostics|No credentials are logged or committed to campaign exports
A16|Implement audio caching and consumption budgets|A07,A15|Cache safe repeated output and show model/voice costs and limits|A budget cap falls back to text instead of blocking gameplay
A17|Implement text fallback and audio failure recovery|A11,A12,A16|Recover gracefully from STT/TTS timeout, missing device or provider errors|No gameplay event is committed twice after retry
A18|Integrate audio with desktop and optional TUI|A14,A17,UI06,UI08|Desktop supports full voice; TUI supports appropriate audio controls when available|Headless text-only play does not depend on audio stack
A19|Test accessibility, privacy, latency and cancellation|A18|Measure latency and test interruptions, transcript correctness and opt-out|Mic capture is never activated silently or stored indefinitely by default
A20|Verify complete multilingual voice campaigns|A19,S12,W14|Run mixed text/speech campaign with narrator, persistent NPC voices and resume|Voice toggle, provider failure and game restart preserve canonical state
Q01|Implement foundational CI and fixtures|V01,P05|Build deterministic fixtures and continuous tests for types, lint, unit and integration|Known flaky or missing prerequisite is surfaced, not silently ignored
Q02|Implement fake-GM scripted simulation harness|V08,Q01|Play long scripted sessions without model API calls and inspect committed events|Repeated or interrupted fake-model responses cannot duplicate mutations
Q03|Implement rules and state invariant suite|D08,R09,Q02|Verify inventory bounds, secrets, conditions, quest state and idempotent mechanics|Malicious or out-of-order state proposals are rejected
Q04|Run cross-genre integrated campaign simulations|G09,U08,C06,I14,S12,W14,Q03|Verify fantasy, sci-fi, horror and mystery multi-session campaigns across rulesets|Multiple concurrent world clocks and imported house rules retain causal integrity
Q05|Implement long-run replay and load tests|Q04,T06|Stress-test hundreds of turns, branches, retrieval budgets and recovery|Performance does not require full history injection into every model prompt
Q06|Implement attack-surface and privacy security tests|Q04,P04|Test malicious documents, untrusted packs, path traversal, local data scope and provider secrets|No imported rulebook can override application instructions or access arbitrary files
Q07|Run real Claude Game Master evaluations|Q05,Q06,N10|Evaluate actual player agency, imported mechanics, consistency, pacing and adversarial prompts|Subjective success never overrides deterministic test failures
Q08|Complete install, API, ruleset and recovery documentation|Q07,UI12,A20|Verify clean-install quickstart, rulepack authoring and backup and audio/desktop docs|Instructions distinguish subscription-based Claude Code from API-key desktop providers
Q09|Verify complete multimodal release gate|Q08,W15,UI12,A20|Pass M3 acceptance matrix with all optional capabilities implemented and disabled-mode smoke tests|No unresolved P0 critical defect and all runtime components remain optional
X01|Define optional Dolt storage adapter contract|Q09|Map canonical events, revisions and snapshots to isolated campaign Dolt repository|Beads development database is never reused as user RPG data storage
X02|Implement parity-tested Dolt repositories|X01|Persist campaigns, facts and events through alternative backend contract suite|Moving from SQLite does not alter mechanic results or event semantics
X03|Integrate native Dolt branch, commit and diff|X02|Use native Dolt history to support game timeline interface and audits|No silent overwrite of divergent timeline data
X04|Test SQLite/Dolt migration and backend parity|X03|Import/export representative campaigns with identical canonical projections|Round-trip preserves rule versions, hidden facts and ancestry
'''

def parse():
 tasks=[]
 for raw in TASKS.strip().splitlines():
  bits=[x.strip() for x in raw.split('|')]
  if len(bits)!=5: raise ValueError((len(bits),raw))
  key,title,deps,goal,edge=bits
  prefix=re.match(r'^[A-Z]+',key).group()
  if prefix not in EPICS: raise ValueError(key)
  milestone=EPICS[prefix][1]
  category=EPICS[prefix][2]
  # P0 for foundation/M1 and critical mechanics; P1 for release capabilities; P2 for post-v1
  prio=0 if milestone in ('M0','M1') else (2 if milestone=='M4' else 1)
  if key in ('D04','R04','I04','P04','A15','Q06'): prio=0
  kinds={'P':'design','V':'vertical','D':'state','R':'rules','G':'gameplay','U':'ux','C':'genre','T':'timelines','I':'import','N':'intent','S':'sheet','W':'simulation','UI':'client','A':'voice','Q':'quality','X':'storage'}
  design=f"Implement within the {EPICS[prefix][0]} boundary ({category}). Follow docs/02-architecture.md, canonical event contracts, capability-driven defaults, and the existing repository interfaces; do not duplicate parallel domain state."
  if prefix in ('P',): design='Create a concrete reviewed design/decision artifact in docs/, trace requirements to interfaces and tests, and record unresolved trade-offs in an ADR.'
  if prefix in ('I','N','S'): design += ' Preserve rulepack version, source provenance, structured error classifications, and user override boundaries.'
  if prefix in ('W',): design += ' Use logical game time, stable action IDs, per-actor knowledge, bounded scheduling and deterministic commit validation.'
  if prefix in ('UI','A'): design += ' Client adapters observe engine events and request validated actions; all capability toggles are optional.'
  if prefix=='Q': design += ' Prefer reproducible fake-model fixtures; real-model evaluations are additional evidence.'
  validation=(f"Add named tests for {key}: successful behavior '{goal.lower()}', edge case '{edge.lower()}'; execute the appropriate quality profile from docs/09-quality-and-testing.md and retain command logs in issue completion evidence.")
  if prefix=='P': validation=f"Check in the design/ADR artifact for {key}; cross-check against the product contract, mark open questions, and run scripts/validate_plan.py."
  t={ 'key':key,'title':title,'epic':f'EPIC-{prefix}','dependencies':[x for x in deps.split(',') if x],
      'priority':prio,'milestone':milestone,'component':category,
      'description':f"Outcome: {goal}. Scope: deliver this feature and its typed contracts as a cohesive reviewable change. Integrate through authoritative engine interfaces; avoid hard-coding any genre or dice system.",
      'design':design, 'acceptance_criteria':[goal+'.',edge+'.',
        'Demonstrate behavior through automated or explicitly documented acceptance evidence; preserve event causality, versioning, and user opt-in behavior where relevant.'],
      'validation':validation,
      'labels':[f'epic-{prefix.lower()}',f'milestone-{milestone.lower()}',category,'optional-at-runtime' if prefix in ('W','A','UI','X') else 'core-contract']}
  tasks.append(t)
 return tasks

def validate(tasks):
 keys={t['key'] for t in tasks}
 assert len(keys)==len(tasks), 'duplicate keys'
 for t in tasks:
  missing=set(t['dependencies'])-keys
  if missing: raise ValueError((t['key'],missing))
  if t['key'] in t['dependencies']: raise ValueError('self dependency '+t['key'])
 graph={t['key']:t['dependencies'] for t in tasks}
 temp=set(); seen=set(); sorted_list=[]
 def walk(k):
  if k in temp: raise ValueError('dependency cycle at '+k)
  if k in seen:return
  temp.add(k)
  for d in graph[k]:walk(d)
  temp.remove(k);seen.add(k);sorted_list.append(k)
 for k in graph:walk(k)
 return sorted_list

def output():
 tasks=parse(); order=validate(tasks); bykey={t['key']:t for t in tasks}
 catalog={'version':'1.0.0','project':'RPG Harness','generated_from':'scripts/build_catalog.py','epics':{f'EPIC-{p}':{'title':v[0],'milestone':v[1],'component':v[2]} for p,v in EPICS.items()},'tasks':tasks,'topological_order':order}
 (BASE/'beads'/'catalog.json').write_text(json.dumps(catalog,indent=2,ensure_ascii=False)+'\n')
 nodes=[];edges=[]
 for p,(title,milestone,cat) in EPICS.items():
  nodes.append({'key':f'EPIC-{p}','title':f'{p} — {title}','type':'epic','priority':1,'description':f'## Success Criteria\nComplete all child issues and acceptance tests for {title}. All capabilities remain optional in user campaigns, even if supported by the shipped product.','acceptance_criteria':f'All required {p} children closed with verification evidence and milestone {milestone} acceptance satisfied.','labels':[f'epic-{p.lower()}',f'milestone-{milestone.lower()}',cat]})
 for t in tasks:
  nodes.append({'key':t['key'],'parent_key':t['epic'],'title':f"{t['key']} — {t['title']}", 'type':'task','priority':t['priority'],
    'description':f"## Goal\n{t['description']}\n\n## Validation\n{t['validation']}\n\n## Dependencies\n{', '.join(t['dependencies']) or 'None'}\n\n## Source specification\nSee docs and beads/catalog.json key {t['key']}.",
    'design':t['design'],
    'acceptance_criteria':'\n'.join(f'- [ ] {item}' for item in t['acceptance_criteria']),
    'labels':t['labels'],
    'metadata':{'plan_key':t['key'],'milestone':t['milestone'],'component':t['component']}})
  for dep in t['dependencies']:
   edges.append({'from_key':t['key'],'to_key':dep,'type':'blocks'})
 graph={'commit_message':'Initialize RPG Harness product development plan','nodes':nodes,'edges':edges}
 (BASE/'beads'/'beads-graph.json').write_text(json.dumps(graph,indent=2,ensure_ascii=False)+'\n')
 lines=['# Complete Beads backlog','',f'**{len(tasks)} implementation tasks**, **{len(EPICS)} epics**, **{len(edges)} blocking dependency links**.','','This file is a readable export of the authoritative import plan (`beads-graph.json`). After importing, the live Beads database is the development work tracker.','','## Milestones','','- **M0:** architecture, plan and dependency gate','- **M1:** first playable / restartable adventure','- **M2:** complete headless RPG + ruleset ingestion + ficha + living world (all runtime capabilities optional)','- **M3:** desktop/TUI/voice + cross-platform release verification','- **M4:** optional Dolt storage adapter','']
 for p,(title,milestone,component) in EPICS.items():
  subt=[t for t in tasks if t['epic']==f'EPIC-{p}']
  lines+=['',f'## Epic {p} — {title} ({milestone}; {len(subt)} tasks)','']
  for t in subt:
   lines += [f"### {t['key']} — {t['title']}",f"**Priority:** P{t['priority']} · **Depends on:** {', '.join(t['dependencies']) or 'none'}",'',t['description'],'','**Acceptance criteria**','']
   lines += [f'- [ ] {a}' for a in t['acceptance_criteria']]
   lines += ['',f"**Design:** {t['design']}",'',f"**Validation:** {t['validation']}",'']
 (BASE/'beads'/'BACKLOG.md').write_text('\n'.join(lines)+'\n')
 stats={m:sum(t['milestone']==m for t in tasks) for m in ('M0','M1','M2','M3','M4')}
 report=['# Plan validation report','','Generated by `scripts/build_catalog.py`, verified by `scripts/validate_plan.py` after packaging.','',f'- Epics: {len(EPICS)}',f'- Tasks: {len(tasks)}',f'- Blocking edges: {len(edges)}',f'- Unique task IDs: {len(bykey)}',f'- Topological order size: {len(order)}', '- Missing dependencies: 0','- Directed cycles: 0', '', '## Tasks per milestone','']
 report += [f'- {k}: {v}' for k,v in stats.items()]
 report += ['','## Bootstrap note','','`beads-graph.json` uses the documented `bd create --graph` node/key/parent_key/edge schema. The package does not contain a populated `.beads` Dolt database: import into your own project after initializing Beads. Import can only occur once per database; `bootstrap_beads.py` checks for prior plan keys and refuses duplicate execution.']
 (BASE/'beads'/'VALIDATION.md').write_text('\n'.join(report)+'\n')
 print(json.dumps({'tasks':len(tasks),'epics':len(EPICS),'edges':len(edges),'milestones':stats},indent=2))
if __name__=='__main__':output()
