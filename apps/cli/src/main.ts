import { parseArgs } from 'node:util';
import type { Ask } from './character-creation.ts';
import { PLAIN_TERMINAL, type Terminal } from './tui.ts';
import { printable, VIEW_NAMES, type ViewName } from './views.ts';

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

const HELP_HINT = 'Run rpg help for usage.';
const VOICE_COMMAND = 'tui';
const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  voice: { type: 'boolean' },
} as const;

export type CampaignMode = 'play' | 'resume';

export type CampaignGateway = {
  launch: () => string;
  create: (name: string, intent: string | undefined, ask: Ask) => AsyncIterable<string>;
  list: () => string;
  archive: (campaign: string) => string;
  remove: (campaign: string, lines: AsyncIterable<string>) => AsyncIterable<string>;
  open: (
    campaign: string,
    mode: CampaignMode,
    lines: AsyncIterable<string>,
    onTurnError: (error: unknown) => void,
  ) => AsyncIterable<string>;
  importRules: (files: readonly string[], lines: AsyncIterable<string>) => AsyncIterable<string>;
  exportCampaign: (campaign: string, file: string) => string;
  backup: (campaign: string) => string;
  restore: (file: string) => string;
  view: (campaign: string, view: ViewName) => string;
  tui: (campaign: string, terminal: Terminal) => Promise<void>;
  start: (lines: AsyncIterable<string>) => AsyncIterable<string>;
};

export type Io = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  lines: AsyncIterable<string>;
  terminal?: Terminal;
};

const COMMANDS = [
  { name: 'launch', usage: 'launch', description: 'Open the launcher. This is the default.' },
  { name: 'start', usage: 'start', description: 'Start a new adventure with a few short questions you can skip.' },
  {
    name: 'new',
    usage: 'new <name> [intent]',
    description: 'Create a campaign from defaults or a one-sentence intent.',
  },
  { name: 'play', usage: 'play <campaign>', description: 'Start playing a campaign.' },
  { name: 'resume', usage: 'resume <campaign>', description: 'Continue a campaign.' },
  { name: 'list', usage: 'list', description: 'List active and archived campaigns.' },
  { name: 'archive', usage: 'archive <campaign>', description: 'Hide a campaign and keep its saved state.' },
  { name: 'delete', usage: 'delete <campaign>', description: 'Delete a campaign after you confirm its name.' },
  { name: 'import', usage: 'import <file...>', description: 'Import rule files and choose what to activate.' },
  {
    name: 'export',
    usage: 'export <campaign> <file>',
    description: 'Write a campaign and its rulepack pins to a portable archive file.',
  },
  { name: 'backup', usage: 'backup <campaign>', description: 'Save a dated archive of a campaign in the data folder.' },
  { name: 'restore', usage: 'restore <file>', description: 'Check an archive file and restore its campaign.' },
  { name: 'sheet', usage: 'sheet <campaign>', description: 'Show your character sheet.' },
  {
    name: 'sheet-export',
    usage: 'sheet-export <campaign>',
    description: 'Print your character sheet as portable JSON with rulepack provenance.',
  },
  { name: 'inventory', usage: 'inventory <campaign>', description: 'Show the items you carry.' },
  { name: 'journal', usage: 'journal <campaign>', description: 'Show the important events so far.' },
  { name: 'quests', usage: 'quests <campaign>', description: 'Show your quests and their objectives.' },
  {
    name: 'encounter',
    usage: 'encounter <campaign>',
    description: 'Show the current encounter, its rolls and outcome.',
  },
  {
    name: 'tui',
    usage: 'tui <campaign> [--voice]',
    description: 'Play with keyboard panes for talk, sheet, log and mechanics. --voice adds voice settings.',
  },
  { name: 'recap', usage: 'recap <campaign>', description: 'Show the current scene and the latest event.' },
  { name: 'help', usage: 'help', description: 'Show this help.' },
] as const;

const isView = (command: string): command is ViewName => VIEW_NAMES.some((view) => view === command);
const viewUsage = (view: ViewName) => COMMANDS.find(({ name }) => name === view)?.description ?? '';

const helpText = (): string =>
  ['Usage: rpg [command]', 'Commands:', ...COMMANDS.map((c) => `  ${c.usage} - ${c.description}`), ''].join('\n');

const usageError = (io: Io, message: string): number => {
  io.stderr(`${printable(message)}\n${HELP_HINT}\n`);
  return EXIT_USAGE;
};

const say = (io: Io, text: string): number => {
  io.stdout(`${printable(text)}\n`);
  return EXIT_OK;
};

const reportError = (io: Io, error: unknown) =>
  io.stderr(`${printable(error instanceof Error ? error.message : String(error))}\n`);

const fail = (io: Io, error: unknown): number => {
  reportError(io, error);
  return EXIT_FAILURE;
};

const withAsk = async function* (io: Io, create: (ask: Ask) => AsyncIterable<string>): AsyncGenerator<string> {
  const answers = io.lines[Symbol.asyncIterator]();
  try {
    yield* create(async (question) => {
      say(io, question);
      const next = await answers.next();
      return next.done ? undefined : next.value;
    });
  } finally {
    await answers.return?.();
  }
};

const CONTROL_PREFIX = '/';
const sessionHelp = (views: readonly ViewName[]) =>
  [
    'Type what you do in plain text. Plain text is a normal action.',
    'Controls:',
    '  /help - Show this help.',
    '  /history - Show your previous inputs.',
    ...views.map((view) => `  ${CONTROL_PREFIX}${view} - ${viewUsage(view)}`),
    '  /quit - End the session.',
  ].join('\n');
const QUIT_CONTROL = '/quit';
const HELP_CONTROL = '/help';
const HISTORY_CONTROL = '/history';
const NO_HISTORY = 'No inputs yet.';

