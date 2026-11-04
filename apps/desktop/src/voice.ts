import type { Result, SavedVoiceSettings, SubmitPlayerAction } from '../../../packages/client-protocol/src/protocol.ts';
import type { AudioFailure, TurnTranscription } from '../../../packages/voice/src/fallback.ts';
import type {
  MicrophoneController,
  MicrophoneSource,
  TypedFallbackReason,
} from '../../../packages/voice/src/microphone.ts';
import type { SttFallbackReason } from '../../../packages/voice/src/stt.ts';
import type { SubtitleTranscript } from '../../../packages/voice/src/subtitles.ts';
import {
  DEFAULT_VOICE_SETTINGS,
  resolveVoiceMode,
  type VoiceConsent,
  type VoiceSettings,
} from '../../../packages/voice/src/voice.ts';
import {
  type RequestSource,
  routeVoiceInput,
  type VoiceInputRoute,
  type VoiceSession,
  type VoiceSettingsIssueCode,
} from '../../../packages/voice/src/voice-settings.ts';

type Microphone = Pick<MicrophoneController, 'start' | 'stop'>;
type Route = VoiceInputRoute<Result<SubmitPlayerAction>>;

export type VoiceFallback = TypedFallbackReason | SttFallbackReason | AudioFailure;

export type DesktopVoiceOptions = {
  readonly session: VoiceSession;
  readonly consentGrantedAt?: string;
  readonly providerIds: readonly string[];
  readonly supportedLocales: readonly string[];
  readonly subtitles: Pick<SubtitleTranscript, 'current'>;
  readonly openMicrophone: (settings: VoiceSettings) => Microphone;
  readonly submit: (input: string) => Result<SubmitPlayerAction>;
  readonly save: (settings: SavedVoiceSettings) => void;
};

const TYPED: RequestSource = 'typed';
const SPOKEN: RequestSource = 'spoken';
const MICROPHONE = 'microphone';
const SEGMENT_GAP = ' ';
const AUDIO_INPUT = 'audioinput';
const DEFAULT_DEVICE = 'default';
const DEVICE_CHANGE = 'devicechange';
const DATA_AVAILABLE = 'dataavailable';
const RECORDER_STOP = 'stop';
const CHUNK_MS = 250;
export const { microphone: MICROPHONE_OFF } = DEFAULT_VOICE_SETTINGS;
const SAVED_FIELDS = ['microphone', 'spokenOutput', 'locale', 'speed', 'consentGrantedAt'] as const;

const sameSettings = (left: SavedVoiceSettings, right: SavedVoiceSettings) =>
  SAVED_FIELDS.every((field) => left[field] === right[field]);

const stopTracks = (stream: MediaStream) => {
  for (const track of stream.getTracks()) track.stop();
};

const record = (recorder: MediaRecorder) =>
  new ReadableStream<Uint8Array>({
    start: (controller) => {
      let pending = Promise.resolve();
      recorder.addEventListener(DATA_AVAILABLE, ({ data }) => {
        pending = pending.then(async () => controller.enqueue(new Uint8Array(await data.arrayBuffer())));
      });
      recorder.addEventListener(RECORDER_STOP, () => {
        pending = pending.then(() => controller.close());
      });
    },
  });

export const browserMicrophone = (media: MediaDevices, Recorder: typeof MediaRecorder): MicrophoneSource => ({
  requestPermission: async () => {
    try {
      stopTracks(await media.getUserMedia({ audio: true }));
      return 'granted';
    } catch {
      return 'denied';
    }
  },
  listDevices: async () =>
    (await media.enumerateDevices())
      .filter(({ kind }) => kind === AUDIO_INPUT)
      .map(({ deviceId, label }) => ({ id: deviceId, label, isDefault: deviceId === DEFAULT_DEVICE })),
  open: async (deviceId) => {
    const stream = await media.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
    const recorder = new Recorder(stream);
    const chunks = record(recorder);
    recorder.start(CHUNK_MS);
    return {
      chunks,
      close: () => {
        recorder.stop();
        stopTracks(stream);
      },
    };
  },
  onDeviceChange: (listener) => {
    const changed = () => void listener();
    media.addEventListener(DEVICE_CHANGE, changed);
    return () => media.removeEventListener(DEVICE_CHANGE, changed);
  },
});

