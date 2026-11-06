import type { GmFailure } from './gm-failure.ts';
import type { ClientEvent, ProtocolVersion, Result } from './protocol.ts';

export const READY = 'Ready';
export const EVENT = 'Event';
export const NARRATION = 'Narration';
export const NARRATION_FAILED = 'NarrationFailed';
export const SPEAKING = 'Speaking';

export type GmRoute = 'api' | 'claude-code' | 'fake';
export type Ready = {
  readonly type: typeof READY;
  readonly version: ProtocolVersion;
  readonly pid: number;
  readonly node: string;
  readonly sqlite: boolean;
  readonly gm: GmRoute;
};
export type RequestType = 'Ping' | 'Shutdown';
export type Request = {
  readonly id: number;
  readonly type: string;
  readonly command?: unknown;
  readonly subscription?: number;
  readonly narration?: boolean;
  readonly language?: unknown;
};
export type Reply = {
  readonly id: number;
  readonly type: 'Pong' | 'Stopped' | 'Error' | 'Result' | 'Unsubscribed' | 'Played' | 'Diagnosed' | 'Localized';
  readonly message?: string;
  readonly summary?: unknown;
  readonly result?: Result<unknown>;
  readonly narrationFailed?: GmFailure;
};
export type Pushed = { readonly id: number; readonly type: typeof EVENT; readonly event: ClientEvent };
export type Narrated = {
  readonly id: number;
  readonly type: typeof NARRATION;
  readonly turnId: string;
  readonly text: string;
};
export type Speaking = { readonly type: typeof SPEAKING; readonly active: boolean };

export const isSpeaking = (message: unknown): message is Speaking =>
  typeof message === 'object' &&
  message !== null &&
  (message as Speaking).type === SPEAKING &&
  typeof (message as Speaking).active === 'boolean';
