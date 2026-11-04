import type { Result, ViewComponent } from '../../../packages/client-protocol/src/protocol.ts';
import { failure } from '../../../packages/client-protocol/src/view-registry.ts';

export const MIN_FONT_SCALE = 0.75;
export const MAX_FONT_SCALE = 2;
export const DEFAULT_LOCALE = 'en';

export type UiPreferences = {
  readonly fontScale: number;
  readonly locale: string;
  readonly reducedMotion: boolean;
  readonly keyboard: boolean;
};

export const DEFAULT_PREFERENCES: UiPreferences = {
  fontScale: 1,
  locale: DEFAULT_LOCALE,
  reducedMotion: false,
  keyboard: true,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const clamp = (value: number) => Math.min(MAX_FONT_SCALE, Math.max(MIN_FONT_SCALE, value));

export const parsePreferences = (input: unknown): Result<UiPreferences> => {
  if (input === undefined) return { ok: true, value: DEFAULT_PREFERENCES };
  if (!isRecord(input)) return failure('MalformedCommand', 'preferences must be an object');
  const { fontScale, locale, reducedMotion, keyboard } = { ...DEFAULT_PREFERENCES, ...input };
  if (typeof fontScale !== 'number' || !Number.isFinite(fontScale))
    return failure('MalformedCommand', 'fontScale must be a finite number');
  if (typeof locale !== 'string' || locale.length === 0) return failure('MalformedCommand', 'locale must be text');
  if (typeof reducedMotion !== 'boolean') return failure('MalformedCommand', 'reducedMotion must be a flag');
  if (typeof keyboard !== 'boolean') return failure('MalformedCommand', 'keyboard must be a flag');
  return { ok: true, value: { fontScale: clamp(fontScale), locale, reducedMotion, keyboard } };
};

export type RendererAction = 'submit' | 'retry' | 'focusConversation' | 'focusSheet' | 'focusPanels' | 'nextCampaign';

export const KEY_BINDINGS: Readonly<Record<string, RendererAction>> = {
  Enter: 'submit',
  F5: 'retry',
  'Alt+1': 'focusConversation',
  'Alt+2': 'focusSheet',
  'Alt+3': 'focusPanels',
  'Alt+ArrowDown': 'nextCampaign',
};

export const actionForKey = (key: string, { keyboard }: UiPreferences): RendererAction | undefined =>
  keyboard && Object.hasOwn(KEY_BINDINGS, key) ? KEY_BINDINGS[key] : undefined;

const CATALOG: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  en: {
    'status.connecting': 'Connecting to engine',
    'status.connected': 'Connected to engine {pid} ({gm} GM)',
    'status.disconnected': 'Engine offline: {error}',
    'status.reconnecting': 'Reconnecting to engine (attempt {attempts})',
    'label.yes': 'yes',
    'label.no': 'no',
    'label.noValue': 'no value',
    'label.progressOf': 'of',
  },
  es: {
    'status.connecting': 'Conectando con el motor',
    'status.connected': 'Conectado al motor {pid} (GM {gm})',
    'status.disconnected': 'Motor sin conexión: {error}',
    'status.reconnecting': 'Reconectando con el motor (intento {attempts})',
    'label.yes': 'sí',
    'label.no': 'no',
    'label.noValue': 'sin valor',
    'label.progressOf': 'de',
  },
};

const PLACEHOLDER = /\{(\w+)\}/g;

export const translate = (locale: string, key: string, params: Readonly<Record<string, unknown>> = {}): string =>
  (CATALOG[locale]?.[key] ?? CATALOG[DEFAULT_LOCALE]?.[key] ?? key).replace(PLACEHOLDER, (placeholder, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : placeholder,
  );

const PROGRESS_RATIO = /^(\d+)\s*\/\s*(\d+)$/;
const LABEL_SEPARATOR = ': ';

const valueText = (value: ViewComponent['value'], locale: string): string => {
  if (value === undefined || value === null) return translate(locale, 'label.noValue');
  if (typeof value === 'boolean') return translate(locale, value ? 'label.yes' : 'label.no');
  return String(value);
};

export const componentLabel = ({ kind, label, value }: ViewComponent, locale: string = DEFAULT_LOCALE): string => {
  const ratio = kind === 'progress' && typeof value === 'string' ? PROGRESS_RATIO.exec(value) : null;
  const text = ratio ? `${ratio[1]} ${translate(locale, 'label.progressOf')} ${ratio[2]}` : valueText(value, locale);
  return `${label}${LABEL_SEPARATOR}${text}`;
};
