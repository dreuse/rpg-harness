import { DEFAULT_PLAYBACK_SPEED } from '../../../packages/voice/src/playback.ts';
import { DEFAULT_VOICE_SETTINGS } from '../../../packages/voice/src/voice.ts';
import { routeVoiceInput, type VoiceSession } from '../../../packages/voice/src/voice-settings.ts';
import type { TuiAudio } from './tui.ts';

const TYPED = 'typed';
const CHANGED = 'Voice settings changed: ';
const NOT_CHANGED = 'Voice settings not changed: ';
const LIST = ', ';
const NEWLINE = '\n';
const FIRST_TURN = 0;

const withNotice = (message: string, notice: string | undefined) =>
  notice === undefined ? message : `${message}${NEWLINE}${notice}`;

export const createTuiAudio = (initial: VoiceSession, supportedLocales: readonly string[]): TuiAudio => {
  let session = initial;
  return {
    status: () => {
      const { microphone, spokenOutput, locale, speed } = session.preferences;
      return `Voice: mic ${microphone}, output ${spokenOutput}, ${locale}, ${speed}x`;
    },
    input: (text, act) => {
      const route = routeVoiceInput(session, { source: TYPED, text }, supportedLocales, act);
      if (route.kind === 'action') return route.result;
      if (route.kind === 'settings-rejected')
        return withNotice(`${NOT_CHANGED}${route.issues.map(({ code }) => code).join(LIST)}`, route.action);
      session = route.session;
      return withNotice(
        `${CHANGED}${route.event.payload.changes.map(({ field, to }) => `${field} ${to}`).join(LIST)}`,
        route.action,
      );
    },
  };
};

export const defaultTuiAudio = (campaignId: string): TuiAudio => {
  const { microphone, spokenOutput } = DEFAULT_VOICE_SETTINGS;
  const { locale } = Intl.DateTimeFormat().resolvedOptions();
  return createTuiAudio(
    {
      campaignId,
      turn: FIRST_TURN,
      pendingInput: [],
      preferences: { microphone, spokenOutput, locale, speed: DEFAULT_PLAYBACK_SPEED },
    },
    [locale],
  );
};
