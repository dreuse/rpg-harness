import { randomUUID } from 'node:crypto';
import type { Key } from 'node:readline';
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
  outcomeLabel,
  tumbleFaces,
  VISUALIZATION_EVENT,
  type VisualizationEvent,
} from '../../../packages/client-protocol/src/visualization.ts';
import { type CampaignId, OPENING_ACTION_ID } from '../../../packages/domain/src/campaign.ts';
import { type ColorDepth, colorDepthOf, FRAME_COLUMNS, frame, paint, supportsUnicode } from './theme.ts';
import { printable } from './views.ts';

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
  readonly audio?: (session: ClientSession, campaignId: CampaignId) => TuiAudio;
  readonly keys?: AsyncIterable<Key>;
  readonly motion?: boolean;
  readonly schedule?: (run: () => void, ms: number) => void;
  readonly lines: AsyncIterable<string>;
  readonly write: (text: string) => void;
};

type Stream = { readonly isTTY?: boolean; readonly columns?: number; readonly rows?: number };
type PaneId = 'conversation' | 'sheet' | 'log' | 'mechanics';

type Pane = { readonly id: PaneId; readonly key: string; readonly label: string };
type Shown = { readonly title: string; readonly rows: readonly string[]; readonly follow: boolean };

const CONVERSATION: Pane = { id: 'conversation', key: '1', label: 'Conversation' };
const PANES: readonly Pane[] = [
  CONVERSATION,
  { id: 'sheet', key: '2', label: 'Sheet' },
  { id: 'log', key: '3', label: 'Event log' },
  { id: 'mechanics', key: '4', label: 'Mechanics' },
];

export const DEFAULT_WIDTH = 80;
export const DEFAULT_HEIGHT = 24;
export const SPLIT_MIN_WIDTH = 120;
const MIN_WIDTH = 20;
const MIN_HEIGHT = 10;
const MIN_PANE_HEIGHT = 3;
const BORDER_ROWS = 2;
const SPLIT_SHARE = 0.6;
const SPLIT_PARTNER: PaneId = 'sheet';
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
const HELP_LABEL = 'Help';
const HELP_TITLE = `${HELP_LABEL}:`;
const STATUS_HINT = 'Tab next pane, 1-4 pick pane, i type, ? help, q quit';
const STATUS_SEPARATOR = ' | ';
const AUDIO_HELP =
  "Type 'set mic to push-to-talk', 'set output to narrator', 'set output to cinematic' or 'set speed to 1.5' to change voice.";
const NO_SCENE = 'No scene to act in yet.';
const EDIT_PATTERN = /^\/edit\s+(\S+)\s+(.+)$/i;
const FLAG_WORDS: Readonly<Record<string, boolean>> = { yes: true, true: true, no: false, false: false };
const NEEDS_FLAG = 'yes or no';
const NEEDS_NUMBER = 'a number';
const NO_REPLY = 'No reply was recorded for this turn.';
const EMPTY: Readonly<Record<PaneId, string>> = {
  conversation: 'No conversation yet.',
  sheet: 'No sheet yet.',
  log: 'No events yet.',
  mechanics: 'No mechanics yet.',
};
const HELP_LINES = [
  'Tab - Next pane. Shift+Tab - Previous pane.',
  ...PANES.map(({ key, label }) => `${key} - Show ${label}.`),
  `${TYPE_KEY} or Enter - Type an action. Enter sends it, Esc cancels.`,
  '/edit <field> <value> - Change a sheet field.',
  `${HELP_KEY} - Show or hide this help.`,
  `${QUIT_KEY} - Quit.`,
];

const helpLines = ({ audio }: TuiData) => (audio === undefined ? HELP_LINES : [...HELP_LINES, AUDIO_HELP]);
const hint = ({ audio }: TuiData) => (audio === undefined ? STATUS_HINT : `${STATUS_HINT}${STATUS_SEPARATOR}${audio}`);

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

