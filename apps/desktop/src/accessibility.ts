import type { Result, ViewComponent } from '../../../packages/client-protocol/src/protocol.ts';
import { failure } from '../../../packages/client-protocol/src/view-registry.ts';
import { MOTION_SETTINGS, type MotionSetting } from '../../../packages/client-protocol/src/visualization.ts';
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
import { DEFAULT_SPEECH, isSpeechPreferences, type SpeechPreferences, withoutFlatNpcVoices } from './voice-setup.ts';

export const MIN_FONT_SCALE = 0.75;
export const MAX_FONT_SCALE = 2;
export const DEFAULT_LOCALE = 'en';

export type SavedVoice = VoicePreferences & { readonly consent: VoiceConsent };

export type UiPreferences = {
  readonly fontScale: number;
  readonly locale: string;
  readonly reducedMotion: boolean;
  readonly motion: MotionSetting;
  readonly keyboard: boolean;
  readonly voice: SavedVoice;
  readonly speech: SpeechPreferences;
};

export const DEFAULT_PREFERENCES: UiPreferences = {
  fontScale: 1,
  locale: DEFAULT_LOCALE,
  reducedMotion: false,
  motion: 'full',
  keyboard: true,
  voice: {
    microphone: DEFAULT_VOICE_SETTINGS.microphone,
    spokenOutput: DEFAULT_VOICE_SETTINGS.spokenOutput,
    locale: DEFAULT_LOCALE,
    speed: DEFAULT_PLAYBACK_SPEED,
    consent: DEFAULT_VOICE_SETTINGS.consent,
  },
  speech: DEFAULT_SPEECH,
};

const MICROPHONE_MODES: readonly unknown[] = ['off', 'push-to-talk', 'hands-free'] satisfies MicrophoneMode[];
const SPOKEN_OUTPUT_MODES: readonly unknown[] = [
  'off',
  'narrator',
  'dialogue',
  'full',
  'cinematic',
] satisfies SpokenOutputMode[];

