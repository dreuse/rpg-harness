import { randomUUID } from 'node:crypto';
import {
  type ClientSession,
  PROTOCOL_VERSION,
  type SavedVoiceSettings,
} from '../../../packages/client-protocol/src/protocol.ts';
import type { CampaignId } from '../../../packages/domain/src/campaign.ts';
import { voiceLocaleFor } from '../../../packages/voice/src/language-voices.ts';
import { DEFAULT_PLAYBACK_SPEED } from '../../../packages/voice/src/playback.ts';
import { applyPlaybackCommand } from '../../../packages/voice/src/playback-controls.ts';
import { DEFAULT_VOICE_SETTINGS } from '../../../packages/voice/src/voice.ts';
import type { VoiceDiagnosticsSummary } from '../../../packages/voice/src/voice-diagnostics.ts';
import { routeVoiceInput, type VoiceSession } from '../../../packages/voice/src/voice-settings.ts';
import { DEFAULT_LOCALE, say } from './messages.ts';
import type { TuiAudio, TuiPlayback } from './tui.ts';

export type SaveVoice = (settings: SavedVoiceSettings) => string | undefined;

const TYPED = 'typed';
const YES = /^\s*(?:y(?:es)?|s(?:im)?)\s*$/i;
const LIST = ', ';
const COMMAND_PREFIX = '/';
const DIAGNOSTICS_COMMAND = 'voice';
const NEWLINE = '\n';
const FIRST_TURN = 0;
const { microphone: MICROPHONE_OFF } = DEFAULT_VOICE_SETTINGS;

const speechLine = (summary: VoiceDiagnosticsSummary | undefined, locale: string) => {
  if (summary === undefined || summary.samples === 0) return say(locale, 'audio.noSpeech');
  const errors = Object.values(summary.errors).reduce((sum, count) => sum + (count ?? 0), 0);
  const parts = [
    say(locale, 'audio.samples', { count: String(summary.samples) }),
    ...(summary.firstAudioMs === undefined
      ? []
      : [say(locale, 'audio.firstAudio', { ms: String(summary.firstAudioMs) })]),
    ...(summary.stages.synthesis === undefined
      ? []
      : [say(locale, 'audio.synthesis', { ms: String(summary.stages.synthesis) })]),
    ...(summary.peakQueueDepth === undefined
      ? []
      : [say(locale, 'audio.peakQueue', { depth: String(summary.peakQueueDepth) })]),
    say(locale, 'audio.errors', { count: String(errors) }),
  ];
  return say(locale, 'audio.speech', { parts: parts.join(LIST) });
};

const withNotice = (message: string, notice: string | undefined) =>
  notice === undefined ? message : `${message}${NEWLINE}${notice}`;

export const createTuiAudio = (
  initial: VoiceSession,
  supportedLocales: readonly string[],
  save: SaveVoice,
  grantedAt?: string,
  playback?: TuiPlayback,
  locale = DEFAULT_LOCALE,
): TuiAudio => {
  let session = initial;
  let consentGrantedAt = grantedAt;
  let pending: { readonly session: VoiceSession; readonly message: string } | undefined;

  const commit = (next: VoiceSession, granted: string | undefined, message: string) => {
    const error = save({ ...next.preferences, ...(granted === undefined ? {} : { consentGrantedAt: granted }) });
    if (error !== undefined) return say(locale, 'audio.notSaved', { error });
    session = next;
    consentGrantedAt = granted;
    return message;
  };

  const answer = (text: string, asked: NonNullable<typeof pending>) => {
    pending = undefined;
    if (YES.test(text))
      return commit(asked.session, new Date().toISOString(), withNotice(say(locale, 'audio.allowed'), asked.message));
    const preferences = { ...asked.session.preferences, microphone: MICROPHONE_OFF };
    return commit({ ...asked.session, preferences }, consentGrantedAt, say(locale, 'audio.declined'));
  };

  return {
    status: () => {
      const { microphone, spokenOutput, locale: voiceLocale, speed } = session.preferences;
      return say(locale, 'audio.status', { microphone, output: spokenOutput, locale: voiceLocale, speed });
    },
    input: (text, act) => {
      if (pending !== undefined) return answer(text, pending);
      const command = text.trim().slice(COMMAND_PREFIX.length);
      if (playback !== undefined && text.trim().startsWith(COMMAND_PREFIX)) {
        if (command === DIAGNOSTICS_COMMAND && playback.diagnostics !== undefined)
          return speechLine(playback.diagnostics(), locale);
        if (applyPlaybackCommand(playback, command)) return say(locale, 'audio.playback', { command });
      }
      const route = routeVoiceInput(session, { source: TYPED, text }, supportedLocales, act);
      if (route.kind === 'action') return route.result;
      if (route.kind === 'settings-rejected')
        return withNotice(
          say(locale, 'audio.notChanged', { issues: route.issues.map(({ code }) => code).join(LIST) }),
          route.action,
        );
      const message = say(locale, 'audio.changed', {
        changes: route.event.payload.changes.map(({ field, to }) => `${field} ${to}`).join(LIST),
      });
      if (consentGrantedAt === undefined && route.session.preferences.microphone !== MICROPHONE_OFF) {
        pending = { session: route.session, message };
        return withNotice(say(locale, 'audio.consent'), route.action);
      }
      return withNotice(commit(route.session, consentGrantedAt, message), route.action);
    },
  };
};

export const defaultTuiAudio = (
  client: ClientSession,
  campaignId: CampaignId,
  playback?: TuiPlayback,
  uiLocale = DEFAULT_LOCALE,
): TuiAudio => {
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
    playback,
    uiLocale,
  );
};