export const nextState = (state: TuiState, key: Key): TuiState => {
  const ready = { ...state, submitted: undefined, notice: undefined };
  if (key.ctrl && key.name === INTERRUPT) return { ...ready, quit: true };
  if (state.draft !== undefined) return typing(ready, state.draft, key);
  if (key.name === TAB) {
    const step = key.shift ? PANES.length - NEXT : NEXT;
    return { ...ready, pane: (state.pane + step) % PANES.length, help: false };
  }
  const chosen = PANES.findIndex((pane) => pane.key === key.sequence);
  if (chosen >= 0) return { ...ready, pane: chosen, help: false };
  if (key.sequence === HELP_KEY) return { ...ready, help: !state.help };
  if (key.sequence === QUIT_KEY) return { ...ready, quit: true };
  if (key.sequence === TYPE_KEY || key.name === RETURN) return { ...ready, draft: '' };
  return ready;
};

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
const signed = (value: number) => (value < 0 ? String(value) : `+${value}`);

const indicator = ({ mechanic, frames, final }: VisualizationEvent) =>
  [
    `${mechanic}: ${frames.map((frame) => reveal(frame.reveal)).join(', ')}`,
    ...(final.modifier === undefined ? [] : [`modifier ${signed(final.modifier)}`]),
    ...(final.total === undefined ? [] : [`total ${final.total}`]),
    ...(final.outcome === undefined ? [] : [`outcome ${outcomeLabel(final.outcome)}`]),
  ].join('; ');

const spinning = ({ mechanic, frames }: VisualizationEvent, step: number, tumbles: readonly number[][]) =>
  `${mechanic}: ${frames
    .map(({ reveal: shown }, index) =>
      shown.kind === 'die' ? `d${shown.sides} -> ${tumbles[index]?.[step] ?? shown.face}` : shown.label,
    )
    .join(', ')}`;

export const rollFrames = (event: VisualizationEvent, steps: number): string[] => {
  const tumbles = event.frames.map(({ reveal: shown }) => (shown.kind === 'die' ? tumbleFaces(shown, steps) : []));
  return [...Array.from({ length: steps - 1 }, (_, step) => spinning(event, step, tumbles)), indicator(event)];
};

const sheetRow = ({ label, value }: ViewComponent) => (value === undefined ? label : `${label}: ${String(value)}`);

const groupTitle = (group: string) => `${group.charAt(0).toUpperCase()}${group.slice(1)}:`;

const sheetRows = (sheet: readonly ViewComponent[]) =>
  sheet.flatMap((component, index) => {
    const { group } = component;
    const heading = group !== undefined && group !== sheet[index - 1]?.group ? [groupTitle(group)] : [];
    return [...heading, sheetRow(component)];
  });

const conversation = ({ currentScene, characters, turns }: CampaignSnapshot) => {
  const names = new Map(characters.map(({ id, name }) => [id, name]));
  const rows = turns.flatMap(({ actionId, actorId, input, narration }) => [
    ...(input.trim() === '' || actionId === OPENING_ACTION_ID ? [] : [`${names.get(actorId) ?? actorId}: ${input}`]),
    narration.trim() === '' ? NO_REPLY : narration,
  ]);
  return rows.length === 0 || currentScene === undefined ? rows : [`Scene: ${currentScene.title}`, ...rows];
};

const PANE_ROWS: Readonly<Record<PaneId, (data: TuiData) => readonly string[]>> = {
  conversation: ({ snapshot }) => conversation(snapshot),
  sheet: ({ snapshot, sheet }) => [...snapshot.characters.map(({ name }) => `Character: ${name}`), ...sheetRows(sheet)],
  log: ({ events }) =>
    events.flatMap((event) => (event.type === EVENT_COMMITTED ? [`#${event.revision} ${event.event.type}`] : [])),
  mechanics: ({ mechanics }) => mechanics.map(indicator),
};

const paneRows = (id: PaneId, data: TuiData) => {
  const rows = PANE_ROWS[id](data);
  return rows.length === 0 ? [EMPTY[id]] : rows;
};

const paneAt = (index: number) => PANES[index] ?? CONVERSATION;

const shown = ({ id, label }: Pane, data: TuiData): Shown => ({
  title: label,
  rows: paneRows(id, data),
  follow: FOLLOWS_LATEST.has(id),
});

const fit = (rows: readonly string[], height: number, follow: boolean) => {
  const kept = rows.length <= height ? rows : follow ? rows.slice(-height) : rows.slice(0, height);
  return [...kept, ...Array.from({ length: height - kept.length }, () => '')];
};

