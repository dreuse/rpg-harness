import { randomUUID } from 'node:crypto';
import type { Key } from 'node:readline';
import { budgetWarning, gmUsageLines } from '../../../packages/client-protocol/src/gm-usage.ts';
import {
  type CampaignSnapshot,
  type ClientEvent,
  type ClientSession,
  EVENT_COMMITTED,
  PROTOCOL_VERSION,
  type ViewComponent,
  type ViewValue,
} from '../../../packages/client-protocol/src/protocol.ts';
import { SHEET_VIEW } from '../../../packages/client-protocol/src/view-registry.ts';
import {
  type MechanicReveal,
  outcomeText,
  tumbleFaces,
  VISUALIZATION_EVENT,
  type VisualizationEvent,
} from '../../../packages/client-protocol/src/visualization.ts';
import { type CampaignId, OPENING_ACTION_ID } from '../../../packages/domain/src/campaign.ts';
import { DEFAULT_RULES_USAGE, type RulesUsage, usesDice, usesSheet } from '../../../packages/domain/src/rules-usage.ts';
import type { PlaybackControl } from '../../../packages/voice/src/playback-controls.ts';
import type { VoiceDiagnosticsSummary } from '../../../packages/voice/src/voice-diagnostics.ts';
import { DEFAULT_LOCALE, safeLocale, say } from './messages.ts';
import { type ColorDepth, colorDepthOf, FRAME_COLUMNS, frame, paint, supportsUnicode } from './theme.ts';
import { printable } from './views.ts';

export type TuiPlayback = PlaybackControl & {
  readonly diagnostics?: () => VoiceDiagnosticsSummary | undefined;
};

export type Capabilities = {
  readonly width: number;
  readonly height: number;
  readonly colors: ColorDepth;
  readonly unicode: boolean;
  readonly interactive: boolean;
};

export type TuiData = {
  readonly snapshot: CampaignSnapshot;
  readonly sheet: readonly ViewComponent[];
  readonly events: readonly ClientEvent[];
  readonly mechanics: readonly VisualizationEvent[];
  readonly audio?: string;
  readonly changed?: readonly string[];
  readonly locale?: string;
};

export type TuiState = {
  readonly pane: number;
  readonly help: boolean;
  readonly draft: string | undefined;
  readonly submitted: string | undefined;
  readonly notice: string | undefined;
  readonly quit: boolean;
};

type Act = (input: string) => string | undefined;

export type TuiAudio = {
  readonly status: () => string;
  readonly input: (text: string, act: Act) => string | undefined;
};

export type Terminal = {
  readonly capabilities: Capabilities;
  readonly audio?: (session: ClientSession, campaignId: CampaignId, playback?: TuiPlayback) => TuiAudio;
  readonly keys?: AsyncIterable<Key>;
  readonly motion?: boolean;
  readonly schedule?: (run: () => void, ms: number) => void;
  readonly lines: AsyncIterable<string>;
  readonly write: (text: string) => void;
  readonly locale?: string;
};

type Stream = { readonly isTTY?: boolean; readonly columns?: number; readonly rows?: number };
type PaneId = 'conversation' | 'sheet' | 'log' | 'mechanics';

type Pane = { readonly id: PaneId; readonly key: string; readonly label?: string };
type Shown = { readonly title: string; readonly rows: readonly string[]; readonly follow: boolean };

const CONVERSATION: Pane = { id: 'conversation', key: '1' };
const CHARACTER_LABEL = 'pane.character';
const PANE_IDS: readonly PaneId[] = ['conversation', 'sheet', 'log', 'mechanics'];

export const panesFor = (rules: RulesUsage = DEFAULT_RULES_USAGE): readonly Pane[] =>
  PANE_IDS.filter((id) => id !== 'mechanics' || usesDice(rules)).map((id, index) => ({
    id,
    key: `${index + NEXT}`,
    ...(id === 'sheet' && !usesSheet(rules) ? { label: CHARACTER_LABEL } : {}),
  }));

