import { parseArgs } from 'node:util';
import { CLIENTS } from '../../../packages/intent/src/intent.ts';
import type { Ask } from './character-creation.ts';
import type { GmSettingsChanges } from './engine-gateway.ts';
import { DEFAULT_LOCALE, errorText, say as phrase, safeLocale } from './messages.ts';
import type { SoundRequest } from './sound-command.ts';
import { PLAIN_TERMINAL, type Terminal } from './tui.ts';
import type { UpdateRequest } from './update.ts';
import { printable, VIEW_NAMES, type ViewName } from './views.ts';

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

const LIST_STYLE = { type: 'conjunction' } as const;
const VOICE_OPTION = '--voice';
const CLIENT_OPTION = '--client';
const UPDATE_OPTIONS = ['--check', '--auto-check', '--pre-release'];
const SETTINGS_OPTIONS = ['--model', '--summary-model', '--session-budget', '--rules-strictness'];
const SOUND_OPTION_KEYS = [
  'ambience',
  'effects',
  'music',
  'ambience-volume',
  'effects-volume',
  'music-volume',
  'download',
  'yes',
] as const;
const VOICE_COMMAND = 'tui';
const UPDATE_COMMAND = 'update';
const CLIENT_COMMAND = 'new';
const SETTINGS_COMMAND = 'settings';
const CLAUDE_COMMAND = 'claude';
const SOUND_COMMAND = 'sound';
const SOUND_OPTIONS = [
  '--ambience',
  '--effects',
  '--music',
  '--ambience-volume',
  '--effects-volume',
  '--music-volume',
  '--download',
  '--yes',
];
const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  voice: { type: 'boolean' },
  client: { type: 'string' },
  check: { type: 'boolean' },
  'auto-check': { type: 'boolean' },
  'pre-release': { type: 'boolean' },
  model: { type: 'string' },
  'summary-model': { type: 'string' },
  'session-budget': { type: 'string' },
  'rules-strictness': { type: 'string' },
  ambience: { type: 'boolean' },
  effects: { type: 'boolean' },
  music: { type: 'boolean' },
  'ambience-volume': { type: 'string' },
  'effects-volume': { type: 'string' },
  'music-volume': { type: 'string' },
  download: { type: 'boolean' },
  yes: { type: 'boolean' },
} as const;

export type CampaignMode = 'play' | 'resume';

export type CampaignGateway = {
  home: (terminal: Terminal) => Promise<void>;
  create: (
    name: string,
    intent: string | undefined,
    ask: Ask,
    client?: string,
    language?: string,
  ) => AsyncIterable<string>;
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
  start: (lines: AsyncIterable<string>, locale?: string) => AsyncIterable<string>;
  update: (request: UpdateRequest) => AsyncIterable<string>;
  settings: (campaign: string | undefined, changes: GmSettingsChanges) => string;
  claude: (campaign: string | undefined) => number;
  sound: (request: SoundRequest) => AsyncIterable<string>;
};

export type Io = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  lines: AsyncIterable<string>;
  terminal?: Terminal;
  locale?: string;
};

const COMMANDS = [
  {
    name: 'launch',
    usage: 'launch',
  },
  { name: 'start', usage: 'start' },
  {
    name: 'new',
    usage: 'new <name|pitch> [intent] [--client cli|tui|desktop]',
  },
  { name: 'play', usage: 'play <campaign>' },
  { name: 'resume', usage: 'resume <campaign>' },
  { name: 'list', usage: 'list' },
  { name: 'archive', usage: 'archive <campaign>' },
  { name: 'delete', usage: 'delete <campaign>' },
  { name: 'import', usage: 'import <file...>' },
  {
    name: 'export',
    usage: 'export <campaign> <file>',
  },
  { name: 'backup', usage: 'backup <campaign>' },
  { name: 'restore', usage: 'restore <file>' },
  { name: 'sheet', usage: 'sheet <campaign>' },
  {
    name: 'sheet-export',
    usage: 'sheet-export <campaign>',
  },
  { name: 'inventory', usage: 'inventory <campaign>' },
  { name: 'journal', usage: 'journal <campaign>' },
  { name: 'quests', usage: 'quests <campaign>' },
  {
    name: 'encounter',
    usage: 'encounter <campaign>',
  },
  {
    name: 'tui',
    usage: 'tui [campaign] [--voice]',
  },
  { name: 'recap', usage: 'recap <campaign>' },
  {
    name: 'update',
    usage: 'update [--check] [--no-auto-check] [--pre-release]',
  },
  {
    name: SETTINGS_COMMAND,
    usage:
      'settings [campaign] [--model <name>] [--summary-model <name>] [--session-budget <tokens>] [--rules-strictness <as-written|relaxed|off|unset>]',
  },
  { name: CLAUDE_COMMAND, usage: 'claude [campaign]' },
  {
    name: SOUND_COMMAND,
    usage:
      'sound [--ambience] [--effects] [--music] [--ambience-volume <0-1>] [--effects-volume <0-1>] [--music-volume <0-1>] [--download [--yes]]',
  },
  { name: 'help', usage: 'help' },
] as const;

