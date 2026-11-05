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
import { planResult, startOptions } from './quickstart.ts';

const TUI_CLIENT = 'tui';
const TEXT = 'utf8';
const KEYS: Readonly<Record<string, StartAction['kind']>> = { b: 'back', s: 'skip', y: 'start' };
const QUIT = 'q';
const FIRST_NUMBER = 1;
const LIST = new Intl.ListFormat('en', { type: 'conjunction' });
const SAVED = 'Saved your progress. Run rpg start to pick up where you left off.';
const UNKNOWN_INPUT = 'Type one of the choices above.';

const draftPath = (dataDir: string) => join(dataDir, START_DRAFT_FILE);

const saveDraft = (dataDir: string, draft: StartDraft) => {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(draftPath(dataDir), JSON.stringify(draft));
};

const asking = (screen: StartScreen) => {
  if (screen.step === 'summary')
    return screen.canStart ? 'Type y to start, or type a new name.' : 'Go back and change your choices.';
  if (screen.options.length > 0)
    return screen.canNext ? 'Type a number to turn it on or off.' : 'Type a number to choose.';
  if (screen.entry !== undefined) return 'Type your answer.';
  return 'Press Enter to go on.';
};

const controls = (screen: StartScreen) => {
  const keys = [
    ...(screen.canNext && screen.options.length > 0 ? ['Enter to go on'] : []),
    ...(screen.canBack ? ['b to go back'] : []),
    ...(screen.canSkip ? ['s to skip'] : []),
    'q to stop and come back later',
  ];
  return `Type ${LIST.format(keys)}.`;
};

const render = (screen: StartScreen) =>
  [
    screen.progress === undefined
      ? screen.title
      : `Step ${screen.progress.current} of ${screen.progress.total}: ${screen.title}`,
    ...screen.text,
    ...screen.options.map(
      ({ label, detail, selected }, index) =>
        `  ${index + FIRST_NUMBER}. ${label}${selected ? ' (on)' : ''} - ${detail}`,
    ),
    ...(screen.entry === undefined ? [] : [`${screen.entry.label}: ${screen.entry.value}`]),
    ...(screen.error === undefined ? [] : [screen.error]),
    asking(screen),
    controls(screen),
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
  createCampaignFrom: (dataDir: string, command: CreateCampaign) => CampaignSummary,
): AsyncGenerator<string> {
  const options = startOptions();
  let draft = loadStartDraft(() => readFileSync(draftPath(dataDir), TEXT));
  const screenOf = () =>
    startScreen(draft, options, stepOf(draft) === 'summary' ? planResult(planCommand(draft, TUI_CLIENT)) : undefined);
  let screen = screenOf();
  yield render(screen);
  for await (const line of lines) {
    const text = line.trim();
    if (text === QUIT) {
      yield SAVED;
      return;
    }
    const action = actionFor(screen, text);
    if (action === undefined) {
      yield `${UNKNOWN_INPUT}\n${render(screen)}`;
      continue;
    }
    if (action.kind === 'start') {
      try {
        const { name } = createCampaignFrom(dataDir, createCommand(draft, TUI_CLIENT));
        rmSync(draftPath(dataDir), { force: true });
        yield `Created campaign ${name}. Run rpg play ${JSON.stringify(name)} to begin.`;
        return;
      } catch (error) {
        yield `${error instanceof Error ? error.message : String(error)}\n${render(screen)}`;
        continue;
      }
    }
    draft = nextDraft(draft, action);
    saveDraft(dataDir, draft);
    screen = screenOf();
    yield render(screen);
  }
};