export const DEFAULT_WIDTH = 80;
export const DEFAULT_HEIGHT = 24;
export const SPLIT_MIN_WIDTH = 120;
const MIN_WIDTH = 20;
const MIN_HEIGHT = 10;
const MIN_PANE_HEIGHT = 3;
const BORDER_ROWS = 2;
const SPLIT_SHARE = 0.6;
const FOLLOWS_LATEST: ReadonlySet<PaneId> = new Set(['conversation', 'log', 'mechanics']);
const DUMB_TERM = 'dumb';
const ANIMATED_COLORS: ReadonlySet<ColorDepth> = new Set(['256', 'truecolor']);
const ROLL_STEPS = 6;
const FRAME_MS = 80;
const HIGHLIGHT_MS = 1200;
const NEXT = 1;
const TAB = 'tab';
const RETURN = 'return';
const ESCAPE = 'escape';
const BACKSPACE = 'backspace';
const INTERRUPT = 'c';
const TYPE_KEY = 'i';
const HELP_KEY = '?';
const QUIT_KEY = 'q';
const PRINTABLE = /^[^\p{C}]+$/u;
const SPACE = ' ';
const PROMPT = '> ';
const NEWLINE = '\n';
const CLEAR_SCREEN = '\x1b[2J\x1b[H';
const STATUS_SEPARATOR = ' | ';
const EDIT_PATTERN = /^\/edit\s+(\S+)\s+(.+)$/i;
const FLAG_WORDS: Readonly<Record<string, boolean>> = {
  yes: true,
  true: true,
  sim: true,
  no: false,
  false: false,
  não: false,
  nao: false,
};

const localeOf = (data: TuiData) => data.locale ?? DEFAULT_LOCALE;
const labelOf = (locale: string, { id, label }: Pane) => say(locale, label ?? `pane.${id}`);
const helpLabel = (locale: string) => say(locale, 'tui.help');

const helpLines = (data: TuiData) => {
  const locale = localeOf(data);
  const { gm } = data.snapshot;
  return [
    say(locale, 'help.tab'),
    ...panesFor(data.snapshot.rules).map((pane) =>
      say(locale, 'help.pane', { key: pane.key, label: labelOf(locale, pane) }),
    ),
    say(locale, 'help.type', { key: TYPE_KEY }),
    say(locale, 'help.edit'),
    say(locale, 'help.toggle', { key: HELP_KEY }),
    say(locale, 'help.quit', { key: QUIT_KEY }),
    ...(data.audio === undefined ? [] : [say(locale, 'tui.audioHelp')]),
    ...(gm === undefined ? [] : [...gmUsageLines(gm), say(locale, 'tui.gmSettings')]),
  ];
};

const onceOverBudget = (data: () => TuiData) => {
  let warned = false;
  return () => {
    const warning = warned ? undefined : budgetWarning(data().snapshot.gm);
    warned ||= warning !== undefined;
    return warning;
  };
};
const hint = (data: TuiData) => {
  const status = say(localeOf(data), 'tui.hint');
  return data.audio === undefined ? status : `${status}${STATUS_SEPARATOR}${data.audio}`;
};

export const PLAIN_TERMINAL: Capabilities = {
  width: DEFAULT_WIDTH,
  height: DEFAULT_HEIGHT,
  colors: 'none',
  unicode: false,
  interactive: false,
};

export const INITIAL_STATE: TuiState = {
  pane: 0,
  help: false,
  draft: undefined,
  submitted: undefined,
  notice: undefined,
  quit: false,
};

export const capabilitiesOf = (env: NodeJS.ProcessEnv, input: Stream, output: Stream): Capabilities => {
  const terminal = output.isTTY === true && env.TERM !== DUMB_TERM;
  return {
    width: Math.max(MIN_WIDTH, output.columns ?? DEFAULT_WIDTH),
    height: Math.max(MIN_HEIGHT, output.rows ?? DEFAULT_HEIGHT),
    colors: colorDepthOf(env, output),
    unicode: supportsUnicode(env),
    interactive: terminal && input.isTTY === true,
  };
};

export const motionOf = (env: NodeJS.ProcessEnv, { interactive, colors }: Capabilities) =>
  interactive && ANIMATED_COLORS.has(colors) && env.NO_COLOR === undefined;

const typing = (state: TuiState, draft: string, key: Key): TuiState => {
  if (key.name === RETURN) return { ...state, draft: undefined, submitted: draft.trim() || undefined };
  if (key.name === ESCAPE) return { ...state, draft: undefined };
  if (key.name === BACKSPACE) return { ...state, draft: [...draft].slice(0, -NEXT).join('') };
  const text = key.sequence ?? '';
  return key.ctrl || key.meta || !PRINTABLE.test(text) ? state : { ...state, draft: `${draft}${text}` };
};

