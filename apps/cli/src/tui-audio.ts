import { randomUUID } from 'node:crypto';
import {
  type ClientSession,
  PROTOCOL_VERSION,
  type SavedVoiceSettings,
} from '../../../packages/client-protocol/src/protocol.ts';
import type { CampaignId } from '../../../packages/domain/src/campaign.ts';
import { voiceLocaleFor } from '../../../packages/voice/src/language-voices.ts';
import { DEFAULT_PLAYBACK_SPEED } from '../../../packages/voice/src/playback.ts';
import { applyPlaybackCommand, type PlaybackControl } from '../../../packages/voice/src/playback-controls.ts';
import { DEFAULT_VOICE_SETTINGS } from '../../../packages/voice/src/voice.ts';
import { routeVoiceInput, type VoiceSession } from '../../../packages/voice/src/voice-settings.ts';
import type { TuiAudio } from './tui.ts';

export type SaveVoice = (settings: SavedVoiceSettings) => string | undefined;

const TYPED = 'typed';
const CHANGED = 'Voice settings changed: ';
const NOT_CHANGED = 'Voice settings not changed: ';
const NOT_SAVED = 'Voice settings not saved: ';
const CONSENT_PROMPT = 'Allow microphone capture for this campaign? Type yes or no.';
const ALLOWED = 'Microphone allowed.';
const DECLINED = 'Microphone stays off. Type to play.';
const YES = /^\s*y(?:es)?\s*$/i;
const LIST = ', ';
const COMMAND_PREFIX = '/';
const PLAYBACK = 'Playback: ';
const NEWLINE = '\n';
const FIRST_TURN = 0;
const { microphone: MICROPHONE_OFF } = DEFAULT_VOICE_SETTINGS;

const withNotice = (message: string, notice: string | undefined) =>
  notice === undefined ? message : `${message}${NEWLINE}${notice}`;

export const createTuiAudio = (
  initial: VoiceSession,
  supportedLocales: readonly string[],
  save: SaveVoice,
  grantedAt?: string,
  playback?: PlaybackControl,
): TuiAudio => {
  let session = initial;
  let consentGrantedAt = grantedAt;
  let pending: { readonly session: VoiceSession; readonly message: string } | undefined;

  const commit = (next: VoiceSession, granted: string | undefined, message: string) => {
    const error = save({ ...next.preferences, ...(granted === undefined ? {} : { consentGrantedAt: granted }) });
    if (error !== undefined) return `${NOT_SAVED}${error}`;
    session = next;
    consentGrantedAt = granted;
    return message;
  };

  const answer = (text: string, asked: NonNullable<typeof pending>) => {
    pending = undefined;
    if (YES.test(text)) return commit(asked.session, new Date().toISOString(), withNotice(ALLOWED, asked.message));
    const preferences = { ...asked.session.preferences, microphone: MICROPHONE_OFF };
    return commit({ ...asked.session, preferences }, consentGrantedAt, DECLINED);
  };

  return {
    status: () => {
      const { microphone, spokenOutput, locale, speed } = session.preferences;
      return `Voice: mic ${microphone}, output ${spokenOutput}, ${locale}, ${speed}x`;
    },
    input: (text, act) => {
      if (pending !== undefined) return answer(text, pending);
      const command = text.trim().slice(COMMAND_PREFIX.length);
      if (playback !== undefined && text.trim().startsWith(COMMAND_PREFIX) && applyPlaybackCommand(playback, command))
        return `${PLAYBACK}${command}`;
      const route = routeVoiceInput(session, { source: TYPED, text }, supportedLocales, act);
      if (route.kind === 'action') return route.result;
      if (route.kind === 'settings-rejected')
        return withNotice(`${NOT_CHANGED}${route.issues.map(({ code }) => code).join(LIST)}`, route.action);
      const message = `${CHANGED}${route.event.payload.changes.map(({ field, to }) => `${field} ${to}`).join(LIST)}`;
      if (consentGrantedAt === undefined && route.session.preferences.microphone !== MICROPHONE_OFF) {
        pending = { session: route.session, message };
        return withNotice(CONSENT_PROMPT, route.action);
      }
      return withNotice(commit(route.session, consentGrantedAt, message), route.action);
    },
  };
};

export const defaultTuiAudio = (client: ClientSession, campaignId: CampaignId): TuiAudio => {
  const snapshot = () => client.getSnapshot({ version: PROTOCOL_VERSION, type: 'GetCampaignSnapshot', campaignId });
  const current = snapshot();
  const saved = current.ok ? current.value.voice : undefined;
  const { locale: systemLocale } = Intl.DateTimeFormat().resolvedOptions();
  const language = current.ok ? current.value.language : undefined;
  const locale = language === undefined ? systemLocale : voiceLocaleFor(language, systemLocale);
  const fallback: SavedVoiceSettings = {
    microphone: MICROPHONE_OFF,
    spokenOutput: DEFAULT_VOICE_SETTINGS.spokenOutput,
    locale,
    speed: DEFAULT_PLAYBACK_SPEED,
  };
  const { consentGrantedAt, ...preferences } = saved ?? fallback;
  const save: SaveVoice = (settings) => {
    const latest = snapshot();
    if (!latest.ok) return latest.error.message;
    const result = client.saveVoiceSettings({
      version: PROTOCOL_VERSION,
      type: 'SaveVoiceSettings',
      campaignId,
      actionId: randomUUID(),
      expectedRevision: latest.value.revision,
      ...settings,
    });
    return result.ok ? undefined : result.error.message;
  };
  return createTuiAudio(
    { campaignId, turn: FIRST_TURN, pendingInput: [], preferences },
    [...new Set([locale, preferences.locale])],
    save,
    consentGrantedAt,
  );
};
