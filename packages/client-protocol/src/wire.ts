import type { ClientEvent, ProtocolVersion, Result } from './protocol.ts';

export const READY = 'Ready';
export const EVENT = 'Event';

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
};
export type Reply = {
  readonly id: number;
  readonly type: 'Pong' | 'Stopped' | 'Error' | 'Result' | 'Unsubscribed';
  readonly message?: string;
  readonly result?: Result<unknown>;
};
export type Pushed = { readonly id: number; readonly type: typeof EVENT; readonly event: ClientEvent };
