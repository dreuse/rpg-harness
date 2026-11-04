import type { Result, SubmitPlayerAction } from '../../../packages/client-protocol/src/protocol.ts';
import type { AudioFailure, TurnTranscription } from '../../../packages/voice/src/fallback.ts';
import type { MicrophoneController, TypedFallbackReason } from '../../../packages/voice/src/microphone.ts';
import type { SttFallbackReason } from '../../../packages/voice/src/stt.ts';
import type { SubtitleTranscript } from '../../../packages/voice/src/subtitles.ts';
import { resolveVoiceMode, type VoiceConsent, type VoiceSettings } from '../../../packages/voice/src/voice.ts';
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
  readonly consent: VoiceConsent;
  readonly supportedLocales: readonly string[];
  readonly subtitles: Pick<SubtitleTranscript, 'current'>;
  readonly openMicrophone: (settings: VoiceSettings) => Microphone;
  readonly submit: (input: string) => Result<SubmitPlayerAction>;
};

const TYPED: RequestSource = 'typed';
const SPOKEN: RequestSource = 'spoken';
const MICROPHONE = 'microphone';
const SEGMENT_GAP = ' ';

export const createDesktopVoice = (options: DesktopVoiceOptions) => {
  const { consent, supportedLocales, subtitles, openMicrophone, submit } = options;
  let session = options.session;
  let microphone: Microphone | undefined;
  let fallback: VoiceFallback | undefined;
  let issues: readonly VoiceSettingsIssueCode[] = [];

  const settings = (): VoiceSettings => ({
    microphone: session.preferences.microphone,
    spokenOutput: session.preferences.spokenOutput,
    consent,
  });

  const listen = async () => {
    microphone?.stop();
    microphone = undefined;
    const mode = resolveVoiceMode(settings());
    if (mode.kind === 'typed-input-only' || mode.microphone === 'off') return;
    microphone = openMicrophone(settings());
    const state = await microphone.start();
    fallback = state.kind === 'typed-input-only' ? state.reason : undefined;
  };

  const say = async (text: string, source: RequestSource = TYPED): Promise<Route> => {
    const route = routeVoiceInput(session, { source, text }, supportedLocales, submit);
    issues = route.kind === 'settings-rejected' ? route.issues.map(({ code }) => code) : [];
    if (route.kind !== 'settings') return route;
    session = route.session;
    if (route.event.payload.changes.some(({ field }) => field === MICROPHONE)) await listen();
    return route;
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
  });

  return { say, heard, view };
};

export type DesktopVoiceView = ReturnType<ReturnType<typeof createDesktopVoice>['view']>;
