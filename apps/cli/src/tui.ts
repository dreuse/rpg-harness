import { randomUUID } from 'node:crypto';
import type { Key } from 'node:readline';
import { styleText } from 'node:util';
import {
  type CampaignSnapshot,
  type ClientEvent,
  type ClientSession,
  EVENT_COMMITTED,
  PROTOCOL_VERSION,
  type ViewComponent,
} from '../../../packages/client-protocol/src/protocol.ts';
import { SHEET_VIEW } from '../../../packages/client-protocol/src/view-registry.ts';
import {
  type MechanicReveal,
  VISUALIZATION_EVENT,
  type VisualizationEvent,
} from '../../../packages/client-protocol/src/visualization.ts';
import type { CampaignId } from '../../../packages/domain/src/campaign.ts';
import { printable } from './views.ts';

export type Capabilities = { readonly width: number; readonly color: boolean; readonly interactive: boolean };

export type TuiData = {
  readonly snapshot: CampaignSnapshot;
  readonly sheet: readonly ViewComponent[];
  readonly events: readonly ClientEvent[];
  readonly mechanics: readonly VisualizationEvent[];
};

export type TuiState = {
  readonly pane: number;
  readonly help: boolean;
  readonly draft: string | undefined;
  readonly submitted: string | undefined;
  readonly notice: string | undefined;
  readonly quit: boolean;
};

export type Terminal = {
  readonly capabilities: Capabilities;
  readonly keys?: AsyncIterable<Key>;
  readonly lines: AsyncIterable<string>;
  readonly write: (text: string) => void;
};

type Stream = { readonly isTTY?: boolean; readonly columns?: number };
type PaneId = 'conversation' | 'sheet' | 'log' | 'mechanics';

type Pane = { readonly id: PaneId; readonly key: string; readonly label: string };

const CONVERSATION: Pane = { id: 'conversation', key: '1', label: 'Conversation' };
const PANES: readonly Pane[] = [
  CONVERSATION,
  { id: 'sheet', key: '2', label: 'Sheet' },
  { id: 'log', key: '3', label: 'Event log' },
  { id: 'mechanics', key: '4', label: 'Mechanics' },
];

export const DEFAULT_WIDTH = 80;
const MIN_WIDTH = 20;
const DUMB_TERM = 'dumb';
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
const RULE = '-';
const PROMPT = '> ';
const NEWLINE = '\n';
const CLEAR_SCREEN = '\x1b[2J\x1b[H';
const EMPHASIS = 'bold';
const HELP_TITLE = 'Help:';
const STATUS_HINT = 'Tab next pane, 1-4 pick pane, i type, ? help, q quit';
const NO_SCENE = 'No scene to act in yet.';
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
  `${HELP_KEY} - Show or hide this help.`,
  `${QUIT_KEY} - Quit.`,
];

export const PLAIN_TERMINAL: Capabilities = { width: DEFAULT_WIDTH, color: false, interactive: false };

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
    color: terminal && (env.NO_COLOR ?? '') === '',
    interactive: terminal && input.isTTY === true,
  };
};

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
    ...(final.outcome === undefined ? [] : [`outcome ${final.outcome}`]),
  ].join('; ');

const conversation = ({ currentScene, characters, turns }: CampaignSnapshot) => {
  const names = new Map(characters.map(({ id, name }) => [id, name]));
  const rows = turns.flatMap(({ actorId, input, narration }) => [
    ...(input.trim() === '' ? [] : [`${names.get(actorId) ?? actorId}: ${input}`]),
    ...(narration.trim() === '' ? [] : [narration]),
  ]);
  return rows.length === 0 || currentScene === undefined ? rows : [`Scene: ${currentScene.title}`, ...rows];
};

const PANE_ROWS: Readonly<Record<PaneId, (data: TuiData) => readonly string[]>> = {
  conversation: ({ snapshot }) => conversation(snapshot),
  sheet: ({ snapshot, sheet }) => [
    ...snapshot.characters.map(({ name }) => `Character: ${name}`),
    ...sheet.map(({ label, value }) => (value === undefined ? label : `${label}: ${String(value)}`)),
  ],
  log: ({ events }) =>
    events.flatMap((event) => (event.type === EVENT_COMMITTED ? [`#${event.revision} ${event.event.type}`] : [])),
  mechanics: ({ mechanics }) => mechanics.map(indicator),
};