const isView = (command: string): command is ViewName => VIEW_NAMES.some((view) => view === command);
const localeOf = (io: Io) => io.locale ?? DEFAULT_LOCALE;
const describe = (locale: string, command: string) => phrase(locale, `command.${command}`);

const helpText = (locale: string): string =>
  [
    phrase(locale, 'cli.usage'),
    phrase(locale, 'cli.commands'),
    ...COMMANDS.map(({ name, usage }) => `  ${usage} - ${describe(locale, name)}`),
    '',
  ].join('\n');

const usageError = (io: Io, message: string): number => {
  io.stderr(`${printable(message)}\n${phrase(localeOf(io), 'cli.helpHint')}\n`);
  return EXIT_USAGE;
};

const say = (io: Io, text: string): number => {
  io.stdout(`${printable(text)}\n`);
  return EXIT_OK;
};

const reportError = (io: Io, error: unknown) => io.stderr(`${printable(errorText(localeOf(io), error))}\n`);

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
const QUIT_CONTROL = '/quit';
const HELP_CONTROL = '/help';
const HISTORY_CONTROL = '/history';
const sessionHelp = (views: readonly ViewName[], locale: string) =>
  [
    phrase(locale, 'session.plain'),
    phrase(locale, 'session.controls'),
    `  ${HELP_CONTROL} - ${describe(locale, 'help')}`,
    `  ${HISTORY_CONTROL} - ${phrase(locale, 'control.history')}`,
    ...views.map((view) => `  ${CONTROL_PREFIX}${view} - ${describe(locale, view)}`),
    `  ${QUIT_CONTROL} - ${phrase(locale, 'control.quit')}`,
  ].join('\n');

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
      say(io, sessionHelp(show === undefined ? [] : VIEW_NAMES, localeOf(io)));
    } else if (text === HISTORY_CONTROL) {
      say(
        io,
        history.length === 0
          ? phrase(localeOf(io), 'session.noHistory')
          : history.map((entry, index) => `${index + 1}. ${entry}`).join('\n'),
      );
    } else if (show !== undefined && isView(control)) {
      try {
        say(io, show(control));
      } catch (error) {
        reportError(io, error);
      }
    } else {
      io.stderr(`${phrase(localeOf(io), 'session.unknown', { control: printable(text) })}\n`);
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
  const locale = localeOf(io);
  const list = (items: readonly string[]) => new Intl.ListFormat(safeLocale(locale), LIST_STYLE).format(items);
  const unexpectedArgument = (value: string | undefined) => usageError(io, phrase(locale, 'cli.unexpected', { value }));
  const missingName = (command: string) => usageError(io, phrase(locale, 'cli.missingName', { command }));
  const missingFile = (command: string) => usageError(io, phrase(locale, 'cli.missingFile', { command }));
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true; allowNegative: true }>>;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, allowNegative: true });
  } catch (error) {
    return usageError(io, error instanceof Error ? error.message : phrase(locale, 'cli.invalid'));
  }
  const [command = 'launch', ...rest] = parsed.positionals;
  const voice = parsed.values.voice === true;
  if (voice && command !== VOICE_COMMAND)
    return usageError(io, phrase(locale, 'cli.optionOnlyWith', { option: VOICE_OPTION, command: VOICE_COMMAND }));
  const { client } = parsed.values;
  if (client !== undefined && command !== CLIENT_COMMAND)
    return usageError(io, phrase(locale, 'cli.optionOnlyWith', { option: CLIENT_OPTION, command: CLIENT_COMMAND }));
  if (client !== undefined && !CLIENTS.some((known) => known === client))
    return usageError(io, phrase(locale, 'cli.unknownClient', { client, clients: CLIENTS.join(', ') }));
  const { check, 'auto-check': autoCheck, 'pre-release': preRelease } = parsed.values;
  const updateOption = [check, autoCheck, preRelease].some((value) => value !== undefined);
  if (updateOption && command !== UPDATE_COMMAND)
    return usageError(
      io,
      phrase(locale, 'cli.optionsOnlyWith', { options: list(UPDATE_OPTIONS), command: UPDATE_COMMAND }),
    );
  const {
    model,
    'summary-model': summaryModel,
    'session-budget': sessionBudgetTokens,
    'rules-strictness': rulesStrictness,
  } = parsed.values;
  const settingsOption = [model, summaryModel, sessionBudgetTokens, rulesStrictness].some(
    (value) => value !== undefined,
  );
  if (settingsOption && command !== SETTINGS_COMMAND)
    return usageError(
      io,
      phrase(locale, 'cli.optionsOnlyWith', { options: list(SETTINGS_OPTIONS), command: SETTINGS_COMMAND }),
    );
  const soundOption = SOUND_OPTION_KEYS.some((key) => parsed.values[key] !== undefined);
  if (soundOption && command !== SOUND_COMMAND)
    return usageError(
      io,
      phrase(locale, 'cli.optionsOnlyWith', { options: list(SOUND_OPTIONS), command: SOUND_COMMAND }),
    );
  const wantsHelp = parsed.values.help === true || command === 'help';
  if (wantsHelp) {
    const extra = parsed.values.help === true ? parsed.positionals : rest;
    if (extra.length > 0) return unexpectedArgument(extra[0]);
    io.stdout(helpText(locale));
    return EXIT_OK;
  }
  if (command === 'list' || command === 'start') {
    if (rest.length > 0) return unexpectedArgument(rest[0]);
    if (command === 'start') return run(io, () => gateway.start(io.lines, io.locale));
    return run(io, () => [gateway.list()]);
  }
  if (command === 'archive' || command === 'delete') {
    const [name, ...extra] = rest;
    if (name === undefined || name.trim() === '') return missingName(command);
    if (extra.length > 0) return unexpectedArgument(extra[0]);
    return run(io, () => (command === 'archive' ? [gateway.archive(name)] : gateway.remove(name, io.lines)));
  }
  if (command === 'new' || command === 'play' || command === 'resume') {
    const [name, ...extra] = rest;
    if (name === undefined || name.trim() === '') return missingName(command);
    const [intent, ...unexpected] = command === 'new' ? extra : [undefined, ...extra];
    if (unexpected.length > 0) return unexpectedArgument(unexpected[0]);
    return run(io, () =>
      command === 'new'
        ? withAsk(io, (ask) => gateway.create(name, intent, ask, client, io.locale))
        : gateway.open(
            name,
            command,
            withControls(io, (view) => gateway.view(name, view)),
            (error) => reportError(io, error),
          ),
    );
  }
  if (command === 'tui' || command === 'launch') {
    const [name, ...extra] = command === 'launch' ? [undefined, ...rest] : rest;
    if (name !== undefined && name.trim() === '') return missingName('tui');
    if (extra.length > 0) return unexpectedArgument(extra[0]);
    const base = io.terminal ?? { capabilities: PLAIN_TERMINAL, lines: io.lines, write: io.stdout };
    try {
      const terminal = voice ? { ...base, audio: await loadTuiAudio() } : base;
      await (name === undefined ? gateway.home(terminal) : gateway.tui(name, terminal));
      return EXIT_OK;
    } catch (error) {
      return fail(io, error);
    }
  }
  if (isView(command)) {
    const [name, ...extra] = rest;
    if (name === undefined || name.trim() === '') return missingName(command);
    if (extra.length > 0) return unexpectedArgument(extra[0]);
    return run(io, () => [gateway.view(name, command)]);
  }
  if (command === 'import') {
    if (rest.length === 0 || rest.some((file) => file.trim() === '')) return missingFile('import');
    return run(io, () => gateway.importRules(rest, withControls(io)));
  }
  if (command === 'export') {
    const [name, file, ...extra] = rest;
    if (name === undefined || name.trim() === '') return missingName('export');
    if (file === undefined || file.trim() === '') return missingFile('export');
    if (extra.length > 0) return unexpectedArgument(extra[0]);
    return run(io, () => [gateway.exportCampaign(name, file)]);
  }
  if (command === 'backup' || command === 'restore') {
    const [value, ...extra] = rest;
    if (value === undefined || value.trim() === '')
      return command === 'backup' ? missingName(command) : missingFile(command);
    if (extra.length > 0) return unexpectedArgument(extra[0]);
    return run(io, () => [command === 'backup' ? gateway.backup(value) : gateway.restore(value)]);
  }
  if (command === UPDATE_COMMAND) {
    if (rest.length > 0) return unexpectedArgument(rest[0]);
    return run(io, () =>
      gateway.update({
        check: check === true,
        ...(autoCheck !== undefined && { autoCheck }),
        ...(preRelease !== undefined && { preRelease }),
      }),
    );
  }
  if (command === SETTINGS_COMMAND) {
    const [name, ...extra] = rest;
    if (name !== undefined && name.trim() === '') return missingName('settings');
    if (extra.length > 0) return unexpectedArgument(extra[0]);
    const changes = Object.fromEntries(
      Object.entries({ model, summaryModel, sessionBudgetTokens, rulesStrictness }).filter(
        ([, value]) => value !== undefined,
      ),
    );
    return run(io, () => [gateway.settings(name, changes)]);
  }
  if (command === CLAUDE_COMMAND) {
    const [name, ...extra] = rest;
    if (name !== undefined && name.trim() === '') return missingName(CLAUDE_COMMAND);
    if (extra.length > 0) return unexpectedArgument(extra[0]);
    try {
      return gateway.claude(name);
    } catch (error) {
      return fail(io, error);
    }
  }
  if (command === SOUND_COMMAND) {
    if (rest.length > 0) return unexpectedArgument(rest[0]);
    const { soundRequestOf } = await import('./sound-command.ts');
    const request = soundRequestOf(parsed.values);
    if (typeof request === 'string') return usageError(io, request);
    return run(io, () => gateway.sound(request));
  }
  return usageError(io, phrase(locale, 'cli.unsupported', { command }));
};