export const nextStateIn =
  (panes: readonly Pane[]) =>
  (state: TuiState, key: Key): TuiState => {
    const ready = { ...state, submitted: undefined, notice: undefined };
    if (key.ctrl && key.name === INTERRUPT) return { ...ready, quit: true };
    if (state.draft !== undefined) return typing(ready, state.draft, key);
    if (key.name === TAB) {
      const step = key.shift ? panes.length - NEXT : NEXT;
      return { ...ready, pane: (state.pane + step) % panes.length, help: false };
    }
    const chosen = panes.findIndex((pane) => pane.key === key.sequence);
    if (chosen >= 0) return { ...ready, pane: chosen, help: false };
    if (key.sequence === HELP_KEY) return { ...ready, help: !state.help };
    if (key.sequence === QUIT_KEY) return { ...ready, quit: true };
    if (key.sequence === TYPE_KEY || key.name === RETURN) return { ...ready, draft: '' };
    return ready;
  };

export const nextState = nextStateIn(panesFor());

const chunks = (word: string, width: number): string[] =>
  word.length <= width ? [word] : [word.slice(0, width), ...chunks(word.slice(width), width)];

const wrapLine = (line: string, width: number): string[] => {
  const rows: string[] = [];
  let row = '';
  for (const word of line.split(SPACE).flatMap((part) => chunks(part, width))) {
    if (row !== '' && row.length + SPACE.length + word.length > width) {
      rows.push(row);
      row = word;
    } else row = row === '' ? word : `${row}${SPACE}${word}`;
  }
  return [...rows, row];
};

const wrap = (texts: readonly string[], width: number) =>
  texts.flatMap((text) => text.split(NEWLINE)).flatMap((line) => wrapLine(printable(line), width));

const reveal = (shown: MechanicReveal) => (shown.kind === 'die' ? `d${shown.sides} -> ${shown.face}` : shown.label);
const SIGNED = { signDisplay: 'always' } as const;

const indicator = ({ mechanic, frames, final }: VisualizationEvent, locale = DEFAULT_LOCALE) =>
  [
    `${mechanic}: ${frames.map((frame) => reveal(frame.reveal)).join(', ')}`,
    ...(final.modifier === undefined
      ? []
      : [
          say(locale, 'dice.modifier', {
            value: new Intl.NumberFormat(safeLocale(locale), SIGNED).format(final.modifier),
          }),
        ]),
    ...(final.total === undefined ? [] : [say(locale, 'dice.total', { value: final.total })]),
    ...(final.outcome === undefined
      ? []
      : [say(locale, 'dice.outcome', { value: outcomeText(say, locale, final.outcome) })]),
  ].join('; ');

const spinning = ({ mechanic, frames }: VisualizationEvent, step: number, tumbles: readonly number[][]) =>
  `${mechanic}: ${frames
    .map(({ reveal: shown }, index) =>
      shown.kind === 'die' ? `d${shown.sides} -> ${tumbles[index]?.[step] ?? shown.face}` : shown.label,
    )
    .join(', ')}`;

export const rollFrames = (event: VisualizationEvent, steps: number, locale = DEFAULT_LOCALE): string[] => {
  const tumbles = event.frames.map(({ reveal: shown }) => (shown.kind === 'die' ? tumbleFaces(shown, steps) : []));
  return [...Array.from({ length: steps - 1 }, (_, step) => spinning(event, step, tumbles)), indicator(event, locale)];
};

const sheetRow = ({ label, value }: ViewComponent) => (value === undefined ? label : `${label}: ${String(value)}`);

const groupTitle = (group: string) => `${group.charAt(0).toUpperCase()}${group.slice(1)}:`;

const sheetRows = (sheet: readonly ViewComponent[]) =>
  sheet.flatMap((component, index) => {
    const { group } = component;
    const heading = group !== undefined && group !== sheet[index - 1]?.group ? [groupTitle(group)] : [];
    return [...heading, sheetRow(component)];
  });

