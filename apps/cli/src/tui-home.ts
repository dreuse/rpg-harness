import { type HomeCard, hasSearch, homeCards, relativeTime } from '../../../packages/client-protocol/src/home.ts';
import type { CampaignHealth, CampaignSummary } from '../../../packages/client-protocol/src/protocol.ts';
import type { Terminal } from './tui.ts';

export type HomePorts = {
  readonly list: () => readonly CampaignSummary[];
  readonly archived: () => readonly CampaignSummary[];
  readonly archive: (name: string) => void;
  readonly unarchive: (name: string) => void;
  readonly remove: (name: string, confirm: string, archived: boolean) => void;
  readonly play: (name: string, terminal: Terminal) => Promise<void>;
  readonly start: (lines: AsyncIterable<string>) => AsyncIterable<string>;
};

type Pending = { readonly kind: 'archive' | 'delete'; readonly name: string; readonly archived: boolean };

const LOCALE = 'en';
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
const RESTORE_HINT = 'Restore it from a backup with rpg restore <file>.';
const PROBLEMS: Readonly<Record<Exclude<CampaignHealth, 'ok'>, string>> = {
  'needs-migration': 'this save needs a newer version of rpg.',
  unreadable: 'this save cannot be read.',
};
const EMPTY = 'No adventures yet. Type n to start one, or q to quit.';
const UNKNOWN_INPUT = 'Type one of the choices above.';

const cardLines = (card: HomeCard, index: number, now: number) => {
  const details =
    card.health === 'ok'
      ? [card.characters, card.rules, card.scene, relativeTime(card.lastPlayedAt, now, LOCALE)]
      : [`${PROBLEMS[card.health]} ${RESTORE_HINT}`];
  const heading = [card.name, ...details].filter((part) => part !== undefined && part !== '').join(SEPARATOR);
  return [
    `  ${index + FIRST_NUMBER}. ${heading}`,
    ...(card.health === 'ok' && card.narration !== undefined ? [`     ${card.narration}`] : []),
  ];
};

const controls = (archived: boolean, searchable: boolean) =>
  archived
    ? 'Type a number to restore it, d<number> to delete, x for your adventures, q to quit.'
    : [
        'Type a number to continue, n for a new adventure, a<number> to archive, d<number> to delete,',
        `x for archived adventures${searchable ? ', /text to search' : ''}, q to quit.`,
      ].join(' ');

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const rest = (iterator: AsyncIterator<string>): AsyncIterable<string> => ({
  [Symbol.asyncIterator]: () => ({ next: () => iterator.next() }),
});

export const runHome = async (ports: HomePorts, terminal: Terminal, now = Date.now()): Promise<void> => {
  const input = terminal.lines[Symbol.asyncIterator]();
  const write = (text: string) => terminal.write(`${text}\n`);
  let showArchived = false;
  let query = '';
  let pending: Pending | undefined;
  let undo: string | undefined;
  const campaigns = () => (showArchived ? ports.archived() : ports.list());
  const cards = () => homeCards(campaigns(), query);
  const screen = () => {
    const all = campaigns();
    if (!showArchived && all.length === 0) return EMPTY;
    const shown = cards();
    return [
      showArchived ? 'Archived adventures' : query === '' ? 'Your adventures' : `Matching "${query}"`,
      ...shown.flatMap((card, index) => cardLines(card, index, now)),
      controls(showArchived, !showArchived && hasSearch(all)),
    ].join('\n');
  };
  const cardAt = (text: string) => (/^\d+$/.test(text) ? cards()[Number(text) - FIRST_NUMBER] : undefined);
  const answer = (text: string, { kind, name, archived }: Pending) => {
    if (kind === 'archive' && text === YES) {
      ports.archive(name);
      undo = name;
      return `Archived ${name}. Type u to undo.`;
    }
    if (kind === 'delete' && text === name) {
      ports.remove(name, text, archived);
      return `Deleted ${name}.`;
    }
    return `Kept ${name}.`;
  };
  const ask = (kind: Pending['kind'], card: HomeCard) => {
    pending = { kind, name: card.name, archived: showArchived };
    return kind === 'archive'
      ? `Archive ${card.name}? Type y to archive it.`
      : `Deleting ${card.name} removes it for good. Type ${card.name} to delete it.`;
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
        for await (const output of ports.start(rest(input))) write(output);
      } else if (text === UNDO && undo !== undefined) {
        ports.unarchive(undo);
        write(`Restored ${undo}.`);
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
        write(`Restored ${card.name}.`);
      } else if (card?.playable) {
        const interactive = terminal.capabilities.interactive && terminal.keys !== undefined;
        if (interactive) await input.return?.();
        await ports.play(card.name, interactive ? terminal : { ...terminal, lines: rest(input) });
        return;
      } else if (card !== undefined) {
        write(`${card.name} cannot be opened. ${RESTORE_HINT}`);
      } else {
        write(UNKNOWN_INPUT);
      }
    } catch (error) {
      write(errorText(error));
    }
    write(screen());
  }
};
