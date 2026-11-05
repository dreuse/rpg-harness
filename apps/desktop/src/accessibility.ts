import type { Result, ViewComponent } from '../../../packages/client-protocol/src/protocol.ts';
import { failure } from '../../../packages/client-protocol/src/view-registry.ts';
import {
  DEFAULT_PLAYBACK_SPEED,
  MAX_PLAYBACK_SPEED,
  MIN_PLAYBACK_SPEED,
} from '../../../packages/voice/src/playback.ts';
import {
  DEFAULT_VOICE_SETTINGS,
  type MicrophoneMode,
  type SpokenOutputMode,
  type VoiceConsent,
} from '../../../packages/voice/src/voice.ts';
import type { VoicePreferences } from '../../../packages/voice/src/voice-settings.ts';

export const MIN_FONT_SCALE = 0.75;
export const MAX_FONT_SCALE = 2;
export const DEFAULT_LOCALE = 'en';

export type SavedVoice = VoicePreferences & { readonly consent: VoiceConsent };

export type UiPreferences = {
  readonly fontScale: number;
  readonly locale: string;
  readonly reducedMotion: boolean;
  readonly keyboard: boolean;
  readonly voice: SavedVoice;
};

export const DEFAULT_PREFERENCES: UiPreferences = {
  fontScale: 1,
  locale: DEFAULT_LOCALE,
  reducedMotion: false,
  keyboard: true,
  voice: {
    microphone: DEFAULT_VOICE_SETTINGS.microphone,
    spokenOutput: DEFAULT_VOICE_SETTINGS.spokenOutput,
    locale: DEFAULT_LOCALE,
    speed: DEFAULT_PLAYBACK_SPEED,
    consent: DEFAULT_VOICE_SETTINGS.consent,
  },
};

const MICROPHONE_MODES: readonly unknown[] = ['off', 'push-to-talk', 'hands-free'] satisfies MicrophoneMode[];
const SPOKEN_OUTPUT_MODES: readonly unknown[] = ['off', 'narrator', 'dialogue', 'full'] satisfies SpokenOutputMode[];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const isConsent = (value: unknown): value is VoiceConsent =>
  isRecord(value) &&
  (value.granted === false ||
    (value.granted === true &&
      isText(value.grantedAt) &&
      Array.isArray(value.providerIds) &&
      value.providerIds.every(isText)));

const isSavedVoice = (value: unknown): value is SavedVoice =>
  isRecord(value) &&
  MICROPHONE_MODES.includes(value.microphone) &&
  SPOKEN_OUTPUT_MODES.includes(value.spokenOutput) &&
  isText(value.locale) &&
  typeof value.speed === 'number' &&
  value.speed >= MIN_PLAYBACK_SPEED &&
  value.speed <= MAX_PLAYBACK_SPEED &&
  isConsent(value.consent);

const clamp = (value: number) => Math.min(MAX_FONT_SCALE, Math.max(MIN_FONT_SCALE, value));

export const parsePreferences = (input: unknown): Result<UiPreferences> => {
  if (input === undefined) return { ok: true, value: DEFAULT_PREFERENCES };
  if (!isRecord(input)) return failure('MalformedCommand', 'preferences must be an object');
  const { fontScale, locale, reducedMotion, keyboard, voice: savedVoice } = { ...DEFAULT_PREFERENCES, ...input };
  const voice = isRecord(savedVoice) ? { ...DEFAULT_PREFERENCES.voice, ...savedVoice } : savedVoice;
  if (typeof fontScale !== 'number' || !Number.isFinite(fontScale))
    return failure('MalformedCommand', 'fontScale must be a finite number');
  if (typeof locale !== 'string' || locale.length === 0) return failure('MalformedCommand', 'locale must be text');
  if (typeof reducedMotion !== 'boolean') return failure('MalformedCommand', 'reducedMotion must be a flag');
  if (typeof keyboard !== 'boolean') return failure('MalformedCommand', 'keyboard must be a flag');
  if (!isSavedVoice(voice)) return failure('MalformedCommand', 'voice settings are invalid');
  const { microphone, spokenOutput, locale: voiceLocale, speed, consent } = voice;
  return {
    ok: true,
    value: {
      fontScale: clamp(fontScale),
      locale,
      reducedMotion,
      keyboard,
      voice: { microphone, spokenOutput, locale: voiceLocale, speed, consent },
    },
  };
};

