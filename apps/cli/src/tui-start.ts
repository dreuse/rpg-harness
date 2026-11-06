import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createCommand,
  loadStartDraft,
  nextDraft,
  planCommand,
  START_DRAFT_FILE,
  type StartAction,
  type StartDraft,
  type StartScreen,
  startScreen,
  stepOf,
} from '../../../packages/client-protocol/src/guided-start.ts';
import type { CampaignSummary, CreateCampaign } from '../../../packages/client-protocol/src/protocol.ts';
import { DEFAULT_LOCALE, errorText, safeLocale, say } from './messages.ts';
import { planResult, startOptions } from './quickstart.ts';

const TUI_CLIENT = 'tui';
const TEXT = 'utf8';
const KEYS: Readonly<Record<string, StartAction['kind']>> = { b: 'back', s: 'skip', y: 'start' };
const QUIT = 'q';
const FIRST_NUMBER = 1;
const LIST_STYLE = { type: 'conjunction' } as const;

const draftPath = (dataDir: string) => join(dataDir, START_DRAFT_FILE);

const saveDraft = (dataDir: string, draft: StartDraft) => {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(draftPath(dataDir), JSON.stringify(draft));
};

const asking = (screen: StartScreen) => {
  if (screen.step === 'summary') return screen.canStart ? 'start.askStart' : 'start.goBack';
  if (screen.step === 'begin') return 'start.change';
  if (screen.options.length > 0) return screen.canNext ? 'start.toggle' : 'start.choose';
  if (screen.entry !== undefined) return 'start.answer';
  return 'start.continue';
};

const controls = (screen: StartScreen, locale: string) => {
  const keys = [
    ...(screen.canNext && screen.options.length > 0 ? ['start.key.next'] : []),
    ...(screen.canBack ? ['start.key.back'] : []),
    ...(screen.canSkip ? ['start.key.skip'] : []),
    'start.key.quit',
  ].map((key) => say(locale, key));
  return say(locale, 'start.controls', { keys: new Intl.ListFormat(safeLocale(locale), LIST_STYLE).format(keys) });
};

const render = (screen: StartScreen, locale: string) =>
  [
    screen.progress === undefined
      ? screen.title
      : say(locale, 'start.step', { ...screen.progress, title: screen.title }),
    ...screen.text,
    ...(screen.importHint === undefined ? [] : [screen.importHint]),
    ...screen.options.flatMap(({ label, detail, selected, badge, group }, index) => [
      ...(group === undefined || group === screen.options[index - 1]?.group ? [] : [`${group}:`]),
      `  ${index + FIRST_NUMBER}. ${label}${badge === undefined ? '' : ` [${badge}]`}${selected ? ` (${say(locale, 'start.on')})` : ''} - ${detail}`,
    ]),
    ...(screen.entry === undefined ? [] : [`${screen.entry.label}: ${screen.entry.value}`]),
    ...(screen.error === undefined ? [] : [screen.error]),
    say(locale, asking(screen)),
    controls(screen, locale),
  ].join('\n');

const actionFor = (screen: StartScreen, text: string): StartAction | undefined => {
  const kind = KEYS[text];
  if (kind === 'back' && screen.canBack) return { kind };
  if (kind === 'skip' && screen.canSkip) return { kind };
  if (kind === 'start' && screen.canStart) return { kind };
  const option = /^\d+$/.test(text) ? screen.options[Number(text) - FIRST_NUMBER] : undefined;
  if (option !== undefined) return option.action;
  if (text === '' && screen.step !== 'summary') return screen.canNext ? { kind: 'next' } : undefined;
  return screen.entry === undefined ? undefined : { kind: 'enter', text };
};

export const guidedStart = async function* (
  dataDir: string,
  lines: AsyncIterable<string>,
  createCampaignFrom: (dataDir: string, command: CreateCampaign, client?: string) => Promise<CampaignSummary>,
  locale = DEFAULT_LOCALE,
): AsyncGenerator<string> {
  const options = startOptions();
  let draft = loadStartDraft(() => readFileSync(draftPath(dataDir), TEXT));
  const screenOf = () =>
    startScreen(
      draft,
      options,
      stepOf(draft) === 'summary' ? planResult(planCommand(draft, TUI_CLIENT), TUI_CLIENT, locale) : undefined,
      locale,
    );
  let screen = screenOf();
  yield render(screen, locale);
  for await (const line of lines) {
    const text = line.trim();
    if (text === QUIT) {
      yield say(locale, 'start.saved');
      return;
    }
    const action = actionFor(screen, text);
    if (action === undefined) {
      yield `${say(locale, 'choice.unknown')}\n${render(screen, locale)}`;
      continue;
    }
    if (action.kind === 'start') {
      try {
        const { name } = await createCampaignFrom(dataDir, createCommand(draft, TUI_CLIENT, locale), TUI_CLIENT);
        rmSync(draftPath(dataDir), { force: true });
        yield say(locale, 'start.created', { name, quoted: JSON.stringify(name) });
        return;
      } catch (error) {
        yield `${errorText(locale, error)}\n${render(screen, locale)}`;
        continue;
      }
    }
    draft = nextDraft(draft, action);
    saveDraft(dataDir, draft);
    screen = screenOf();
    yield render(screen, locale);
  }
};
