import { loadStartDraft, type StartScreen } from '../../../packages/client-protocol/src/guided-start.ts';
import { actionForKey, loadPreferences, type RendererAction, translate, type UiPreferences } from './accessibility.ts';
import { PREFERENCES_QUERY, START_QUERY } from './preload.ts';
import type { Region, viewModel } from './renderer.ts';
import type { DesktopVoiceView } from './voice.ts';

export type ViewModel = ReturnType<typeof viewModel>;
export type KeyEventLike = {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly code?: string;
  readonly target?: unknown;
};
export type KeyTarget = {
  addEventListener(type: typeof KEYDOWN, listener: (event: KeyEventLike & { preventDefault(): void }) => void): void;
};

const KEYDOWN = 'keydown';
const KEY_SEPARATOR = '+';
const PHYSICAL_KEY = /^(?:Key|Digit)(.)$/;
const LABEL_SEPARATOR = ': ';
const MARKUP = /[&<>"']/g;
const ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const ISSUE_SEPARATOR = ', ';
const HEADING_ID = 'heading-';
const STATUS: Region = 'status';
const DEFAULT_PANE: Region = 'conversation';
const HOME_PANE: Region = 'campaigns';
export const PANE_ATTRIBUTE = 'data-pane';
const MODIFIERS = [
  ['ctrlKey', 'Ctrl'],
  ['altKey', 'Alt'],
  ['shiftKey', 'Shift'],
  ['metaKey', 'Meta'],
] as const;

export const escapeHtml = (text: string) => text.replace(MARKUP, (character) => ENTITIES[character] ?? character);

const list = (items: readonly string[]) => `<ul>${items.map((item) => `<li>${item}</li>`).join('')}</ul>`;
const button = (attribute: string, value: string, label: string, current = false) =>
  `<button type="button" ${attribute}="${escapeHtml(value)}"${current ? ' aria-current="true"' : ''}>${escapeHtml(label)}</button>`;

const empty = (locale: string, region: Region) =>
  `<p data-empty>${escapeHtml(translate(locale, `empty.${region}`))}</p>`;
const orEmpty = (items: readonly string[], locale: string, region: Region) =>
  items.length === 0 ? empty(locale, region) : list(items);
const speaker = (locale: string, who: 'player' | 'gm', text: string) =>
  `<p data-speaker="${who}"><span data-speaker-label>${escapeHtml(translate(locale, `speaker.${who}`))}</span>${escapeHtml(text)}</p>`;
const systemLine = (text: string) => `<p data-speaker="system">${escapeHtml(text)}</p>`;

const diagnostics = ({ diagnostics: { pid, gm, error, attempts } }: ViewModel, locale: string) =>
  `<details data-diagnostics><summary>${escapeHtml(translate(locale, 'diagnostics.summary'))}</summary><dl>${Object.entries(
    { pid, gm, error, attempts },
  )
    .filter(([, value]) => value !== undefined)
    .map(
      ([name, value]) =>
        `<dt>${escapeHtml(translate(locale, `diagnostics.${name}`))}</dt><dd>${escapeHtml(String(value))}</dd>`,
    )
    .join('')}</dl></details>`;

const header = ({ title }: ViewModel, locale: string) =>
  `<hgroup><h1 id="${HEADING_ID}status">${escapeHtml(title.campaign ?? translate(locale, 'title.none'))}</h1>${title.scene === undefined ? '' : `<p>${escapeHtml(title.scene)}</p>`}</hgroup>`;

export const HOME_ATTRIBUTE = 'data-home';
export const HOME_NAME = 'data-name';
export const HOME_SEARCH = 'home-search';
const HOME_FIELD_SEPARATOR = ' - ';

type HomeModel = ViewModel['home'];
type HomeCardModel = HomeModel['cards'][number];

const homeButton = (action: string, locale: string, { id, name }: { id: string; name?: string }) =>
  `<button type="button" id="${id}" ${HOME_ATTRIBUTE}="${action}"${name === undefined ? '' : ` ${HOME_NAME}="${escapeHtml(name)}" aria-label="${escapeHtml(translate(locale, `home.${action}Label`, { name }))}"`}>${escapeHtml(translate(locale, `home.${action}`))}</button>`;

const cardFields = (card: HomeCardModel) =>
  [card.characters, card.rules, card.scene, card.when].filter((field) => field !== undefined && field !== '');

const cardDetails = (card: HomeCardModel, locale: string) =>
  card.health === 'ok'
    ? `${cardFields(card).length === 0 ? '' : `<p>${escapeHtml(cardFields(card).join(HOME_FIELD_SEPARATOR))}</p>`}${card.narration === undefined ? '' : `<p data-narration>${escapeHtml(card.narration)}</p>`}`
    : `<p data-problem>${escapeHtml(`${translate(locale, `home.problem.${card.health}`)} ${translate(locale, 'home.restoreHint')}`)}</p>`;

const homeCard = (prefix: string, actions: readonly string[], locale: string) => (card: HomeCardModel, index: number) =>
  `<li><article aria-labelledby="${prefix}-${index}"${card.selected ? ' aria-current="true"' : ''}><h3 id="${prefix}-${index}">${escapeHtml(card.name)}</h3>${cardDetails(card, locale)}${actions
    .filter((action) => action !== 'continue' || card.playable)
    .map((action) =>
      homeButton(action, locale, {
        id: `home-${prefix === 'home-archived' && action === 'delete' ? 'archived-' : ''}${action}-${index}`,
        name: card.name,
      }),
    )
    .join('')}</article></li>`;

const homeNotices = ({ error, undo, confirm }: HomeModel, locale: string) =>
  [
    error === undefined ? '' : alert(error),
    undo === undefined
      ? ''
      : `<p role="status">${escapeHtml(translate(locale, 'home.archivedNotice', { name: undo }))} ${homeButton('undo', locale, { id: 'home-undo' })}</p>`,
    confirm === undefined
      ? ''
      : `<div role="alertdialog" aria-labelledby="home-confirm-text"><p id="home-confirm-text">${escapeHtml(translate(locale, `home.ask.${confirm.kind}`, { name: confirm.name }))}</p><button type="button" id="home-confirm" ${HOME_ATTRIBUTE}="confirm">${escapeHtml(translate(locale, `home.${confirm.kind}`))}</button>${homeButton('cancel', locale, { id: 'home-cancel' })}</div>`,
  ].join('');

const homeList = (home: HomeModel, locale: string) => {
  if (home.total === 0)
    return `${empty(locale, 'campaigns')}${button(START_OPEN, 'home', translate(locale, 'start.open'))}`;
  const search = home.search
    ? `<label for="${HOME_SEARCH}">${escapeHtml(translate(locale, 'home.search'))}</label><input id="${HOME_SEARCH}" type="search" value="${escapeHtml(home.query)}">`
    : '';
  const cards =
    home.cards.length === 0
      ? `<p data-empty>${escapeHtml(translate(locale, 'home.noMatch'))}</p>`
      : `<ul>${home.cards.map(homeCard('home-card', ['continue', 'archive', 'delete'], locale)).join('')}</ul>`;
  return search + cards;
};

const archivedList = ({ archived }: HomeModel, locale: string) =>
  archived.length === 0
    ? ''
    : `<details data-archived><summary>${escapeHtml(translate(locale, 'home.archived', { count: archived.length }))}</summary><ul>${archived.map(homeCard('home-archived', ['unarchive', 'delete'], locale)).join('')}</ul></details>`;

const REGION_BODIES: Readonly<Record<Region, (model: ViewModel, locale: string) => string>> = {
  campaigns: ({ home }, locale) => homeNotices(home, locale) + homeList(home, locale) + archivedList(home, locale),
  status: (model, locale) =>
    `${header(model, locale)}<p role="status" data-connection="${model.status.connection}">${escapeHtml(model.status.label)}</p>${model.status.canRetry ? button('data-action', 'retry', translate(locale, 'action.retry')) : ''}${diagnostics(model, locale)}`,
  conversation: ({ conversation }, locale) =>
    `<ol aria-live="polite">${conversation
      .map(
        ({ actionId, input, narration, pending }) =>
          `<li data-action-id="${escapeHtml(actionId)}"${pending ? ' aria-busy="true"' : ''}>${speaker(locale, 'player', input)}${pending ? systemLine(translate(locale, 'label.pending')) : speaker(locale, 'gm', narration)}</li>`,
      )
      .join('')}</ol>${conversation.length === 0 ? empty(locale, 'conversation') : ''}`,
  sheet: ({ sheetLabels }, locale) =>
    orEmpty(
      sheetLabels.map(({ label }) => escapeHtml(label)),
      locale,
      'sheet',
    ),
  panels: ({ panels }, locale) =>
    orEmpty(
      panels === undefined
        ? []
        : [
            ...panels.inventory.map(({ name }) => name),
            ...panels.quests.map(({ title }) => title),
            ...(panels.recap.scene === undefined ? [] : [panels.recap.scene]),
          ].map(escapeHtml),
      locale,
      'panels',
    ),
};

const section = (name: string, locale: string, body: string) =>
  `<section data-region="${name}" aria-label="${escapeHtml(translate(locale, `region.${name}`))}">${body}</section>`;

const pane = (region: Region, locale: string, body: string, hidden: boolean) =>
  `<section data-region="${region}" aria-labelledby="${HEADING_ID}${region}"${hidden ? ' hidden' : ''}>${region === STATUS ? '' : `<h2 id="${HEADING_ID}${region}">${escapeHtml(translate(locale, `region.${region}`))}</h2>`}${body}</section>`;

const rejectedAlert = ({ rejected }: ViewModel, locale: string) =>
  rejected.length === 0
    ? ''
    : section(
        'rejected',
        locale,
        `<ul role="alert">${rejected.map(({ input, message }) => `<li>${escapeHtml(input)}${LABEL_SEPARATOR}${escapeHtml(message)}</li>`).join('')}</ul>`,
      );

const alert = (text: string) => `<p role="alert">${escapeHtml(text)}</p>`;

export const VOICE_ATTRIBUTE = 'data-voice';
export const ALLOW = 'allow';
export const DECLINE = 'decline';

const consentPrompt = (locale: string) =>
  `<div role="alertdialog" aria-label="${escapeHtml(translate(locale, 'voice.consent'))}"><p>${escapeHtml(translate(locale, 'voice.consent'))}</p>${button(VOICE_ATTRIBUTE, ALLOW, translate(locale, 'voice.allow'))}${button(VOICE_ATTRIBUTE, DECLINE, translate(locale, 'voice.decline'))}</div>`;

export const renderVoice = (
  { mode, preferences, subtitle, fallback, issues, asking }: DesktopVoiceView,
  locale: string,
): string =>
  section(
    'voice',
    locale,
    [
      `<p>${escapeHtml(mode.kind === 'voice' ? translate(locale, 'voice.mode', mode) : translate(locale, 'voice.typedOnly'))}</p>`,
      `<p>${escapeHtml(translate(locale, 'voice.settings', preferences))}</p>`,
      asking ? consentPrompt(locale) : '',
      `<p aria-live="polite">${escapeHtml(subtitle?.text ?? '')}</p>`,
      fallback === undefined ? '' : alert(translate(locale, 'voice.fallback', { reason: fallback })),
      issues.length === 0 ? '' : alert(translate(locale, 'voice.rejected', { codes: issues.join(ISSUE_SEPARATOR) })),
    ].join(''),
  );

export const START_OPEN = 'data-start-open';
export const START_OPTION = 'data-start-option';
export const START_CONTROL = 'data-start-control';
export const START_FORM = 'data-start-form';
export const START_TITLE = 'data-start-title';
export const START_ENTRY = 'start-entry';
export const START_CONTROLS = ['back', 'skip', 'next', 'start', 'close'] as const;
export type StartControl = (typeof START_CONTROLS)[number];
const DETAIL_SEPARATOR = ' - ';

const startTitle = ({ title, progress }: StartScreen, locale: string) =>
  progress === undefined ? title : translate(locale, 'start.step', { ...progress, title });

const startOption =
  (step: StartScreen['step']) =>
  ({ label, detail, selected }: StartScreen['options'][number], index: number) =>
    `<li><button type="button" ${START_OPTION}="${index}"${step === 'path' ? '' : ` aria-pressed="${selected}"`}>${escapeHtml(label)}${DETAIL_SEPARATOR}${escapeHtml(detail)}</button></li>`;

const startEntry = ({ entry }: StartScreen, locale: string) =>
  entry === undefined
    ? ''
    : `<form ${START_FORM}="${START_ENTRY}"><label for="${START_ENTRY}">${escapeHtml(entry.label)}</label><input id="${START_ENTRY}" name="${START_ENTRY}" value="${escapeHtml(entry.value)}"><button type="submit">${escapeHtml(translate(locale, 'start.save'))}</button></form>`;

const shownControls = (screen: StartScreen): readonly StartControl[] =>
  START_CONTROLS.filter(
    (control) =>
      control === 'close' ||
      (control === 'back' && screen.canBack) ||
      (control === 'skip' && screen.canSkip) ||
      (control === 'next' && screen.canNext) ||
      (control === 'start' && screen.step === 'summary'),
  );

const startControl = (screen: StartScreen, locale: string) => (control: StartControl) =>
  `<button type="button" ${START_CONTROL}="${control}"${control === 'start' && !screen.canStart ? ' disabled' : ''}>${escapeHtml(translate(locale, `start.${control}`))}</button>`;

const renderStart = ({ start, created }: ViewModel, locale: string) =>
  section(
    'start',
    locale,
    start === undefined
      ? `${button(START_OPEN, 'open', translate(locale, 'start.open'))}${created === undefined ? '' : `<p role="status">${escapeHtml(translate(locale, 'start.created', { name: created }))}</p>`}`
      : [
          `<h2 tabindex="-1" ${START_TITLE}="${start.step}">${escapeHtml(startTitle(start, locale))}</h2>`,
          ...start.text.map((line) => `<p>${escapeHtml(line)}</p>`),
          start.options.length === 0 ? '' : `<ul>${start.options.map(startOption(start.step)).join('')}</ul>`,
          startEntry(start, locale),
          start.error === undefined ? '' : alert(start.error),
          shownControls(start).map(startControl(start, locale)).join(''),
        ].join(''),
  );

const paneSwitcher = (regions: readonly Region[], shown: Region, locale: string) =>
  `<nav aria-label="${escapeHtml(translate(locale, 'nav.panes'))}">${regions
    .filter((region) => region !== STATUS)
    .map((region) => button(PANE_ATTRIBUTE, region, translate(locale, `region.${region}`), region === shown))
    .join('')}</nav>`;

export const renderView = (
  model: ViewModel,
  locale: string,
  shown: Region = model.playing ? DEFAULT_PANE : HOME_PANE,
): string => {
  const [single, ...rest] = model.layout.columns;
  const tabbed = single !== undefined && rest.length === 0;
  return `<main data-layout="${model.layout.name}" data-animate="${model.animate}" style="--font-scale: ${model.fontScale}">${renderStart(model, locale)}${tabbed ? paneSwitcher(single, shown, locale) : ''}<div data-columns>${model.layout.columns
    .map(
      (column) =>
        `<div>${column.map((region) => pane(region, locale, REGION_BODIES[region](model, locale), tabbed && region !== STATUS && region !== shown)).join('')}</div>`,
    )
    .join('')}</div>${rejectedAlert(model, locale)}</main>`;
};

export const keyName = (event: KeyEventLike) =>
  [
    ...MODIFIERS.filter(([flag]) => event[flag]).map(([, name]) => name),
    PHYSICAL_KEY.exec(event.code ?? '')?.[1] ?? event.key,
  ].join(KEY_SEPARATOR);

export const KEEP_DEFAULT = Symbol('keep default');

export const bindKeys = (
  target: KeyTarget,
  preferences: () => UiPreferences,
  run: (action: RendererAction, event: KeyEventLike) => unknown,
) =>
  target.addEventListener(KEYDOWN, (event) => {
    const action = actionForKey(keyName(event), preferences());
    if (action === undefined) return;
    if (run(action, event) !== KEEP_DEFAULT) event.preventDefault();
  });

export const queryPreferences = (search: string) =>
  loadPreferences(() => new URLSearchParams(search).get(PREFERENCES_QUERY) ?? '');

export const queryStart = (search: string) => loadStartDraft(() => new URLSearchParams(search).get(START_QUERY) ?? '');
