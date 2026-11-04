import { resolveVoiceMode, type VoiceSettings } from './voice.ts';

export type TurnMode = 'push-to-talk' | 'hands-free';
export type TurnState = 'idle' | 'listening';

export interface VoiceTurn {
  readonly id: string;
  readonly mode: TurnMode;
  readonly chunks: readonly Uint8Array[];
  readonly startedAt: number;
  readonly endedAt: number;
}

export interface TurnOptions {
  readonly speechChunksToStart: number;
  readonly silenceChunksToEnd: number;
  readonly minTurnChunks: number;
}

export interface TurnDetectorDeps {
  readonly settings: VoiceSettings;
  readonly isSpeech: (chunk: Uint8Array) => boolean;
  readonly nextId: () => string;
  readonly now: () => number;
  readonly onTurn: (turn: VoiceTurn) => void;
  readonly onSpeechStart?: () => void;
  readonly options?: TurnOptions;
}

export interface TurnDetector {
  start(mode: TurnMode): TurnMode | undefined;
  stop(): void;
  cancel(): void;
  press(): void;
  release(): void;
  push(chunk: Uint8Array): void;
  state(): TurnState;
  mode(): TurnMode | undefined;
}

export const DEFAULT_TURN_OPTIONS: TurnOptions = {
  speechChunksToStart: 3,
  silenceChunksToEnd: 5,
  minTurnChunks: 1,
};

const INVALID_OPTION = 'must be an integer >= 1';

interface OpenTurn {
  readonly mode: TurnMode;
  readonly chunks: Uint8Array[];
  readonly startedAt: number;
}

const assertOptions = (options: TurnOptions): void => {
  for (const [name, value] of Object.entries(options)) {
    if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} ${INVALID_OPTION}`);
  }
};

const permits = (settings: VoiceSettings, mode: TurnMode): boolean => {
  const resolved = resolveVoiceMode(settings);
  if (resolved.kind !== 'voice' || resolved.microphone === 'off') return false;
  return mode === 'push-to-talk' || resolved.microphone === 'hands-free';
};

export const createTurnDetector = (deps: TurnDetectorDeps): TurnDetector => {
  const options = deps.options ?? DEFAULT_TURN_OPTIONS;
  assertOptions(options);
  let active: TurnMode | undefined;
  let open: OpenTurn | undefined;
  let pending: Uint8Array[] = [];
  let silenceRun = 0;

  const reset = (): void => {
    open = undefined;
    pending = [];
    silenceRun = 0;
  };

  const begin = (mode: TurnMode, chunks: Uint8Array[]): void => {
    open = { mode, chunks, startedAt: deps.now() };
    deps.onSpeechStart?.();
  };

  const finish = (): void => {
    const turn = open;
    reset();
    if (!turn || turn.chunks.length < options.minTurnChunks) return;
    deps.onTurn(
      Object.freeze({
        id: deps.nextId(),
        mode: turn.mode,
        chunks: Object.freeze([...turn.chunks]),
        startedAt: turn.startedAt,
        endedAt: deps.now(),
      }),
    );
  };

  const detect = (chunk: Uint8Array): void => {
    const speech = deps.isSpeech(chunk);
    if (open) {
      open.chunks.push(chunk);
      silenceRun = speech ? 0 : silenceRun + 1;
      if (silenceRun >= options.silenceChunksToEnd) finish();
      return;
    }
    if (!speech) {
      pending = [];
      return;
    }
    pending.push(chunk);
    if (pending.length >= options.speechChunksToStart) begin('hands-free', pending);
  };

  return {
    start(mode) {
      if (!permits(deps.settings, mode)) return undefined;
      reset();
      active = mode;
      return active;
    },
    stop() {
      reset();
      active = undefined;
    },
    cancel: reset,
    press() {
      if (active === 'push-to-talk' && !open) begin('push-to-talk', []);
    },
    release() {
      if (active === 'push-to-talk') finish();
    },
    push(chunk) {
      if (active === 'hands-free') detect(chunk);
      else if (open) open.chunks.push(chunk);
    },
    state: () => (open ? 'listening' : 'idle'),
    mode: () => active,
  };
};