const columnsFor = (state: TuiState, data: TuiData, width: number) => {
  const focused = paneAt(state.pane);
  const help: Shown = { title: HELP_LABEL, rows: helpLines(data), follow: false };
  if (width < SPLIT_MIN_WIDTH) return [{ pane: state.help ? help : shown(focused, data), width, focused: true }];
  const left = Math.round(width * SPLIT_SHARE);
  const partner = focused.id === CONVERSATION.id ? (PANES.find(({ id }) => id === SPLIT_PARTNER) ?? focused) : focused;
  const rightFocused = state.help || focused.id !== CONVERSATION.id;
  return [
    { pane: shown(CONVERSATION, data), width: left, focused: !rightFocused },
    { pane: state.help ? help : shown(partner, data), width: width - left, focused: rightFocused },
  ];
};

export const renderScreen = (state: TuiState, data: TuiData, capabilities: Capabilities): string[] => {
  const { width, height, colors } = capabilities;
  const focused = paneAt(state.pane);
  const focusedTab = `[${focused.key} ${focused.label}]`;
  const tabs = PANES.map(({ key, label }) => (key === focused.key ? focusedTab : `${key} ${label}`));
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
  ...PANES.flatMap(({ id, label }) => section(`${label}:`, paneRows(id, data), capabilities)),
  ...(data.audio === undefined ? [] : wrap([data.audio], capabilities.width)),
];

const isMechanic = (event: ClientEvent): event is VisualizationEvent => event.type === VISUALIZATION_EVENT;

const read = (
  session: ClientSession,
  campaignId: CampaignId,
  events: readonly ClientEvent[],
  audio: TuiAudio | undefined,
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
    ...(audio === undefined ? {} : { audio: audio.status() }),
  };
};

const submit = (session: ClientSession, { snapshot }: TuiData, input: string): string | undefined => {
  const [actor] = snapshot.characters;
  if (actor === undefined || snapshot.currentScene === undefined) return NO_SCENE;
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

const editField = (session: ClientSession, { snapshot, sheet }: TuiData, name: string, text: string) => {
  const [actor] = snapshot.characters;
  const field = sheet.find(named(name));
  if (field === undefined || actor === undefined) return `No sheet field ${name}.`;
  if (field.editable !== true) return `${field.label} cannot be edited.`;
  const value = editValue(field.value, text);
  if (value === undefined)
    return `${field.label} needs ${typeof field.value === 'boolean' ? NEEDS_FLAG : NEEDS_NUMBER}.`;
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

type Narrate = () => Promise<void>;

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
    state = nextState(state, key);
    generation += 1;
    if (state.quit) return;
    if (state.submitted !== undefined) {
      state = { ...state, notice: act(state.submitted) };
      await narrate();
    }
    const current = data();
    const latest = current.mechanics.slice(seen).at(-1);
    seen = current.mechanics.length;
    changed = motion
      ? current.sheet.filter(({ id, value }) => shownSheet.has(id) && shownSheet.get(id) !== value).map(({ id }) => id)
      : [];
    shownSheet = valuesOf(current.sheet);
    if (latest !== undefined && state.notice === undefined) {
      if (motion) play(rollFrames(latest, ROLL_STEPS), generation);
      else state = { ...state, notice: indicator(latest) };
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
  const show = ({ id, label }: Pane) => print(section(`${label}:`, paneRows(id, data()), capabilities));
  print(renderLinear(data(), terminal.capabilities));
  if (notice !== undefined) print(wrap([notice], width));
  for await (const line of terminal.lines) {
    const text = line.trim();
    const pane = PANES.find(({ key }) => key === text);
    if (text === QUIT_KEY) return;
    if (text === '') continue;
    if (text === HELP_KEY) print(section(HELP_TITLE, helpLines(data()), capabilities));
    else if (pane !== undefined) show(pane);
    else {
      const notice = act(text);
      await narrate();
      if (notice === undefined) show(CONVERSATION);
      else print(wrap([notice], width));
    }
  }
};

export const runTui = async (
  session: ClientSession,
  campaignId: CampaignId,
  terminal: Terminal,
  narrate: Narrate = async () => {},
  notice?: string,
): Promise<void> => {
  const events: ClientEvent[] = [];
  const unsubscribe = session.subscribeEvents(
    { version: PROTOCOL_VERSION, type: 'SubscribeEvents', campaignId },
    (event) => events.push(event),
  );
  const audio = terminal.audio?.(session, campaignId);
  const data = () => read(session, campaignId, events, audio);
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