const conversation = ({ currentScene, characters, turns }: CampaignSnapshot, locale: string) => {
  const names = new Map(characters.map(({ id, name }) => [id, name]));
  const rows = turns.flatMap(({ actionId, actorId, input, narration }) => [
    ...(input.trim() === '' || actionId === OPENING_ACTION_ID ? [] : [`${names.get(actorId) ?? actorId}: ${input}`]),
    narration.trim() === '' ? say(locale, 'tui.noReply') : narration,
  ]);
  return rows.length === 0 || currentScene === undefined
    ? rows
    : [say(locale, 'tui.scene', { title: currentScene.title }), ...rows];
};

const PANE_ROWS: Readonly<Record<PaneId, (data: TuiData) => readonly string[]>> = {
  conversation: (data) => conversation(data.snapshot, localeOf(data)),
  sheet: (data) =>
    usesSheet(data.snapshot.rules ?? DEFAULT_RULES_USAGE)
      ? [
          ...data.snapshot.characters.map(({ name }) => say(localeOf(data), 'tui.character', { name })),
          ...sheetRows(data.sheet),
        ]
      : [...sheetRows(data.sheet), say(localeOf(data), 'tui.noSheet')],
  log: ({ events }) =>
    events.flatMap((event) => (event.type === EVENT_COMMITTED ? [`#${event.revision} ${event.event.type}`] : [])),
  mechanics: (data) => data.mechanics.map((event) => indicator(event, localeOf(data))),
};

const paneRows = (id: PaneId, data: TuiData) => {
  const rows = PANE_ROWS[id](data);
  return rows.length === 0 ? [say(localeOf(data), `empty.${id}`)] : rows;
};

const paneAt = (panes: readonly Pane[], index: number) => panes[index] ?? CONVERSATION;

const shown = (pane: Pane, data: TuiData): Shown => ({
  title: labelOf(localeOf(data), pane),
  rows: paneRows(pane.id, data),
  follow: FOLLOWS_LATEST.has(pane.id),
});

const fit = (rows: readonly string[], height: number, follow: boolean) => {
  const kept = rows.length <= height ? rows : follow ? rows.slice(-height) : rows.slice(0, height);
  return [...kept, ...Array.from({ length: height - kept.length }, () => '')];
};

const columnsFor = (state: TuiState, data: TuiData, width: number) => {
  const panes = panesFor(data.snapshot.rules);
  const focused = paneAt(panes, state.pane);
  const help: Shown = { title: helpLabel(localeOf(data)), rows: helpLines(data), follow: false };
  if (width < SPLIT_MIN_WIDTH) return [{ pane: state.help ? help : shown(focused, data), width, focused: true }];
  const left = Math.round(width * SPLIT_SHARE);
  const [, second = focused] = panes;
  const partner = focused.id === CONVERSATION.id ? second : focused;
  const rightFocused = state.help || focused.id !== CONVERSATION.id;
  return [
    { pane: shown(CONVERSATION, data), width: left, focused: !rightFocused },
    { pane: state.help ? help : shown(partner, data), width: width - left, focused: rightFocused },
  ];
};

export const renderScreen = (state: TuiState, data: TuiData, capabilities: Capabilities): string[] => {
  const { width, height, colors } = capabilities;
  const locale = localeOf(data);
  const panes = panesFor(data.snapshot.rules);
  const focused = paneAt(panes, state.pane);
  const focusedTab = `[${focused.key} ${labelOf(locale, focused)}]`;
  const tabs = panes.map((pane) => (pane.key === focused.key ? focusedTab : `${pane.key} ${labelOf(locale, pane)}`));
  const tabRows = wrap([tabs.join(SPACE)], width).map((row) =>
    row.replace(focusedTab, paint(colors, 'accent', focusedTab)),
  );
  const typed = state.draft !== undefined;
  const status = typed ? `${PROMPT}${state.draft}` : (state.notice ?? hint(data));
  const statusRows = wrap([status], width).map((row) =>
    typed || state.notice !== undefined ? row : paint(colors, 'muted', row),
  );
  const paneHeight = Math.max(MIN_PANE_HEIGHT, height - tabRows.length - statusRows.length);
  const changed = new Set(data.changed ?? []);
  const highlighted = new Set(data.sheet.filter(({ id }) => changed.has(id)).map(sheetRow));
  const boxes = columnsFor(state, data, width).map(({ pane, width: columns, focused: active }) =>
    frame(
      capabilities,
      pane.title,
      fit(wrap(pane.rows, columns - FRAME_COLUMNS), paneHeight - BORDER_ROWS, pane.follow).map((row) =>
        highlighted.has(row) ? paint(colors, 'accent', row.padEnd(columns - FRAME_COLUMNS)) : row,
      ),
      columns,
      active,
    ),
  );
  const body = Array.from({ length: paneHeight }, (_, index) => boxes.map((box) => box[index] ?? '').join(''));
  return [...tabRows, ...body, ...statusRows];
};