const withControls = async function* (io: Io, show?: (view: ViewName) => string): AsyncGenerator<string> {
  const history: string[] = [];
  for await (const line of io.lines) {
    const text = line.trim();
    const control = text.slice(CONTROL_PREFIX.length);
    if (!text.startsWith(CONTROL_PREFIX)) {
      if (text !== '') history.push(text);
      yield line;
    } else if (text === QUIT_CONTROL) {
      return;
    } else if (text === HELP_CONTROL) {
      say(io, sessionHelp(show === undefined ? [] : VIEW_NAMES));
    } else if (text === HISTORY_CONTROL) {
      say(io, history.length === 0 ? NO_HISTORY : history.map((entry, index) => `${index + 1}. ${entry}`).join('\n'));
    } else if (show !== undefined && isView(control)) {
      try {
        say(io, show(control));
      } catch (error) {
        reportError(io, error);
      }
    } else {
      io.stderr(`Unknown control ${printable(text)}. Type /help for help.\n`);
    }
  }
};

const loadTuiAudio = async (): Promise<NonNullable<Terminal['audio']>> =>
  (await import('./tui-audio.ts')).defaultTuiAudio;

const run = async (io: Io, outputs: () => Iterable<string> | AsyncIterable<string>): Promise<number> => {
  try {
    for await (const text of outputs()) say(io, text);
    return EXIT_OK;
  } catch (error) {
    return fail(io, error);
  }
};

export const main = async (argv: readonly string[], io: Io, gateway: CampaignGateway): Promise<number> => {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true });
  } catch (error) {
    return usageError(io, error instanceof Error ? error.message : 'Invalid arguments.');
  }
  const [command = 'launch', ...rest] = parsed.positionals;
  const voice = parsed.values.voice === true;
  if (voice && command !== VOICE_COMMAND) return usageError(io, `Option --voice works only with ${VOICE_COMMAND}.`);
  const wantsHelp = parsed.values.help === true || command === 'help';
  if (wantsHelp) {
    const extra = parsed.values.help === true ? parsed.positionals : rest;
    if (extra.length > 0) return usageError(io, `Unexpected argument: ${extra[0]}.`);
    io.stdout(helpText());
    return EXIT_OK;
  }
  if (command === 'launch' || command === 'list' || command === 'start') {
    if (rest.length > 0) return usageError(io, `Unexpected argument: ${rest[0]}.`);
    if (command === 'start') return run(io, () => gateway.start(io.lines));
    return run(io, () => [command === 'launch' ? gateway.launch() : gateway.list()]);
  }
  if (command === 'archive' || command === 'delete') {
    const [name, ...extra] = rest;
    if (name === undefined || name.trim() === '') return usageError(io, `Missing campaign name for ${command}.`);
    if (extra.length > 0) return usageError(io, `Unexpected argument: ${extra[0]}.`);
    return run(io, () => (command === 'archive' ? [gateway.archive(name)] : gateway.remove(name, io.lines)));
  }
  if (command === 'new' || command === 'play' || command === 'resume') {
    const [name, ...extra] = rest;
    if (name === undefined || name.trim() === '') return usageError(io, `Missing campaign name for ${command}.`);
    const [intent, ...unexpected] = command === 'new' ? extra : [undefined, ...extra];
    if (unexpected.length > 0) return usageError(io, `Unexpected argument: ${unexpected[0]}.`);
    return run(io, () =>
      command === 'new'
        ? withAsk(io, (ask) => gateway.create(name, intent, ask))
        : gateway.open(
            name,
            command,
            withControls(io, (view) => gateway.view(name, view)),
            (error) => reportError(io, error),
          ),
    );
  }
  if (command === 'tui') {
    const [name, ...extra] = rest;
    if (name === undefined || name.trim() === '') return usageError(io, 'Missing campaign name for tui.');
    if (extra.length > 0) return usageError(io, `Unexpected argument: ${extra[0]}.`);
    const base = io.terminal ?? { capabilities: PLAIN_TERMINAL, lines: io.lines, write: io.stdout };
    try {
      const terminal = voice ? { ...base, audio: await loadTuiAudio() } : base;
      await gateway.tui(name, terminal);
      return EXIT_OK;
    } catch (error) {
      return fail(io, error);
    }
  }
  if (isView(command)) {
    const [name, ...extra] = rest;
    if (name === undefined || name.trim() === '') return usageError(io, `Missing campaign name for ${command}.`);
    if (extra.length > 0) return usageError(io, `Unexpected argument: ${extra[0]}.`);
    return run(io, () => [gateway.view(name, command)]);
  }
  if (command === 'import') {
    if (rest.length === 0 || rest.some((file) => file.trim() === '')) return usageError(io, 'Missing file for import.');
    return run(io, () => gateway.importRules(rest, withControls(io)));
  }
  if (command === 'export') {
    const [name, file, ...extra] = rest;
    if (name === undefined || name.trim() === '') return usageError(io, 'Missing campaign name for export.');
    if (file === undefined || file.trim() === '') return usageError(io, 'Missing file for export.');
    if (extra.length > 0) return usageError(io, `Unexpected argument: ${extra[0]}.`);
    return run(io, () => [gateway.exportCampaign(name, file)]);
  }
  if (command === 'backup' || command === 'restore') {
    const [value, ...extra] = rest;
    const missing = command === 'backup' ? 'campaign name' : 'file';
    if (value === undefined || value.trim() === '') return usageError(io, `Missing ${missing} for ${command}.`);
    if (extra.length > 0) return usageError(io, `Unexpected argument: ${extra[0]}.`);
    return run(io, () => [command === 'backup' ? gateway.backup(value) : gateway.restore(value)]);
  }
  return usageError(io, `Unsupported command: ${command}.`);
};
