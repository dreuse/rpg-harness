import { loadStartDraft, type StartScreen } from '../../../packages/client-protocol/src/guided-start.ts';
import { MOTION_SETTINGS } from '../../../packages/client-protocol/src/visualization.ts';
import {
  actionForKey,
  loadPreferences,
  type RendererAction,
  translate,
  type UiPreferences,
  voiceLabel,
} from './accessibility.ts';
import { renderRoll, rollSummary } from './dice.ts';
import { PREFERENCES_QUERY, START_QUERY } from './preload.ts';
import { OPENING_ACTION_ID, type Region, type viewModel } from './renderer.ts';
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
export const PANE_ATTRIBUTE = 'data-pane';
const MODIFIERS = [
  ['ctrlKey', 'Ctrl'],
  ['altKey', 'Alt'],
  ['shiftKey', 'Shift'],
  ['metaKey', 'Meta'],
] as const;

export const escapeHtml = (text: string) => text.replace(MARKUP, (character) => ENTITIES[character] ?? character);

const list = (items: readonly string[]) => `<ul>${items.map((item) => `<li>${item}</li>`).join('')}</ul>`;
const PRIMARY = ' data-primary';
const button = (attribute: string, value: string, label: string, current = false, primary = false) =>
  `<button type="button" ${attribute}="${escapeHtml(value)}"${current ? ' aria-current="true"' : ''}${primary ? PRIMARY : ''}>${escapeHtml(label)}</button>`;

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

const pageHeading = (text: string) => `<h1 id="${HEADING_ID}${STATUS}" tabindex="-1">${escapeHtml(text)}</h1>`;

const header = ({ title }: ViewModel, locale: string) =>
  `<hgroup>${pageHeading(title.campaign ?? translate(locale, 'app.name'))}${title.scene === undefined ? '' : `<p>${escapeHtml(title.scene)}</p>`}</hgroup>`;

const connection = (model: ViewModel, locale: string) =>
  `<p role="status" data-connection="${model.status.connection}">${escapeHtml(model.status.label)}</p>${model.status.canRetry ? button('data-action', 'retry', translate(locale, 'action.retry')) : ''}${diagnostics(model, locale)}`;

export const NAV_ATTRIBUTE = 'data-nav';
const homeNav = (locale: string) =>
  `<button type="button" id="nav-home" ${NAV_ATTRIBUTE}="home" aria-label="${escapeHtml(translate(locale, 'nav.homeLabel'))}">${escapeHtml(translate(locale, 'nav.home'))}</button>`;

const voiceSettings = (voice: DesktopVoiceView | undefined, locale: string) =>
  voice === undefined
    ? ''
    : `<p data-voice-summary>${escapeHtml(voiceLabel(locale, voice.preferences))}</p><p>${escapeHtml(translate(locale, 'voice.hint'))}</p>`;

const settingsMenu = (model: ViewModel, locale: string, voice: DesktopVoiceView | undefined) =>
  `<details data-settings><summary id="settings-toggle">${escapeHtml(translate(locale, 'settings.label'))}</summary><div>${motionControl(model.motion, locale)}${voiceSettings(voice, locale)}</div></details>`;

export const HOME_ATTRIBUTE = 'data-home';
export const HOME_NAME = 'data-name';
export const HOME_SEARCH = 'home-search';
const HOME_FIELD_SEPARATOR = ' · ';

type HomeModel = ViewModel['home'];
type HomeCardModel = HomeModel['cards'][number];

const homeButton = (
  action: string,
  locale: string,
  { id, name, primary = false }: { id: string; name?: string; primary?: boolean },
) =>
  `<button type="button" id="${id}" ${HOME_ATTRIBUTE}="${action}"${name === undefined ? '' : ` ${HOME_NAME}="${escapeHtml(name)}" aria-label="${escapeHtml(translate(locale, `home.${action}Label`, { name }))}"`}${primary ? PRIMARY : ''}>${escapeHtml(translate(locale, `home.${action}`))}</button>`;

const cardFields = (card: HomeCardModel) =>
  [card.characters, card.scene, card.when].filter((field) => field !== undefined && field !== '');

const cardDetails = (card: HomeCardModel, locale: string) =>
  card.health === 'ok'
    ? `${cardFields(card).length === 0 ? '' : `<p data-meta>${escapeHtml(cardFields(card).join(HOME_FIELD_SEPARATOR))}</p>`}${card.narration === undefined ? '' : `<p data-narration>${escapeHtml(card.narration)}</p>`}`
    : `<p data-problem>${escapeHtml(`${translate(locale, `home.problem.${card.health}`)} ${translate(locale, 'home.restoreHint')}`)}</p>`;

type CardActions = { readonly prefix: string; readonly primary: string; readonly menu: readonly string[] };
const ACTIVE_CARD: CardActions = { prefix: 'home-card', primary: 'continue', menu: ['archive', 'delete'] };
const ARCHIVED_CARD: CardActions = { prefix: 'home-archived', primary: 'unarchive', menu: ['delete'] };

