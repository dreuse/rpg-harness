import { type HomeCard, hasSearch, homeCards, relativeTime } from '../../../packages/client-protocol/src/home.ts';
import type { CampaignHealth, CampaignSummary } from '../../../packages/client-protocol/src/protocol.ts';
import { DEFAULT_LOCALE, errorText, say } from './messages.ts';
import type { Terminal } from './tui.ts';

export type HomePorts = {
  readonly list: () => readonly CampaignSummary[];
  readonly archived: () => readonly CampaignSummary[];
  readonly archive: (name: string) => void;
  readonly unarchive: (name: string) => void;
  readonly remove: (name: string, confirm: string, archived: boolean) => void;
  readonly play: (name: string, terminal: Terminal) => Promise<void>;
  readonly start: (lines: AsyncIterable<string>, locale?: string) => AsyncIterable<string>;
};

type Pending = { readonly kind: 'archive' | 'delete'; readonly name: string; readonly archived: boolean };

const FIRST_NUMBER = 1;
const QUIT = 'q';
const NEW = 'n';
const UNDO = 'u';
const ARCHIVED = 'x';
const YES = 'y';
const SEARCH_PREFIX = '/';
const ARCHIVE_PREFIX = 'a';
const DELETE_PREFIX = 'd';
const SEPARATOR = ' - ';

const problem = (locale: string, health: Exclude<CampaignHealth, 'ok'>) =>
  `${say(locale, `home.problem.${health}`)} ${say(locale, 'home.restoreHint')}`;

const cardLines = (card: HomeCard, index: number, now: number, locale: string) => {
  const details =
    card.health === 'ok'
      ? [card.characters, card.rules, card.scene, relativeTime(card.lastPlayedAt, now, locale)]
      : [problem(locale, card.health)];
  const heading = [card.name, ...details].filter((part) => part !== undefined && part !== '').join(SEPARATOR);
  return [
    `  ${index + FIRST_NUMBER}. ${heading}`,
    ...(card.health === 'ok' && card.narration !== undefined ? [`     ${card.narration}`] : []),
  ];
};

const controls = (locale: string, archived: boolean, searchable: boolean) =>
  archived
    ? say(locale, 'home.controls.archived')
    : say(locale, 'home.controls', { search: searchable ? say(locale, 'home.controls.search') : '' });

const rest = (iterator: AsyncIterator<string>): AsyncIterable<string> => ({
  [Symbol.asyncIterator]: () => ({ next: () => iterator.next() }),
});

export const runHome = async (ports: HomePorts, terminal: Terminal, now = Date.now()): Promise<void> => {
  const input = terminal.lines[Symbol.asyncIterator]();
  const write = (text: string) => terminal.write(`${text}\n`);
  const locale = terminal.locale ?? DEFAULT_LOCALE;
  let showArchived = false;
  let query = '';
  let pending: Pending | undefined;
  let undo: string | undefined;
  const campaigns = () => (showArchived ? ports.archived() : ports.list());
  const cards = () => homeCards(campaigns(), query);
  const screen = () => {
    const all = campaigns();
    if (!showArchived && all.length === 0) return say(locale, 'home.empty');
    const shown = cards();
    return [
      showArchived
        ? say(locale, 'home.title.archived')
        : query === ''
          ? say(locale, 'home.title')
          : say(locale, 'home.title.matching', { query }),
      ...shown.flatMap((card, index) => cardLines(card, index, now, locale)),
      controls(locale, showArchived, !showArchived && hasSearch(all)),
    ].join('\n');
  };
  const cardAt = (text: string) => (/^\d+$/.test(text) ? cards()[Number(text) - FIRST_NUMBER] : undefined);
  const answer = (text: string, { kind, name, archived }: Pending) => {
    if (kind === 'archive' && text === YES) {
      ports.archive(name);
      undo = name;
      return say(locale, 'home.archived', { name });
    }
    if (kind === 'delete' && text === name) {
      ports.remove(name, text, archived);
      return say(locale, 'home.deleted', { name });
    }
    return say(locale, 'home.kept', { name });
  };
  const ask = (kind: Pending['kind'], card: HomeCard) => {
    pending = { kind, name: card.name, archived: showArchived };
    return say(locale, kind === 'archive' ? 'home.askArchive' : 'home.askDelete', { name: card.name });
  };
  write(screen());
  for (let next = await input.next(); next.done !== true; next = await input.next()) {
    const text = next.value.trim();
    if (text === QUIT) return;
    try {
      if (pending !== undefined) {
        const asked = pending;
        pending = undefined;
        write(`${answer(text, asked)}\n${screen()}`);
        continue;
      }
      const card = cardAt(text);
      const target = cardAt(text.slice(1));
      if (text === NEW && !showArchived) {
        for await (const output of ports.start(rest(input), locale)) write(output);
      } else if (text === UNDO && undo !== undefined) {
        ports.unarchive(undo);
        write(say(locale, 'home.restored', { name: undo }));
        undo = undefined;
      } else if (text === ARCHIVED) {
        showArchived = !showArchived;
        query = '';
      } else if (text.startsWith(SEARCH_PREFIX) && !showArchived && hasSearch(ports.list())) {
        query = text.slice(SEARCH_PREFIX.length).trim();
      } else if (text.startsWith(ARCHIVE_PREFIX) && target !== undefined && !showArchived) {
        write(ask('archive', target));
        continue;
      } else if (text.startsWith(DELETE_PREFIX) && target !== undefined) {
        write(ask('delete', target));
        continue;
      } else if (card !== undefined && showArchived) {
        ports.unarchive(card.name);
        write(say(locale, 'home.restored', { name: card.name }));
      } else if (card?.playable) {
        const interactive = terminal.capabilities.interactive && terminal.keys !== undefined;
        if (interactive) await input.return?.();
        await ports.play(card.name, interactive ? terminal : { ...terminal, lines: rest(input) });
        return;
      } else if (card !== undefined) {
        write(say(locale, 'home.cannotOpen', { name: card.name, hint: say(locale, 'home.restoreHint') }));
      } else {
        write(say(locale, 'choice.unknown'));
      }
    } catch (error) {
      write(errorText(locale, error));
    }
    write(screen());
  }
};