export const createDesktopVoice = (options: DesktopVoiceOptions) => {
  const { providerIds, supportedLocales, subtitles, openMicrophone, submit, save } = options;
  let session = options.session;
  let consentGrantedAt = options.consentGrantedAt;
  let asking: VoiceSession | undefined;
  let microphone: Microphone | undefined;
  let fallback: VoiceFallback | undefined;
  let issues: readonly VoiceSettingsIssueCode[] = [];
  let generation = 0;

  const consent = (): VoiceConsent =>
    consentGrantedAt === undefined ? { granted: false } : { granted: true, grantedAt: consentGrantedAt, providerIds };

  const settings = (): VoiceSettings => ({
    microphone: session.preferences.microphone,
    spokenOutput: session.preferences.spokenOutput,
    consent: consent(),
  });

  const saved = (): SavedVoiceSettings => ({
    ...session.preferences,
    ...(consentGrantedAt === undefined ? {} : { consentGrantedAt }),
  });

  const apply = (next: VoiceSession, grantedAt: string | undefined) => {
    session = next;
    consentGrantedAt = grantedAt;
    save(saved());
    return listen();
  };

  const listen = async () => {
    const token = ++generation;
    microphone?.stop();
    microphone = undefined;
    fallback = undefined;
    const mode = resolveVoiceMode(settings());
    if (mode.kind === 'typed-input-only' || mode.microphone === 'off') return;
    microphone = openMicrophone(settings());
    const state = await microphone.start();
    if (token !== generation) return;
    fallback = state.kind === 'typed-input-only' ? state.reason : undefined;
  };

  const say = async (text: string, source: RequestSource = TYPED): Promise<Route> => {
    const route = routeVoiceInput(session, { source, text }, supportedLocales, submit);
    issues = route.kind === 'settings-rejected' ? route.issues.map(({ code }) => code) : [];
    if (route.kind !== 'settings') return route;
    if (consentGrantedAt === undefined && route.session.preferences.microphone !== MICROPHONE_OFF) {
      asking = route.session;
      return route;
    }
    const restart = route.event.payload.changes.some(({ field }) => field === MICROPHONE);
    session = route.session;
    save(saved());
    if (restart) await listen();
    return route;
  };

  const answer = async (allowed: boolean) => {
    const next = asking;
    asking = undefined;
    if (next === undefined) return;
    if (allowed) return apply(next, new Date().toISOString());
    return apply({ ...next, preferences: { ...next.preferences, microphone: MICROPHONE_OFF } }, consentGrantedAt);
  };

  const load = async (stored: SavedVoiceSettings) => {
    if (sameSettings(stored, saved())) return;
    const { consentGrantedAt: grantedAt, ...preferences } = stored;
    session = { ...session, preferences };
    consentGrantedAt = grantedAt;
    await listen();
  };

  const heard = async (turn: TurnTranscription): Promise<Route | undefined> => {
    if (turn.kind === 'typed-input-only') {
      fallback = turn.reason;
      return undefined;
    }
    fallback = undefined;
    const text = turn.segments
      .filter(({ final }) => final)
      .map((segment) => segment.text)
      .join(SEGMENT_GAP)
      .trim();
    return text === '' ? undefined : say(text, SPOKEN);
  };

  const view = () => ({
    mode: resolveVoiceMode(settings()),
    preferences: session.preferences,
    subtitle: subtitles.current(),
    fallback,
    issues,
    asking: asking !== undefined,
  });

  return { say, heard, view, load, start: listen, allow: () => answer(true), decline: () => answer(false) };
};

export type DesktopVoiceView = ReturnType<ReturnType<typeof createDesktopVoice>['view']>;