export const homeActionId = (action: string, index: number, archived: boolean) =>
  `home-${archived ? 'archived-' : ''}${action}-${index}`;

const cardMenu = ({ prefix, menu }: CardActions, card: HomeCardModel, index: number, locale: string) => {
  const idOf = (action: string) => homeActionId(action, index, prefix === ARCHIVED_CARD.prefix);
  return `<details data-menu><summary id="${idOf('more')}" aria-label="${escapeHtml(translate(locale, 'home.moreLabel', { name: card.name }))}">${escapeHtml(translate(locale, 'home.more'))}</summary><div>${menu
    .map((action) => homeButton(action, locale, { id: idOf(action), name: card.name }))
    .join('')}</div></details>`;
};

const homeCard = (actions: CardActions, locale: string) => (card: HomeCardModel, index: number) =>
  `<li><article aria-labelledby="${actions.prefix}-${index}"${card.selected ? ' aria-current="true"' : ''}><h3 id="${actions.prefix}-${index}">${escapeHtml(card.name)}</h3>${cardDetails(card, locale)}<div data-actions>${
    actions.primary === 'continue' && !card.playable
      ? ''
      : homeButton(actions.primary, locale, { id: `home-${actions.primary}-${index}`, name: card.name, primary: true })
  }${cardMenu(actions, card, index, locale)}</div></article></li>`;

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
    return `${empty(locale, 'campaigns')}${button(START_OPEN, 'home', translate(locale, 'start.first'), false, true)}`;
  const search = home.search
    ? `<label for="${HOME_SEARCH}">${escapeHtml(translate(locale, 'home.search'))}</label><input id="${HOME_SEARCH}" type="search" value="${escapeHtml(home.query)}">`
    : '';
  const cards =
    home.cards.length === 0
      ? `<p data-empty>${escapeHtml(translate(locale, 'home.noMatch'))}</p>`
      : `<ul>${home.cards.map(homeCard(ACTIVE_CARD, locale)).join('')}</ul>`;
  return search + cards;
};

const archivedList = ({ archived }: HomeModel, locale: string) =>
  archived.length === 0
    ? ''
    : `<details data-archived><summary>${escapeHtml(translate(locale, 'home.archived', { count: archived.length }))}</summary><ul>${archived.map(homeCard(ARCHIVED_CARD, locale)).join('')}</ul></details>`;

const rollHistory = (older: ViewModel['rolls'], locale: string) =>
  older.length === 0
    ? ''
    : `<details data-roll-history><summary>${escapeHtml(translate(locale, 'roll.history'))}</summary><ol>${older.map((plan) => `<li>${escapeHtml(rollSummary(plan, locale))}</li>`).join('')}</ol></details>`;

const rollTray = ({ rolls: [latest, ...older] }: ViewModel, locale: string) =>
  latest === undefined
    ? ''
    : `<section data-rolls aria-label="${escapeHtml(translate(locale, 'region.rolls'))}">${renderRoll(latest, locale)}${rollHistory(older, locale)}</section>`;

