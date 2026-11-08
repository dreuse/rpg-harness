import { type Catalog, createTranslator, type Params } from './locale.ts';

export type SlashClient = 'desktop' | 'tui' | 'line';

export type SlashCommand = {
  readonly id: string;
  readonly clients: readonly SlashClient[];
  readonly hasArgs: boolean;
};

export type SlashOption = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly args: string;
};

export type SlashResolution =
  | { readonly kind: 'none' }
  | { readonly kind: 'command'; readonly id: string; readonly args: string }
  | { readonly kind: 'unknown'; readonly name: string };

export type SlashCompletion = { readonly text: string; readonly matches: readonly string[] };

export const SLASH_PREFIX = '/';

const BOTH: readonly SlashClient[] = ['desktop', 'tui'];
const TUI: readonly SlashClient[] = ['tui'];
const LINE: readonly SlashClient[] = ['line'];
const TUI_AND_LINE: readonly SlashClient[] = ['tui', 'line'];
const ALL_CLIENTS: readonly SlashClient[] = ['desktop', 'tui', 'line'];
const TYPED_COMMAND = /^\/(\S*)(?:\s+([\s\S]*))?$/;
const NAME_GROUP = 1;
const ARGS_GROUP = 2;
const COMPLETION_SUFFIX = ' ';

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { id: 'gm', clients: BOTH, hasArgs: true },
  { id: 'roll', clients: ALL_CLIENTS, hasArgs: false },
  { id: 'retry', clients: TUI, hasArgs: false },
  { id: 'edit', clients: TUI, hasArgs: true },
  { id: 'language', clients: TUI, hasArgs: true },
  { id: 'voice', clients: TUI, hasArgs: false },
  { id: 'memory', clients: TUI, hasArgs: true },
  { id: 'help', clients: TUI_AND_LINE, hasArgs: false },
  { id: 'history', clients: LINE, hasArgs: false },
  { id: 'journal', clients: LINE, hasArgs: false },
  { id: 'sheet', clients: LINE, hasArgs: false },
  { id: 'sheet-export', clients: LINE, hasArgs: false },
  { id: 'encounter', clients: LINE, hasArgs: false },
  { id: 'quit', clients: LINE, hasArgs: false },
];

export const SLASH_CATALOG: Catalog = {
  en: {
    'slash.gm.name': 'gm',
    'slash.gm.args': '<message>',
    'slash.gm.description': 'Talk to the GM out of character.',
    'slash.roll.name': 'roll',
    'slash.roll.description': 'Roll the check the GM offered.',
    'slash.retry.name': 'retry',
    'slash.retry.description': 'Ask the GM again after a failed reply.',
    'slash.edit.name': 'edit',
    'slash.edit.args': '<field> <value>',
    'slash.edit.description': 'Change a sheet field.',
    'slash.language.name': 'language',
    'slash.language.args': '<code>',
    'slash.language.description': 'Change the story language, for example en, es or pt-BR.',
    'slash.voice.name': 'voice',
    'slash.voice.description': 'Show the voice diagnostics.',
    'slash.memory.name': 'memory',
    'slash.memory.args': '<number> <new value>',
    'slash.memory.description': 'Show what the story remembers, or correct a fact.',
    'slash.help.name': 'help',
    'slash.help.description': 'List the available commands.',
    'slash.history.name': 'history',
    'slash.history.description': 'Show your previous inputs.',
    'slash.journal.name': 'journal',
    'slash.journal.description': 'Show the important events so far.',
    'slash.sheet.name': 'sheet',
    'slash.sheet.description': 'Show your character sheet.',
    'slash.sheet-export.name': 'sheet-export',
    'slash.sheet-export.description': 'Print your character sheet as portable JSON.',
    'slash.encounter.name': 'encounter',
    'slash.encounter.description': 'Show the current encounter, its rolls and outcome.',
    'slash.quit.name': 'quit',
    'slash.quit.description': 'End the session.',
    'slash.unknown': 'Unknown command {name}. It was not sent to the GM. Type / to see the commands.',
    'slash.options.one': '{count} command available',
    'slash.options.other': '{count} commands available',
    'slash.none': 'No matching command',
    'slash.list': 'Commands',
  },
  es: {
    'slash.gm.name': 'gm',
    'slash.gm.args': '<mensaje>',
    'slash.gm.description': 'Habla con el GM fuera del personaje.',
    'slash.roll.name': 'tirar',
    'slash.roll.description': 'Tira la prueba que ofreció el GM.',
    'slash.retry.name': 'reintentar',
    'slash.retry.description': 'Vuelve a pedir la respuesta al GM después de un fallo.',
    'slash.edit.name': 'editar',
    'slash.edit.args': '<campo> <valor>',
    'slash.edit.description': 'Cambia un campo de la ficha.',
    'slash.language.name': 'idioma',
    'slash.language.args': '<código>',
    'slash.language.description': 'Cambia el idioma de la historia, por ejemplo en, es o pt-BR.',
    'slash.voice.name': 'voz',
    'slash.voice.description': 'Muestra el diagnóstico de voz.',
    'slash.memory.name': 'memoria',
    'slash.memory.args': '<número> <nuevo valor>',
    'slash.memory.description': 'Muestra lo que recuerda la historia o corrige un dato.',
    'slash.help.name': 'ayuda',
    'slash.help.description': 'Lista los comandos disponibles.',
    'slash.history.name': 'historial',
    'slash.history.description': 'Muestra tus entradas anteriores.',
    'slash.journal.name': 'diario',
    'slash.journal.description': 'Muestra los eventos importantes hasta ahora.',
    'slash.sheet.name': 'ficha',
    'slash.sheet.description': 'Muestra tu ficha de personaje.',
    'slash.sheet-export.name': 'exportar-ficha',
    'slash.sheet-export.description': 'Imprime tu ficha de personaje como JSON portátil.',
    'slash.encounter.name': 'encuentro',
    'slash.encounter.description': 'Muestra el encuentro actual, sus tiradas y su resultado.',
    'slash.quit.name': 'salir',
    'slash.quit.description': 'Termina la sesión.',
    'slash.unknown': 'Comando {name} desconocido. No se envió al GM. Escribe / para ver los comandos.',
    'slash.options.one': '{count} comando disponible',
    'slash.options.other': '{count} comandos disponibles',
    'slash.none': 'Ningún comando coincide',
    'slash.list': 'Comandos',
  },
  'pt-BR': {
    'slash.gm.name': 'gm',
    'slash.gm.args': '<mensagem>',
    'slash.gm.description': 'Fale com o GM fora do personagem.',
    'slash.roll.name': 'rolar',
    'slash.roll.description': 'Rola o teste que o GM ofereceu.',
    'slash.retry.name': 'repetir',
    'slash.retry.description': 'Pede a resposta ao GM de novo depois de uma falha.',
    'slash.edit.name': 'editar',
    'slash.edit.args': '<campo> <valor>',
    'slash.edit.description': 'Muda um campo da ficha.',
    'slash.language.name': 'idioma',
    'slash.language.args': '<código>',
    'slash.language.description': 'Muda o idioma da história, por exemplo en, es ou pt-BR.',
    'slash.voice.name': 'voz',
    'slash.voice.description': 'Mostra o diagnóstico de voz.',
    'slash.memory.name': 'memoria',
    'slash.memory.args': '<número> <novo valor>',
    'slash.memory.description': 'Mostra o que a história lembra ou corrige um fato.',
    'slash.help.name': 'ajuda',
    'slash.help.description': 'Lista os comandos disponíveis.',
    'slash.history.name': 'historico',
    'slash.history.description': 'Mostra suas entradas anteriores.',
    'slash.journal.name': 'diario',
    'slash.journal.description': 'Mostra os eventos importantes até agora.',
    'slash.sheet.name': 'ficha',
    'slash.sheet.description': 'Mostra sua ficha de personagem.',
    'slash.sheet-export.name': 'exportar-ficha',
    'slash.sheet-export.description': 'Imprime sua ficha de personagem como JSON portátil.',
    'slash.encounter.name': 'encontro',
    'slash.encounter.description': 'Mostra o encontro atual, suas rolagens e o resultado.',
    'slash.quit.name': 'sair',
    'slash.quit.description': 'Encerra a sessão.',
    'slash.unknown': 'Comando {name} desconhecido. Ele não foi enviado ao GM. Digite / para ver os comandos.',
    'slash.options.one': '{count} comando disponível',
    'slash.options.other': '{count} comandos disponíveis',
    'slash.none': 'Nenhum comando corresponde',
    'slash.list': 'Comandos',
  },
};

