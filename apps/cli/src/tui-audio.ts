import { routeVoiceInput, type VoiceSession } from '../../../packages/voice/src/voice-settings.ts';
import type { TuiAudio } from './tui.ts';

const TYPED = 'typed';
const CHANGED = 'Voice settings changed: ';
const NOT_CHANGED = 'Voice settings not changed: ';
const LIST = ', ';

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
      if (route.kind === 'settings-rejected') return `${NOT_CHANGED}${route.issues.map(({ code }) => code).join(LIST)}`;
      session = route.session;
      return `${CHANGED}${route.event.payload.changes.map(({ field, to }) => `${field} ${to}`).join(LIST)}`;
    },
  };
};