const paneRows = (id: PaneId, data: TuiData) => {
  const rows = PANE_ROWS[id](data);
  return rows.length === 0 ? [EMPTY[id]] : rows;
};

const paneAt = (index: number) => PANES[index] ?? CONVERSATION;

export const renderScreen = (state: TuiState, data: TuiData, { width, color }: Capabilities): string[] => {
  const focused = paneAt(state.pane);
  const emphasize = (rows: string[]) =>
    color ? rows.map((row) => styleText(EMPHASIS, row, { validateStream: false })) : rows;
  const tabs = PANES.map(({ key, label }) => (key === focused.key ? `[${key} ${label}]` : `${key} ${label}`));
  const title = state.help ? HELP_TITLE : `${focused.label}:`;
  const body = state.help ? HELP_LINES : paneRows(focused.id, data);
  const status = state.draft === undefined ? (state.notice ?? STATUS_HINT) : `${PROMPT}${state.draft}`;
  const rule = RULE.repeat(width);
  return [
    ...wrap([tabs.join(SPACE)], width),
    rule,
    ...emphasize(wrap([title], width)),
    ...wrap(body, width),
    rule,
    ...wrap([status], width),
  ];
};

const section = (title: string, rows: readonly string[], width: number) => wrap([title, ...rows], width);

export const renderLinear = (data: TuiData, { width }: Capabilities): string[] =>
  PANES.flatMap(({ id, label }) => section(`${label}:`, paneRows(id, data), width));

const isMechanic = (event: ClientEvent): event is VisualizationEvent => event.type === VISUALIZATION_EVENT;

const read = (session: ClientSession, campaignId: CampaignId, events: readonly ClientEvent[]): TuiData => {
  const snapshot = session.getSnapshot({ version: PROTOCOL_VERSION, type: 'GetCampaignSnapshot', campaignId });
  if (!snapshot.ok) throw new Error(snapshot.error.message);
  const sheet = session.requestView({ version: PROTOCOL_VERSION, type: 'RequestView', campaignId, viewId: SHEET_VIEW });
  if (!sheet.ok) throw new Error(sheet.error.message);
  return { snapshot: snapshot.value, sheet: sheet.value.components, events, mechanics: events.filter(isMechanic) };
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

const interactive = async (
  data: () => TuiData,
  session: ClientSession,
  terminal: Terminal,
  keys: AsyncIterable<Key>,
) => {
  let state = INITIAL_STATE;
  const paint = () =>
    terminal.write(`${CLEAR_SCREEN}${renderScreen(state, data(), terminal.capabilities).join(NEWLINE)}${NEWLINE}`);
  paint();
  for await (const key of keys) {
    state = nextState(state, key);
    if (state.quit) return;
    if (state.submitted !== undefined) state = { ...state, notice: submit(session, data(), state.submitted) };
    paint();
  }
};

const linear = async (data: () => TuiData, session: ClientSession, terminal: Terminal) => {
  const { width } = terminal.capabilities;
  const print = (rows: readonly string[]) => terminal.write(`${rows.join(NEWLINE)}${NEWLINE}`);
  const show = ({ id, label }: Pane) => print(section(`${label}:`, paneRows(id, data()), width));
  print(renderLinear(data(), terminal.capabilities));
  for await (const line of terminal.lines) {
    const text = line.trim();
    const pane = PANES.find(({ key }) => key === text);
    if (text === QUIT_KEY) return;
    if (text === '') continue;
    if (text === HELP_KEY) print(section(HELP_TITLE, HELP_LINES, width));
    else if (pane !== undefined) show(pane);
    else {
      const notice = submit(session, data(), text);
      if (notice === undefined) show(CONVERSATION);
      else print(wrap([notice], width));
    }
  }
};

export const runTui = async (session: ClientSession, campaignId: CampaignId, terminal: Terminal): Promise<void> => {
  const events: ClientEvent[] = [];
  const unsubscribe = session.subscribeEvents(
    { version: PROTOCOL_VERSION, type: 'SubscribeEvents', campaignId },
    (event) => events.push(event),
  );
  const data = () => read(session, campaignId, events);
  try {
    if (terminal.capabilities.interactive && terminal.keys !== undefined)
      await interactive(data, session, terminal, terminal.keys);
    else await linear(data, session, terminal);
  } finally {
    unsubscribe();
  }
};
