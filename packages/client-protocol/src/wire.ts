import type { ClientEvent, ProtocolVersion, Result } from './protocol.ts';

export const READY = 'Ready';
export const EVENT = 'Event';
export const NARRATION = 'Narration';

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
};
export type Reply = {
  readonly id: number;
  readonly type: 'Pong' | 'Stopped' | 'Error' | 'Result' | 'Unsubscribed' | 'Played' | 'Diagnosed';
  readonly message?: string;
  readonly summary?: unknown;
  readonly result?: Result<unknown>;
};
export type Pushed = { readonly id: number; readonly type: typeof EVENT; readonly event: ClientEvent };
export type Narrated = {
  readonly id: number;
  readonly type: typeof NARRATION;
  readonly turnId: string;
  readonly text: string;
};