const section = (title: string, rows: readonly string[], { width, colors }: Capabilities) => {
  const [heading = '', ...rest] = wrap([title, ...rows], width);
  return [paint(colors, 'title', heading), ...rest];
};

export const renderLinear = (data: TuiData, capabilities: Capabilities): string[] => [
  ...panesFor(data.snapshot.rules).flatMap((pane) =>
    section(`${labelOf(localeOf(data), pane)}:`, paneRows(pane.id, data), capabilities),
  ),
  ...(data.audio === undefined ? [] : wrap([data.audio], capabilities.width)),
];

const isMechanic = (event: ClientEvent): event is VisualizationEvent => event.type === VISUALIZATION_EVENT;

const read = (
  session: ClientSession,
  campaignId: CampaignId,
  events: readonly ClientEvent[],
  audio: TuiAudio | undefined,
  locale: string,
): TuiData => {
  const snapshot = session.getSnapshot({ version: PROTOCOL_VERSION, type: 'GetCampaignSnapshot', campaignId });
  if (!snapshot.ok) throw new Error(snapshot.error.message);
  const sheet = session.requestView({ version: PROTOCOL_VERSION, type: 'RequestView', campaignId, viewId: SHEET_VIEW });
  if (!sheet.ok) throw new Error(sheet.error.message);
  return {
    snapshot: snapshot.value,
    sheet: sheet.value.components,
    events,
    mechanics: events.filter(isMechanic),
    locale,
    ...(audio === undefined ? {} : { audio: audio.status() }),
  };
};

const submit = (session: ClientSession, data: TuiData, input: string): string | undefined => {
  const { snapshot } = data;
  const [actor] = snapshot.characters;
  if (actor === undefined || snapshot.currentScene === undefined) return say(localeOf(data), 'tui.noScene');
  const accepted = session.submitPlayerAction({
    version: PROTOCOL_VERSION,
    type: 'SubmitPlayerAction',
    campaignId: snapshot.campaignId,
    actionId: randomUUID(),
    expectedRevision: snapshot.revision,
    sceneId: snapshot.currentScene.id,
    actorId: actor.id,
    input,
  });
  return accepted.ok ? undefined : accepted.error.message;
};

const editValue = (current: ViewValue | undefined, text: string) => {
  if (typeof current === 'boolean') return FLAG_WORDS[text.toLowerCase()];
  if (typeof current !== 'number') return text;
  const number = Number(text);
  return Number.isFinite(number) ? number : undefined;
};

const named = (name: string) => (component: ViewComponent) =>
  [component.id, component.label].some((known) => known.toLowerCase() === name.toLowerCase());

const editField = (session: ClientSession, data: TuiData, name: string, text: string) => {
  const { snapshot, sheet } = data;
  const locale = localeOf(data);
  const [actor] = snapshot.characters;
  const field = sheet.find(named(name));
  if (field === undefined || actor === undefined) return say(locale, 'edit.unknown', { name });
  if (field.editable !== true) return say(locale, 'edit.locked', { label: field.label });
  const value = editValue(field.value, text);
  if (value === undefined)
    return say(locale, 'edit.needs', {
      label: field.label,
      kind: say(locale, typeof field.value === 'boolean' ? 'edit.flag' : 'edit.number'),
    });
  const accepted = session.editSheetField({
    version: PROTOCOL_VERSION,
    type: 'EditSheetField',
    campaignId: snapshot.campaignId,
    actionId: randomUUID(),
    expectedRevision: snapshot.revision,
    actorId: actor.id,
    fieldId: field.id,
    value,
  });
  return accepted.ok ? undefined : accepted.error.message;
};

const valuesOf = (sheet: readonly ViewComponent[]) => new Map(sheet.map(({ id, value }) => [id, value]));

type Narrate = () => Promise<unknown>;

