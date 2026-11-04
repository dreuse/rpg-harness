import { parseArgs } from 'node:util';

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

const HELP_HINT = 'Run rpg help for usage.';

export type CampaignMode = 'play' | 'resume';

export type CampaignGateway = {
  launch: () => string;
  create: (name: string) => string;
  open: (campaign: string, mode: CampaignMode, lines: AsyncIterable<string>) => AsyncIterable<string>;
};

export type Io = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  lines: AsyncIterable<string>;
};

const COMMANDS = [
  { name: 'launch', usage: 'launch', description: 'Open the launcher. This is the default.' },
  { name: 'new', usage: 'new <name>', description: 'Create a campaign.' },
  { name: 'play', usage: 'play <campaign>', description: 'Start playing a campaign.' },
  { name: 'resume', usage: 'resume <campaign>', description: 'Continue a campaign.' },
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

const fail = (io: Io, error: unknown): number => {
  io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
  return EXIT_FAILURE;
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
  if (command === 'launch') {
    return rest.length > 0 ? usageError(io, `Unexpected argument: ${rest[0]}.`) : run(io, () => [gateway.launch()]);
  }
  if (command === 'new' || command === 'play' || command === 'resume') {
    const [name, ...extra] = rest;
    if (name === undefined || name.trim() === '') return usageError(io, `Missing campaign name for ${command}.`);
    if (extra.length > 0) return usageError(io, `Unexpected argument: ${extra[0]}.`);
    return run(io, () => (command === 'new' ? [gateway.create(name)] : gateway.open(name, command, io.lines)));
  }
  return usageError(io, `Unsupported command: ${command}.`);
};
