import { parseArgs } from 'node:util';

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

const HELP_HINT = 'Run rpg help for usage.';

export type CampaignMode = 'play' | 'resume';

export type CampaignGateway = {
  launch: () => string;
  create: (name: string, intent?: string) => string;
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
};

export type Io = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  lines: AsyncIterable<string>;
};

const COMMANDS = [
  { name: 'launch', usage: 'launch', description: 'Open the launcher. This is the default.' },
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
  { name: 'help', usage: 'help', description: 'Show this help.' },
] as const;

const helpText = (): string =>
  ['Usage: rpg [command]', 'Commands:', ...COMMANDS.map((c) => `  ${c.usage} - ${c.description}`), ''].join('\n');

const usageError = (io: Io, message: string): number => {
  io.stderr(`${message}\n${HELP_HINT}\n`);
  return EXIT_USAGE;
};

const say = (io: Io, text: string): number => {
  io.stdout(`${text}\n`);
  return EXIT_OK;
};

const reportError = (io: Io, error: unknown) =>
  io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);

const fail = (io: Io, error: unknown): number => {
  reportError(io, error);
  return EXIT_FAILURE;
};

const CONTROL_PREFIX = '/';
const SESSION_HELP = [
  'Type what you do in plain text. Plain text is a normal action.',
  'Controls:',
  '  /help - Show this help.',
  '  /history - Show your previous inputs.',
  '  /quit - End the session.',
].join('\n');
const QUIT_CONTROL = '/quit';
const HELP_CONTROL = '/help';
const HISTORY_CONTROL = '/history';
const NO_HISTORY = 'No inputs yet.';

const withControls = async function* (io: Io): AsyncGenerator<string> {
  const history: string[] = [];
  for await (const line of io.lines) {
    const text = line.trim();
    if (!text.startsWith(CONTROL_PREFIX)) {
      if (text !== '') history.push(text);
      yield line;
    } else if (text === QUIT_CONTROL) {
      return;
    } else if (text === HELP_CONTROL) {
      say(io, SESSION_HELP);
    } else if (text === HISTORY_CONTROL) {
      say(io, history.length === 0 ? NO_HISTORY : history.map((entry, index) => `${index + 1}. ${entry}`).join('\n'));
    } else {
      io.stderr(`Unknown control ${text}. Type /help for help.\n`);
    }
  }
};

const run = async (io: Io, outputs: () => Iterable<string> | AsyncIterable<string>): Promise<number> => {
  try {
    for await (const text of outputs()) say(io, text);
    return EXIT_OK;
  } catch (error) {
    return fail(io, error);
  }
};

export const main = async (argv: readonly string[], io: Io, gateway: CampaignGateway): Promise<number> => {
  let parsed: ReturnType<
    typeof parseArgs<{ options: { help: { type: 'boolean'; short: 'h' } }; allowPositionals: true }>
  >;
  try {
    parsed = parseArgs({ args: [...argv], options: { help: { type: 'boolean', short: 'h' } }, allowPositionals: true });
  } catch (error) {
    return usageError(io, error instanceof Error ? error.message : 'Invalid arguments.');
  }
  const [command = 'launch', ...rest] = parsed.positionals;
  const wantsHelp = parsed.values.help === true || command === 'help';
  if (wantsHelp) {
    const extra = parsed.values.help === true ? parsed.positionals : rest;
    if (extra.length > 0) return usageError(io, `Unexpected argument: ${extra[0]}.`);
    io.stdout(helpText());
    return EXIT_OK;
  }
  if (command === 'launch' || command === 'list') {
    if (rest.length > 0) return usageError(io, `Unexpected argument: ${rest[0]}.`);
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
        ? [gateway.create(name, intent)]
        : gateway.open(name, command, withControls(io), (error) => reportError(io, error)),
    );
  }
  if (command === 'import') {
    if (rest.length === 0 || rest.some((file) => file.trim() === '')) return usageError(io, 'Missing file for import.');
    return run(io, () => gateway.importRules(rest, withControls(io)));
  }
  return usageError(io, `Unsupported command: ${command}.`);
};