const interactive = async (
  data: () => TuiData,
  act: Act,
  narrate: Narrate,
  terminal: Terminal,
  keys: AsyncIterable<Key>,
  notice: string | undefined,
) => {
  const { motion = false, schedule = setTimeout } = terminal;
  let state = { ...INITIAL_STATE, notice };
  const budget = onceOverBudget(data);
  let changed: string[] = [];
  let generation = 0;
  const first = data();
  let seen = first.mechanics.length;
  let shownSheet = valuesOf(first.sheet);
  const paint = () =>
    terminal.write(
      `${CLEAR_SCREEN}${renderScreen(state, { ...data(), changed }, terminal.capabilities).join(NEWLINE)}`,
    );
  const play = (frames: readonly string[], token: number) => {
    for (const [index, frame] of frames.entries())
      schedule(() => {
        if (token !== generation) return;
        state = { ...state, notice: frame };
        paint();
      }, index * FRAME_MS);
  };
  const settle = () => {
    if (state.quit) return;
    changed = [];
    paint();
  };
  paint();
  for await (const key of keys) {
    state = nextStateIn(panesFor(data().snapshot.rules))(state, key);
    generation += 1;
    if (state.quit) return;
    if (state.submitted !== undefined) {
      state = { ...state, notice: act(state.submitted) };
      await narrate();
      state = { ...state, notice: state.notice ?? budget() };
    }
    const current = data();
    const latest = current.mechanics.slice(seen).at(-1);
    seen = current.mechanics.length;
    changed = motion
      ? current.sheet.filter(({ id, value }) => shownSheet.has(id) && shownSheet.get(id) !== value).map(({ id }) => id)
      : [];
    shownSheet = valuesOf(current.sheet);
    if (latest !== undefined && state.notice === undefined) {
      if (motion) play(rollFrames(latest, ROLL_STEPS, localeOf(current)), generation);
      else state = { ...state, notice: indicator(latest, localeOf(current)) };
    }
    if (changed.length > 0) schedule(settle, HIGHLIGHT_MS);
    paint();
  }
};

const linear = async (
  data: () => TuiData,
  act: Act,
  narrate: Narrate,
  terminal: Terminal,
  notice: string | undefined,
) => {
  const { capabilities } = terminal;
  const { width } = capabilities;
  const print = (rows: readonly string[]) => terminal.write(`${rows.join(NEWLINE)}${NEWLINE}`);
  const show = (pane: Pane) => {
    const current = data();
    print(section(`${labelOf(localeOf(current), pane)}:`, paneRows(pane.id, current), capabilities));
  };
  const budget = onceOverBudget(data);
  print(renderLinear(data(), terminal.capabilities));
  if (notice !== undefined) print(wrap([notice], width));
  for await (const line of terminal.lines) {
    const text = line.trim();
    const pane = panesFor(data().snapshot.rules).find(({ key }) => key === text);
    if (text === QUIT_KEY) return;
    if (text === '') continue;
    if (text === HELP_KEY) {
      const current = data();
      print(section(`${helpLabel(localeOf(current))}:`, helpLines(current), capabilities));
    } else if (pane !== undefined) show(pane);
    else {
      const notice = act(text);
      await narrate();
      if (notice === undefined) show(CONVERSATION);
      else print(wrap([notice], width));
      const warning = budget();
      if (warning !== undefined) print(wrap([warning], width));
    }
  }
};

export const runTui = async (
  session: ClientSession,
  campaignId: CampaignId,
  terminal: Terminal,
  narrate: Narrate = async () => {},
  notice?: string,
  playback?: TuiPlayback,
): Promise<void> => {
  const events: ClientEvent[] = [];
  const unsubscribe = session.subscribeEvents(
    { version: PROTOCOL_VERSION, type: 'SubscribeEvents', campaignId },
    (event) => events.push(event),
  );
  const audio = terminal.audio?.(session, campaignId, playback);
  const data = () => read(session, campaignId, events, audio, terminal.locale ?? DEFAULT_LOCALE);
  const send: Act = (input) => {
    const [, name, text] = EDIT_PATTERN.exec(input) ?? [];
    return name === undefined || text === undefined
      ? submit(session, data(), input)
      : editField(session, data(), name, text);
  };
  const act: Act = audio === undefined ? send : (input) => audio.input(input, send);
  try {
    if (terminal.capabilities.interactive && terminal.keys !== undefined)
      await interactive(data, act, narrate, terminal, terminal.keys, notice);
    else await linear(data, act, narrate, terminal, notice);
  } finally {
    unsubscribe();
  }
};
