import { isDeepStrictEqual } from 'node:util';
import type { CampaignStore } from '../../../packages/domain/src/campaign.ts';
import { StaleRevisionError } from '../../../packages/domain/src/campaign.ts';
import type { EntityStore } from '../../../packages/domain/src/entity.ts';
import type { VoiceFallback } from '../../../packages/domain/src/voice.ts';
import { InvalidActionError, loadState } from '../../../packages/engine/src/turn.ts';
import { setVoiceProfile, voiceProfileOf } from '../../../packages/engine/src/voice-profile.ts';
import { importantNpcProfile } from '../../../packages/voice/src/cinematic.ts';
import { createNpcVoices, type InstalledVoice } from '../../../packages/voice/src/npc-voice.ts';
import { DEFAULT_PLAYBACK_SPEED } from '../../../packages/voice/src/playback.ts';
import { outputSegmentsOf, routeSegments } from '../../../packages/voice/src/speaker-routing.ts';
import type { CommittedUtterance, VoiceProfile } from '../../../packages/voice/src/voice.ts';
import type { GmSegment } from './gm-segments.ts';

const VOICE_ACTION_PREFIX = 'voice';
const VOICE_ACTION_SEPARATOR = '-';
const VOICE_INTENT = 'assign important voice';
const NO_ID = '';
const AUTO_VOICE_ACTION_PREFIX = 'npcvoice';
const AUTO_VOICE_INTENT = 'assign npc voice';
const NPC_KIND = 'npc';
const GENDER_FIELD = 'gender';
const IGNORE_NOTICE = (_message: string): void => undefined;

export interface TurnUtterances {
  readonly store: CampaignStore;
  readonly entities: EntityStore;
  readonly campaignId: string;
  readonly turnId: string;
  readonly segments: readonly GmSegment[];
  readonly narrator: VoiceProfile;
  readonly npcVoices: { readonly profileOf: (speakerId: string) => VoiceProfile | undefined };
  readonly important?: ReadonlySet<string> | undefined;
  readonly installed?: (() => readonly InstalledVoice[]) | undefined;
}

const pacedBy = (profile: VoiceProfile | undefined, speed: number) =>
  profile === undefined ? undefined : { ...profile, pace: profile.pace * speed };

const importantProfileOf = ({ store, entities, campaignId, turnId, narrator }: TurnUtterances, npcId: string) => {
  const state = loadState(store, campaignId);
  const stored = voiceProfileOf(state.events, npcId);
  const profile = importantNpcProfile(npcId, { ...narrator, pace: DEFAULT_PLAYBACK_SPEED }, stored);
  if (isDeepStrictEqual(profile, stored)) return pacedBy(stored, narrator.pace);
  const actionId = [VOICE_ACTION_PREFIX, turnId, npcId].join(VOICE_ACTION_SEPARATOR);
  try {
    setVoiceProfile(store, entities, {
      campaignId,
      actionId,
      expectedRevision: state.revision,
      sceneId: state.currentScene?.id ?? NO_ID,
      actorId: state.characters[0]?.id ?? NO_ID,
      input: VOICE_INTENT,
      intent: VOICE_INTENT,
      speakerId: npcId,
      profile,
    });
    return pacedBy(profile, narrator.pace);
  } catch (error) {
    if (error instanceof InvalidActionError || error instanceof StaleRevisionError) return undefined;
    throw error;
  }
};

const autoNpcVoices = (
  { store, entities, campaignId, turnId, narrator }: TurnUtterances,
  installed: () => readonly InstalledVoice[],
) => {
  const isNpc = (speakerId: string) => entities.getEntity(campaignId, speakerId)?.kind === NPC_KIND;
  const assign = (speakerId: string, profile: VoiceProfile) => {
    const state = loadState(store, campaignId);
    try {
      setVoiceProfile(store, entities, {
        campaignId,
        actionId: [AUTO_VOICE_ACTION_PREFIX, turnId, speakerId].join(VOICE_ACTION_SEPARATOR),
        expectedRevision: state.revision,
        sceneId: state.currentScene?.id ?? NO_ID,
        actorId: state.characters[0]?.id ?? NO_ID,
        input: AUTO_VOICE_INTENT,
        intent: AUTO_VOICE_INTENT,
        speakerId,
        profile,
      });
    } catch (error) {
      if (!(error instanceof InvalidActionError || error instanceof StaleRevisionError)) throw error;
    }
  };
  const voices = createNpcVoices({
    campaignId,
    language: narrator.language,
    base: { ...narrator, pace: DEFAULT_PLAYBACK_SPEED },
    installed,
    stored: (speakerId) => voiceProfileOf(loadState(store, campaignId).events, speakerId),
    assign,
    hintOf: (speakerId) => {
      const gender = entities.getEntity(campaignId, speakerId)?.data[GENDER_FIELD];
      return typeof gender === 'string' ? { gender } : undefined;
    },
    notify: IGNORE_NOTICE,
  });
  return {
    profileOf: (speakerId: string) =>
      isNpc(speakerId) ? pacedBy(voices.profileOf(speakerId), narrator.pace) : undefined,
  };
};

export interface AssignedNpcVoices {
  readonly entities: EntityStore;
  readonly campaignId: string;
  readonly narrator: VoiceProfile;
  readonly assigned: Readonly<Record<string, VoiceFallback>>;
}

export const assignedNpcVoices = ({ entities, campaignId, narrator, assigned }: AssignedNpcVoices) => ({
  profileOf: (speakerId: string): VoiceProfile | undefined => {
    const name = entities.getEntity(campaignId, speakerId)?.name;
    const voice = name !== undefined && Object.hasOwn(assigned, name) ? assigned[name] : undefined;
    return voice === undefined ? undefined : { ...narrator, id: speakerId, fallbacks: [voice, ...narrator.fallbacks] };
  },
});

export const utterancesFor = (turn: TurnUtterances): readonly CommittedUtterance[] => {
  const { store, campaignId, turnId, segments, narrator, npcVoices, important = new Set<string>() } = turn;
  const auto = turn.installed === undefined ? undefined : autoNpcVoices(turn, turn.installed);
  const committed = { events: loadState(store, campaignId).events.filter((event) => event.turnId === turnId) };
  const eventId = committed.events[0]?.id;
  if (eventId === undefined) return [];
  const marked = new Set([
    ...important,
    ...segments.flatMap(({ speakerId, important: hinted }) =>
      hinted === true && speakerId !== undefined ? [speakerId] : [],
    ),
  ]);
  const importantProfiles = new Map(
    [...marked].map((id) => [id, npcVoices.profileOf(id) ?? importantProfileOf(turn, id)] as const),
  );
  return routeSegments({
    committed,
    segments: outputSegmentsOf(eventId, segments),
    narrator,
    profileOf: (speakerId) =>
      importantProfiles.has(speakerId)
        ? importantProfiles.get(speakerId)
        : (npcVoices.profileOf(speakerId) ?? auto?.profileOf(speakerId)),
  });
};