const REGION_BODIES: Readonly<Record<Region, (model: ViewModel, locale: string) => string>> = {
  campaigns: ({ home }, locale) => homeNotices(home, locale) + homeList(home, locale) + archivedList(home, locale),
  status: (model, locale) => `${pageHeading(translate(locale, 'app.name'))}${connection(model, locale)}`,
  conversation: (model, locale) =>
    `<ol aria-live="polite">${model.conversation
      .map(
        ({ actionId, input, narration, pending }) =>
          `<li data-action-id="${escapeHtml(actionId)}"${pending ? ' aria-busy="true"' : ''}>${actionId === OPENING_ACTION_ID ? '' : speaker(locale, 'player', input)}${pending ? systemLine(translate(locale, 'label.pending')) : speaker(locale, 'gm', narration)}</li>`,
      )
      .join('')}</ol>${model.conversation.length === 0 ? empty(locale, 'conversation') : ''}${rollTray(model, locale)}`,
  sheet: ({ sheetLabels, character }, locale) => {
    const name = character === undefined ? '' : `<h3>${escapeHtml(character)}</h3>`;
    if (sheetLabels.length > 0)
      return `${name}<ul>${sheetLabels.map(({ label, changed }) => `<li${changed ? ' data-changed' : ''}>${escapeHtml(label)}</li>`).join('')}</ul>`;
    return character === undefined
      ? empty(locale, 'sheet')
      : `${name}<p data-empty>${escapeHtml(translate(locale, 'sheet.noStats'))}</p>`;
  },
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

const voiceOff = ({ microphone, spokenOutput }: DesktopVoiceView['preferences']) =>
  microphone === 'off' && spokenOutput === 'off';

export const renderVoice = (
  { preferences, subtitle, fallback, issues, asking }: DesktopVoiceView,
  locale: string,
): string =>
  voiceOff(preferences) && !asking && !subtitle?.text && fallback === undefined && issues.length === 0
    ? ''
    : section(
        'voice',
        locale,
        [
          voiceOff(preferences) ? '' : `<p>${escapeHtml(voiceLabel(locale, preferences))}</p>`,
          asking ? consentPrompt(locale) : '',
          `<p aria-live="polite">${escapeHtml(subtitle?.text ?? '')}</p>`,
          fallback === undefined ? '' : alert(translate(locale, 'voice.fallback', { reason: fallback })),
          issues.length === 0
            ? ''
            : alert(translate(locale, 'voice.rejected', { codes: issues.join(ISSUE_SEPARATOR) })),
        ].join(''),
      );

export const START_OPEN = 'data-start-open';
export const START_OPTION = 'data-start-option';
export const START_CONTROL = 'data-start-control';
export const START_FORM = 'data-start-form';
export const START_TITLE = 'data-start-title';
export const START_ENTRY = 'start-entry';
export const START_SAVE = 'start-save';
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
    : `<form ${START_FORM}="${START_ENTRY}"><label for="${START_ENTRY}">${escapeHtml(entry.label)}</label><input id="${START_ENTRY}" name="${START_ENTRY}" value="${escapeHtml(entry.value)}"><button type="submit" id="${START_SAVE}">${escapeHtml(translate(locale, 'start.save'))}</button></form>`;

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

const startBody = ({ start, created, playing, home }: ViewModel, locale: string) =>
  start === undefined
    ? `${playing || home.total === 0 ? '' : button(START_OPEN, 'open', translate(locale, 'start.open'), false, true)}${created === undefined ? '' : `<p role="status">${escapeHtml(translate(locale, 'start.created', { name: created }))}</p>`}`
    : [
        `<h2 tabindex="-1" ${START_TITLE}="${start.step}">${escapeHtml(startTitle(start, locale))}</h2>`,
        ...start.text.map((line) => `<p>${escapeHtml(line)}</p>`),
        start.options.length === 0 ? '' : `<ul>${start.options.map(startOption(start.step)).join('')}</ul>`,
        startEntry(start, locale),
        start.error === undefined ? '' : alert(start.error),
        shownControls(start).map(startControl(start, locale)).join(''),
      ].join('');

const renderStart = (model: ViewModel, locale: string) => {
  const body = startBody(model, locale);
  return body === '' ? '' : section('start', locale, body);
};

const paneSwitcher = (regions: readonly Region[], shown: Region, locale: string) =>
  `<nav aria-label="${escapeHtml(translate(locale, 'nav.panes'))}">${regions
    .map((region) => button(PANE_ATTRIBUTE, region, translate(locale, `region.${region}`), region === shown))
    .join('')}</nav>`;

const motionControl = (current: string, locale: string): string =>
  `<fieldset data-motion-control><legend>${escapeHtml(translate(locale, 'motion.label'))}</legend>${MOTION_SETTINGS.map(
    (setting) =>
      `<button type="button" data-motion="${setting}" aria-pressed="${setting === current}">${escapeHtml(translate(locale, `motion.${setting}`))}</button>`,
  ).join('')}</fieldset>`;

const mainOpen = (model: ViewModel, screen: 'home' | 'play') =>
  `<main data-screen="${screen}" data-layout="${model.layout.name}" data-animate="${model.animate}" style="--font-scale: ${model.fontScale}">`;

const renderHome = (model: ViewModel, locale: string) =>
  `${mainOpen(model, 'home')}${pane(STATUS, locale, REGION_BODIES.status(model, locale), false)}${renderStart(model, locale)}${pane('campaigns', locale, REGION_BODIES.campaigns(model, locale), false)}</main>`;

const playHeader = (model: ViewModel, locale: string, voice: DesktopVoiceView | undefined) =>
  pane(
    STATUS,
    locale,
    `${homeNav(locale)}${header(model, locale)}${connection(model, locale)}${settingsMenu(model, locale, voice)}`,
    false,
  );

const renderPlay = (model: ViewModel, locale: string, shown: Region, voice: DesktopVoiceView | undefined) => {
  const [single, ...rest] = model.layout.columns;
  const tabbed = single !== undefined && rest.length === 0;
  return `${mainOpen(model, 'play')}${playHeader(model, locale, voice)}${renderStart(model, locale)}${tabbed ? paneSwitcher(single, shown, locale) : ''}<div data-columns>${model.layout.columns
    .map(
      (column) =>
        `<div>${column.map((region) => pane(region, locale, REGION_BODIES[region](model, locale), tabbed && region !== shown)).join('')}</div>`,
    )
    .join('')}</div>${rejectedAlert(model, locale)}</main>`;
};

export const renderView = (
  model: ViewModel,
  locale: string,
  shown: Region = DEFAULT_PANE,
  voice?: DesktopVoiceView,
): string =>
  `${model.playing ? renderPlay(model, locale, shown, voice) : renderHome(model, locale)}${voice === undefined ? '' : renderVoice(voice, locale)}`;

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
