import { actionForKey, loadPreferences, type RendererAction, translate, type UiPreferences } from './accessibility.ts';
import { PREFERENCES_QUERY } from './preload.ts';
import type { Region, viewModel } from './renderer.ts';

export type ViewModel = ReturnType<typeof viewModel>;
export type KeyEventLike = {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
};
export type KeyTarget = {
  addEventListener(type: typeof KEYDOWN, listener: (event: KeyEventLike & { preventDefault(): void }) => void): void;
};

const KEYDOWN = 'keydown';
const KEY_SEPARATOR = '+';
const LABEL_SEPARATOR = ': ';
const MARKUP = /[&<>"']/g;
const ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
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

const REGIONS: Readonly<Record<Region, (model: ViewModel, locale: string) => string>> = {
  campaigns: ({ campaigns }) =>
    list(campaigns.map(({ id, name, selected }) => button('data-campaign', id, name, selected))),
  status: ({ status }, locale) =>
    `<p role="status">${escapeHtml(status.label)}</p>${status.canRetry ? button('data-action', 'retry', translate(locale, 'action.retry')) : ''}`,
  conversation: ({ conversation }, locale) =>
    `<ol aria-live="polite">${conversation
      .map(
        ({ actionId, input, narration, pending }) =>
          `<li data-action-id="${escapeHtml(actionId)}"${pending ? ' aria-busy="true"' : ''}><p>${escapeHtml(input)}</p><p>${escapeHtml(pending ? translate(locale, 'label.pending') : narration)}</p></li>`,
      )
      .join('')}</ol>`,
  sheet: ({ sheetLabels }) => list(sheetLabels.map(({ label }) => escapeHtml(label))),
  panels: ({ panels }) =>
    panels === undefined
      ? ''
      : list(
          [
            ...panels.inventory.map(({ name }) => name),
            ...panels.quests.map(({ title }) => title),
            ...(panels.recap.scene === undefined ? [] : [panels.recap.scene]),
          ].map(escapeHtml),
        ),
};

const section = (name: string, locale: string, body: string) =>
  `<section data-region="${name}" aria-label="${escapeHtml(translate(locale, `region.${name}`))}">${body}</section>`;

const rejectedAlert = ({ rejected }: ViewModel, locale: string) =>
  rejected.length === 0
    ? ''
    : section(
        'rejected',
        locale,
        `<ul role="alert">${rejected.map(({ input, message }) => `<li>${escapeHtml(input)}${LABEL_SEPARATOR}${escapeHtml(message)}</li>`).join('')}</ul>`,
      );

export const renderView = (model: ViewModel, locale: string): string =>
  `<main data-layout="${model.layout.name}" data-animate="${model.animate}" style="--font-scale: ${model.fontScale}">${model.layout.columns
    .map(
      (column) =>
        `<div>${column.map((region) => section(region, locale, REGIONS[region](model, locale))).join('')}</div>`,
    )
    .join('')}${rejectedAlert(model, locale)}</main>`;

export const keyName = (event: KeyEventLike) =>
  [...MODIFIERS.filter(([flag]) => event[flag]).map(([, name]) => name), event.key].join(KEY_SEPARATOR);

export const bindKeys = (target: KeyTarget, preferences: () => UiPreferences, run: (action: RendererAction) => void) =>
  target.addEventListener(KEYDOWN, (event) => {
    const action = actionForKey(keyName(event), preferences());
    if (action === undefined) return;
    event.preventDefault();
    run(action);
  });

export const queryPreferences = (search: string) =>
  loadPreferences(() => new URLSearchParams(search).get(PREFERENCES_QUERY) ?? '');