const isMotion = (value: unknown): value is MotionSetting => MOTION_SETTINGS.some((setting) => setting === value);

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
  const {
    fontScale,
    locale,
    reducedMotion,
    motion,
    keyboard,
    voice: savedVoice,
    speech: savedSpeech,
  } = { ...DEFAULT_PREFERENCES, ...input };
  const speech = withoutFlatNpcVoices(savedSpeech);
  const voice = isRecord(savedVoice) ? { ...DEFAULT_PREFERENCES.voice, ...savedVoice } : savedVoice;
  if (typeof fontScale !== 'number' || !Number.isFinite(fontScale))
    return failure('MalformedCommand', 'fontScale must be a finite number');
  if (typeof locale !== 'string' || locale.length === 0) return failure('MalformedCommand', 'locale must be text');
  if (typeof reducedMotion !== 'boolean') return failure('MalformedCommand', 'reducedMotion must be a flag');
  if (!isMotion(motion)) return failure('MalformedCommand', 'motion must be full, reduced or off');
  if (typeof keyboard !== 'boolean') return failure('MalformedCommand', 'keyboard must be a flag');
  if (!isSavedVoice(voice)) return failure('MalformedCommand', 'voice settings are invalid');
  if (!isSpeechPreferences(speech)) return failure('MalformedCommand', 'speech settings are invalid');
  const { providerId, narratorVoice, volume, npcVoices } = speech;
  const { microphone, spokenOutput, locale: voiceLocale, speed, consent } = voice;
  return {
    ok: true,
    value: {
      fontScale: clamp(fontScale),
      locale,
      reducedMotion,
      motion,
      keyboard,
      voice: { microphone, spokenOutput, locale: voiceLocale, speed, consent },
      speech: {
        ...(providerId === undefined ? {} : { providerId }),
        ...(narratorVoice === undefined ? {} : { narratorVoice }),
        volume,
        npcVoices: Object.fromEntries(Object.entries(npcVoices).map(([id, voices]) => [id, { ...voices }])),
      },
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
  | 'newAdventure'
  | 'closeMenu';

export const KEY_BINDINGS: Readonly<Record<string, RendererAction>> = {
  Enter: 'submit',
  F5: 'retry',
  'Alt+1': 'focusConversation',
  'Alt+2': 'focusSheet',
  'Alt+3': 'focusPanels',
  'Alt+ArrowDown': 'nextCampaign',
  'Alt+N': 'newAdventure',
  Escape: 'closeMenu',
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
    'gm.claude-code': 'Claude Code on this computer',
    'gm.api': 'Claude with your API key',
    'gm.fake': 'Built-in narrator. Install Claude Code or set ANTHROPIC_API_KEY to play with an AI game master.',
    'app.name': 'RPG Harness',
    'nav.home': 'Home',
    'nav.homeLabel': 'Back to home',
    'settings.label': 'Settings',
    'gmModel.legend': 'GM model for this campaign',
    'gmModel.defaultsLegend': 'App default GM model',
    'gmModel.saveDefaults': 'Save app default',
    'gmModel.model': 'Model',
    'gmModel.summaryModel': 'Summary model',
    'gmModel.sessionBudgetTokens': 'Session token budget',
    'gmModel.save': 'Save GM settings',
    'gmModel.help': 'Leave a field empty to use the app default. The budget only warns, play never stops.',
    'gmModel.hint.default': 'usual model of your GM route',
    'gmModel.hint.cheap': 'cheaper and faster',
    'gmModel.hint.balanced': 'balanced cost and detail',
    'gmModel.hint.rich': 'richer narration, costs more',
    'gmModel.hint.custom': 'a model id sent as is',
    'nav.panes': 'Panes',
    'speaker.player': 'You',
    'speaker.gm': 'Narrator',
    'empty.campaigns': 'No adventures yet. Start a new adventure to play.',
    'empty.conversation': 'Your story starts here. Type what your character does, then press Send.',
    'empty.sheet': 'No character sheet yet.',
    'sheet.noStats': 'No stats tracked yet.',
    'sheet.save': 'Save',
    'sheet.edit': 'Edit sheet',
    'sheet.cancel': 'Cancel',
    'sheet.number': 'Enter a number.',
    'sheet.min': 'Enter {min} or more.',
    'sheet.max': 'Enter {max} or less.',
    'sheet.group.core': 'Core',
    'sheet.group.custom': 'Custom',
    'sheet.group.computed': 'Computed',
    'empty.panels': 'Nothing in your journal yet.',
    'label.yes': 'yes',
    'label.no': 'no',
    'label.noValue': 'no value',
    'label.progressOf': 'of',
    'region.campaigns': 'Your adventures',
    'region.conversation': 'Conversation',
    'region.sheet': 'Character sheet',
    'region.panels': 'Journal',
    'region.rejected': 'Rejected actions',
    'action.retry': 'Reconnect',
    'label.pending': 'pending',
    'label.no-reply': 'No reply was recorded for this turn.',
    'region.voice': 'Voice',
    'voice.off': 'Voice off',
    'voice.microphone.off': 'Microphone off',
    'voice.microphone.push-to-talk': 'Push to talk',
    'voice.microphone.hands-free': 'Hands-free microphone',
    'voice.output.off': 'Spoken output off',
    'voice.output.narrator': 'Narrator reads aloud',
    'voice.output.dialogue': 'Dialogue read aloud',
    'voice.output.full': 'Everything read aloud',
    'voice.output.cinematic': 'Everything read aloud with expression',
    'voice.speed.normal': 'normal speed',
    'voice.speed': '{speed}× speed',
    'voice.hint':
      "Type 'set mic to push-to-talk', 'set output to narrator', 'set output to cinematic' or 'set speed to 1.5' to change voice.",
    'voice.fallback': 'Audio unavailable ({reason}); type instead',
    'voice.rejected': 'Voice settings not changed: {codes}',
    'voice.consent': 'Allow microphone capture for this campaign?',
    'voice.allow': 'Allow microphone',
    'voice.decline': 'Keep typing',
    'voice.on': 'Turn voice on',
    'voice.turnOff': 'Turn voice off',
    'voice.mode': 'Spoken output',
    'voice.narrator': 'Narrator voice',
    'voice.preview': 'Preview',
    'voice.previewLabel': 'Preview the voice of {name}',
    'voice.language': 'Language',
    'voice.speedLabel': 'Speed',
    'voice.volume': 'Volume',
    'voice.advanced': 'Advanced voice settings',
    'voice.provider': 'Voice provider',
    'voice.npcs': 'Character voices',
    'voice.npcName': 'Character name',
    'voice.npcVoice': 'Character voice',
    'voice.npcAdd': 'Add character voice',
    'voice.npcRemove': 'Remove',
    'voice.npcRemoveLabel': 'Remove the voice of {name}',
    'voice.models': 'Installed voice models',
    'voice.noModels': 'No voice models installed.',
    'voice.size': '{size} MiB',
    'voice.remove': 'Remove',
    'voice.cache': 'Audio cache: {size} KiB',
    'voice.clear': 'Clear cache',
    'voice.diagnostics': 'Voice diagnostics',
    'voice.diagnostics.firstAudio': 'Time to first audio',
    'voice.diagnostics.cacheHits': 'Cache hit rate',
    'voice.diagnostics.errors': 'Errors',
    'voice.diagnostics.none': 'none',
    'voice.diagnostics.ms': '{value} ms',
    'voice.diagnostics.percent': '{value}%',
    'voice.stage.synthesis': 'Speech synthesis',
    'voice.stage.transfer': 'Transfer',
    'voice.stage.decode': 'Decoding',
    'voice.setup': 'Voice setup',
    'region.voice-setup': 'Voice setup',
    'voice.setup.checking': 'Checking voices on this computer…',
    'voice.setup.consent':
      'Use the {provider} voice on this computer? It needs a one-time download of {size} MiB from {source}.',
    'voice.setup.accept': 'Download and continue',
    'voice.setup.decline': 'Not now',
    'voice.setup.downloading': 'Downloading the voice model',
    'voice.setup.progress': '{done} of {total} MiB',
    'voice.setup.previewing': 'Playing the narrator…',
    'voice.setup.ready': 'Voice is on. You heard the narrator.',
    'voice.setup.again': 'Play again',
    'voice.setup.done': 'Done',
    'voice.setup.unavailable': 'No voice speaks this language on this computer yet. The story stays in text.',
    'voice.setup.failed': 'Voice could not start ({reason}). The story stays in text.',
    'voice.setup.retry': 'Try again',
    'region.start': 'New adventure',
    'start.open': 'New adventure',
    'start.first': 'Start your first adventure',
    'start.created': 'Created campaign {name}.',
    'start.step': 'Step {current} of {total}: {title}',
    'start.chosen': 'Chosen',
    'start.default': 'Default',
    'start.edit': 'Edit',
    'start.editLabel': 'Edit {label}',
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
    'home.more': 'More',
    'home.moreLabel': 'More actions for {name}',
    'home.cancel': 'Cancel',
    'home.undo': 'Undo',
    'home.ask.archive': 'Archive {name}? You can undo this.',
    'home.ask.delete': 'Delete {name} for good? This cannot be undone.',
    'home.archivedNotice': 'Archived {name}.',
    'home.archived': 'Archived adventures ({count})',
    'home.problem.needs-migration': 'This save needs a newer version of the app.',
    'home.problem.unreadable': 'This save cannot be read.',
    'home.restoreHint': 'Restore it from a backup with rpg restore <file>.',
    'region.rolls': 'Dice',
    'motion.label': 'Motion',
    'motion.full': 'Full',
    'motion.reduced': 'Reduced',
    'motion.off': 'Off',
    'roll.modifier': 'modifier {value}',
    'roll.total': 'total {value}',
    'roll.skip': 'Skip animation',
    'roll.history': 'Recent rolls',
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
    'gm.claude-code': 'Claude Code en este equipo',
    'gm.api': 'Claude con tu clave de API',
    'gm.fake': 'Narrador integrado. Instala Claude Code o define ANTHROPIC_API_KEY para jugar con un GM de IA.',
    'app.name': 'RPG Harness',
    'nav.home': 'Inicio',
    'nav.homeLabel': 'Volver al inicio',
    'settings.label': 'Ajustes',
    'gmModel.legend': 'Modelo del GM para esta campaña',
    'gmModel.defaultsLegend': 'Modelo del GM por defecto de la app',
    'gmModel.saveDefaults': 'Guardar valor por defecto',
    'gmModel.model': 'Modelo',
    'gmModel.summaryModel': 'Modelo de resumen',
    'gmModel.sessionBudgetTokens': 'Presupuesto de tokens por sesión',
    'gmModel.save': 'Guardar ajustes del GM',
    'gmModel.help':
      'Deja un campo vacío para usar el valor de la app. El presupuesto solo avisa, el juego nunca se detiene.',
    'gmModel.hint.default': 'modelo habitual de tu ruta de GM',
    'gmModel.hint.cheap': 'más barato y rápido',
    'gmModel.hint.balanced': 'equilibrio entre coste y detalle',
    'gmModel.hint.rich': 'narración más rica, cuesta más',
    'gmModel.hint.custom': 'un id de modelo enviado tal cual',
    'nav.panes': 'Paneles',
    'speaker.player': 'Tú',
    'speaker.gm': 'Narrador',
    'empty.campaigns': 'Aún no hay aventuras. Empieza una nueva aventura para jugar.',
    'empty.conversation': 'Tu historia empieza aquí. Escribe lo que hace tu personaje y pulsa Enviar.',
    'empty.sheet': 'Aún no hay ficha de personaje.',
    'sheet.noStats': 'Aún no hay estadísticas.',
    'sheet.save': 'Guardar',
    'sheet.edit': 'Editar hoja',
    'sheet.cancel': 'Cancelar',
    'sheet.number': 'Introduce un número.',
    'sheet.min': 'Introduce {min} o más.',
    'sheet.max': 'Introduce {max} o menos.',
    'sheet.group.core': 'Básico',
    'sheet.group.custom': 'Personalizado',
    'sheet.group.computed': 'Calculado',
    'empty.panels': 'Tu diario aún está vacío.',
    'label.yes': 'sí',
    'label.no': 'no',
    'label.noValue': 'sin valor',
    'label.progressOf': 'de',
    'region.campaigns': 'Tus aventuras',
    'region.conversation': 'Conversación',
    'region.sheet': 'Ficha del personaje',
    'region.panels': 'Diario',
    'region.rejected': 'Acciones rechazadas',
    'action.retry': 'Reconectar',
    'label.pending': 'pendiente',
    'label.no-reply': 'No se registró respuesta para este turno.',
    'region.voice': 'Voz',
    'voice.off': 'Voz desactivada',
    'voice.microphone.off': 'Micrófono apagado',
    'voice.microphone.push-to-talk': 'Pulsar para hablar',
    'voice.microphone.hands-free': 'Micrófono manos libres',
    'voice.output.off': 'Voz hablada apagada',
    'voice.output.narrator': 'El narrador lee en voz alta',
    'voice.output.dialogue': 'Diálogos en voz alta',
    'voice.output.full': 'Todo en voz alta',
    'voice.output.cinematic': 'Todo en voz alta con expresión',
    'voice.speed.normal': 'velocidad normal',
    'voice.speed': 'velocidad {speed}×',
    'voice.hint':
      "Escribe 'set mic to push-to-talk', 'set output to narrator', 'set output to cinematic' o 'set speed to 1.5' para cambiar la voz.",
    'voice.fallback': 'Audio no disponible ({reason}); escribe en su lugar',
    'voice.rejected': 'Ajustes de voz sin cambios: {codes}',
    'voice.consent': '¿Permitir la captura del micrófono en esta campaña?',
    'voice.allow': 'Permitir micrófono',
    'voice.decline': 'Seguir escribiendo',
    'region.start': 'Nueva aventura',
    'start.open': 'Nueva aventura',
    'start.first': 'Empieza tu primera aventura',
    'start.created': 'Campaña {name} creada.',
    'start.step': 'Paso {current} de {total}: {title}',
    'start.chosen': 'Elegido',
    'start.default': 'Predeterminado',
    'start.edit': 'Editar',
    'start.editLabel': 'Editar {label}',
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
    'home.more': 'Más',
    'home.moreLabel': 'Más acciones para {name}',
    'home.cancel': 'Cancelar',
    'home.undo': 'Deshacer',
    'home.ask.archive': '¿Archivar {name}? Puedes deshacerlo.',
    'home.ask.delete': '¿Borrar {name} para siempre? No se puede deshacer.',
    'home.archivedNotice': '{name} archivada.',
    'home.archived': 'Aventuras archivadas ({count})',
    'home.problem.needs-migration': 'Esta partida necesita una versión más nueva de la app.',
    'home.problem.unreadable': 'Esta partida no se puede leer.',
    'home.restoreHint': 'Recupérala de una copia con rpg restore <file>.',
    'region.rolls': 'Dados',
    'motion.label': 'Movimiento',
    'motion.full': 'Completo',
    'motion.reduced': 'Reducido',
    'motion.off': 'Desactivado',
    'roll.modifier': 'modificador {value}',
    'roll.total': 'total {value}',
    'roll.skip': 'Saltar animación',
    'roll.history': 'Tiradas recientes',
  },
};

export const SUPPORTED_LOCALES: readonly string[] = Object.keys(CATALOG);

const PLACEHOLDER = /\{(\w+)\}/g;

export const translate = (locale: string, key: string, params: Readonly<Record<string, unknown>> = {}): string =>
  (CATALOG[locale]?.[key] ?? CATALOG[DEFAULT_LOCALE]?.[key] ?? key).replace(PLACEHOLDER, (placeholder, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : placeholder,
  );

const VOICE_FIELD_SEPARATOR = ' · ';

const languageName = (locale: string, language: string) => {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(language) ?? language;
  } catch {
    return language;
  }
};

export const voiceLabel = (locale: string, { microphone, spokenOutput, locale: language, speed }: VoicePreferences) =>
  [
    ...(microphone === 'off' && spokenOutput === 'off'
      ? [translate(locale, 'voice.off')]
      : [translate(locale, `voice.microphone.${microphone}`), translate(locale, `voice.output.${spokenOutput}`)]),
    languageName(locale, language),
    speed === DEFAULT_PLAYBACK_SPEED
      ? translate(locale, 'voice.speed.normal')
      : translate(locale, 'voice.speed', { speed }),
  ].join(VOICE_FIELD_SEPARATOR);

const PROGRESS_RATIO = /^(\d+)\s*\/\s*(\d+)$/;
const LABEL_SEPARATOR = ': ';

const valueText = (value: ViewComponent['value'], locale: string): string => {
  if (value === undefined || value === null) return translate(locale, 'label.noValue');
  if (typeof value === 'boolean') return translate(locale, value ? 'label.yes' : 'label.no');
  return String(value);
};

export const componentValue = ({ kind, value }: ViewComponent, locale: string = DEFAULT_LOCALE): string => {
  const ratio = kind === 'progress' && typeof value === 'string' ? PROGRESS_RATIO.exec(value) : null;
  return ratio ? `${ratio[1]} ${translate(locale, 'label.progressOf')} ${ratio[2]}` : valueText(value, locale);
};

export const componentLabel = (component: ViewComponent, locale: string = DEFAULT_LOCALE): string =>
  `${component.label}${LABEL_SEPARATOR}${componentValue(component, locale)}`;