export const loadPreferences = (read: () => string): UiPreferences => {
  try {
    const parsed = parsePreferences(JSON.parse(read()));
    return parsed.ok ? parsed.value : DEFAULT_PREFERENCES;
  } catch {
    return DEFAULT_PREFERENCES;
  }
};

export type RendererAction =
  | 'submit'
  | 'retry'
  | 'focusConversation'
  | 'focusSheet'
  | 'focusPanels'
  | 'nextCampaign'
  | 'newAdventure';

export const KEY_BINDINGS: Readonly<Record<string, RendererAction>> = {
  Enter: 'submit',
  F5: 'retry',
  'Alt+1': 'focusConversation',
  'Alt+2': 'focusSheet',
  'Alt+3': 'focusPanels',
  'Alt+ArrowDown': 'nextCampaign',
  'Alt+N': 'newAdventure',
};

export const actionForKey = (key: string, { keyboard }: UiPreferences): RendererAction | undefined =>
  keyboard && Object.hasOwn(KEY_BINDINGS, key) ? KEY_BINDINGS[key] : undefined;

const CATALOG: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  en: {
    'status.connecting': 'Connecting',
    'status.connected': 'Connected',
    'status.disconnected': 'Offline',
    'status.reconnecting': 'Reconnecting (attempt {attempts})',
    'diagnostics.summary': 'Connection details',
    'diagnostics.pid': 'Engine process',
    'diagnostics.gm': 'GM provider',
    'diagnostics.error': 'Last error',
    'diagnostics.attempts': 'Reconnect attempts',
    'title.none': 'No adventure selected',
    'nav.panes': 'Panes',
    'speaker.player': 'You',
    'speaker.gm': 'Narrator',
    'empty.campaigns': 'No adventures yet. Start a new adventure to play.',
    'empty.conversation': 'Your story starts here. Type what your character does, then press Send.',
    'empty.sheet': 'No character sheet yet.',
    'empty.panels': 'Nothing in your journal yet.',
    'label.yes': 'yes',
    'label.no': 'no',
    'label.noValue': 'no value',
    'label.progressOf': 'of',
    'region.campaigns': 'Campaigns',
    'region.conversation': 'Conversation',
    'region.sheet': 'Character sheet',
    'region.panels': 'Journal',
    'region.rejected': 'Rejected actions',
    'action.retry': 'Reconnect',
    'label.pending': 'pending',
    'region.voice': 'Voice',
    'voice.typedOnly': 'Voice off: type to play',
    'voice.mode': 'Microphone {microphone}, spoken output {spokenOutput}',
    'voice.fallback': 'Audio unavailable ({reason}); type instead',
    'voice.rejected': 'Voice settings not changed: {codes}',
    'voice.settings': 'Settings: microphone {microphone}, output {spokenOutput}, {locale}, {speed}x',
    'voice.consent': 'Allow microphone capture for this campaign?',
    'voice.allow': 'Allow microphone',
    'voice.decline': 'Keep typing',
    'region.start': 'New adventure',
    'start.open': 'New adventure',
    'start.created': 'Created campaign {name}.',
    'start.step': 'Step {current} of {total}: {title}',
    'start.save': 'Save',
    'start.back': 'Back',
    'start.skip': 'Skip',
    'start.next': 'Next',
    'start.start': 'Start',
    'start.close': 'Close',
    'home.search': 'Search adventures',
    'home.noMatch': 'No adventures match your search.',
    'home.continue': 'Continue',
    'home.continueLabel': 'Continue {name}',
    'home.archive': 'Archive',
    'home.archiveLabel': 'Archive {name}',
    'home.delete': 'Delete',
    'home.deleteLabel': 'Delete {name}',
    'home.unarchive': 'Restore',
    'home.unarchiveLabel': 'Restore {name}',
    'home.cancel': 'Cancel',
    'home.undo': 'Undo',
    'home.ask.archive': 'Archive {name}? You can undo this.',
    'home.ask.delete': 'Delete {name} for good? This cannot be undone.',
    'home.archivedNotice': 'Archived {name}.',
    'home.archived': 'Archived adventures ({count})',
    'home.problem.needs-migration': 'This save needs a newer version of the app.',
    'home.problem.unreadable': 'This save cannot be read.',
    'home.restoreHint': 'Restore it from a backup with rpg restore <file>.',
  },
  es: {
    'status.connecting': 'Conectando',
    'status.connected': 'Conectado',
    'status.disconnected': 'Sin conexión',
    'status.reconnecting': 'Reconectando (intento {attempts})',
    'diagnostics.summary': 'Detalles de conexión',
    'diagnostics.pid': 'Proceso del motor',
    'diagnostics.gm': 'Proveedor del GM',
    'diagnostics.error': 'Último error',
    'diagnostics.attempts': 'Intentos de reconexión',
    'title.none': 'Ninguna aventura seleccionada',
    'nav.panes': 'Paneles',
    'speaker.player': 'Tú',
    'speaker.gm': 'Narrador',
    'empty.campaigns': 'Aún no hay aventuras. Empieza una nueva aventura para jugar.',
    'empty.conversation': 'Tu historia empieza aquí. Escribe lo que hace tu personaje y pulsa Enviar.',
    'empty.sheet': 'Aún no hay ficha de personaje.',
    'empty.panels': 'Tu diario aún está vacío.',
    'label.yes': 'sí',
    'label.no': 'no',
    'label.noValue': 'sin valor',
    'label.progressOf': 'de',
    'region.campaigns': 'Campañas',
    'region.conversation': 'Conversación',
    'region.sheet': 'Ficha del personaje',
    'region.panels': 'Diario',
    'region.rejected': 'Acciones rechazadas',
    'action.retry': 'Reconectar',
    'label.pending': 'pendiente',
    'region.voice': 'Voz',
    'voice.typedOnly': 'Voz desactivada: escribe para jugar',
    'voice.mode': 'Micrófono {microphone}, voz hablada {spokenOutput}',
    'voice.fallback': 'Audio no disponible ({reason}); escribe en su lugar',
    'voice.rejected': 'Ajustes de voz sin cambios: {codes}',
    'voice.settings': 'Ajustes: micrófono {microphone}, salida {spokenOutput}, {locale}, {speed}x',
    'voice.consent': '¿Permitir la captura del micrófono en esta campaña?',
    'voice.allow': 'Permitir micrófono',
    'voice.decline': 'Seguir escribiendo',
    'region.start': 'Nueva aventura',
    'start.open': 'Nueva aventura',
    'start.created': 'Campaña {name} creada.',
    'start.step': 'Paso {current} de {total}: {title}',
    'start.save': 'Guardar',
    'start.back': 'Atrás',
    'start.skip': 'Omitir',
    'start.next': 'Siguiente',
    'start.start': 'Empezar',
    'start.close': 'Cerrar',
    'home.search': 'Buscar aventuras',
    'home.noMatch': 'Ninguna aventura coincide con tu búsqueda.',
    'home.continue': 'Continuar',
    'home.continueLabel': 'Continuar {name}',
    'home.archive': 'Archivar',
    'home.archiveLabel': 'Archivar {name}',
    'home.delete': 'Borrar',
    'home.deleteLabel': 'Borrar {name}',
    'home.unarchive': 'Recuperar',
    'home.unarchiveLabel': 'Recuperar {name}',
    'home.cancel': 'Cancelar',
    'home.undo': 'Deshacer',
    'home.ask.archive': '¿Archivar {name}? Puedes deshacerlo.',
    'home.ask.delete': '¿Borrar {name} para siempre? No se puede deshacer.',
    'home.archivedNotice': '{name} archivada.',
    'home.archived': 'Aventuras archivadas ({count})',
    'home.problem.needs-migration': 'Esta partida necesita una versión más nueva de la app.',
    'home.problem.unreadable': 'Esta partida no se puede leer.',
    'home.restoreHint': 'Recupérala de una copia con rpg restore <file>.',
  },
};

export const SUPPORTED_LOCALES: readonly string[] = Object.keys(CATALOG);

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