const translate = createTranslator(SLASH_CATALOG);

export const slashText = (locale: string, key: string, params?: Params): string => translate(locale, key, params);

const nameOf = (locale: string, { id }: SlashCommand) => translate(locale, `slash.${id}.name`);

const namesOf = (locale: string, command: SlashCommand) => [nameOf(locale, command), command.id];

const available = (client: SlashClient) => SLASH_COMMANDS.filter(({ clients }) => clients.includes(client));

const optionOf = (locale: string, command: SlashCommand): SlashOption => ({
  id: command.id,
  name: `${SLASH_PREFIX}${nameOf(locale, command)}`,
  description: translate(locale, `slash.${command.id}.description`),
  args: command.hasArgs ? translate(locale, `slash.${command.id}.args`) : '',
});

const typedName = (typed: string) => {
  const found = TYPED_COMMAND.exec(typed);
  return found === null || found[ARGS_GROUP] !== undefined ? undefined : found[NAME_GROUP];
};

const matched = (locale: string, client: SlashClient, typed: string) => {
  const prefix = typedName(typed)?.toLowerCase();
  if (prefix === undefined) return [];
  return available(client).flatMap((command) => {
    const name = namesOf(locale, command).find((candidate) => candidate.startsWith(prefix));
    return name === undefined ? [] : [{ command, name }];
  });
};

export const matchSlash = (locale: string, client: SlashClient, typed: string): SlashOption[] =>
  matched(locale, client, typed).map(({ command }) => optionOf(locale, command));

export const resolveSlash = (locale: string, client: SlashClient, text: string): SlashResolution => {
  const trimmed = text.trim();
  const found = TYPED_COMMAND.exec(trimmed);
  if (found === null) return { kind: 'none' };
  const name = (found[NAME_GROUP] ?? '').toLowerCase();
  const command = available(client).find((candidate) => namesOf(locale, candidate).includes(name));
  return command === undefined
    ? { kind: 'unknown', name: `${SLASH_PREFIX}${found[NAME_GROUP]}` }
    : { kind: 'command', id: command.id, args: (found[ARGS_GROUP] ?? '').trim() };
};

const sharedPrefix = (names: readonly string[]) =>
  names.reduce((prefix, name) => {
    let length = 0;
    while (length < prefix.length && prefix[length] === name[length]) length += 1;
    return prefix.slice(0, length);
  });

export const slashCompletion = (locale: string, client: SlashClient, typed: string): SlashCompletion => {
  const names = matched(locale, client, typed).map(({ name }) => `${SLASH_PREFIX}${name}`);
  if (names.length === 0) return { text: typed, matches: [] };
  const [only] = names;
  const shared = sharedPrefix(names);
  const text = names.length === 1 ? `${only}${COMPLETION_SUFFIX}` : shared.length > typed.length ? shared : typed;
  return { text, matches: names };
};
