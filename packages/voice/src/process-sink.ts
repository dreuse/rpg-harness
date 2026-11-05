import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlaybackSink } from './playback.ts';

export interface PlayerProcess {
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnPlayer = (command: string, args: readonly string[]) => PlayerProcess;

export interface ProcessSink extends PlaybackSink {
  dispose(): void;
}

export interface ProcessSinkOptions {
  readonly platform?: NodeJS.Platform;
  readonly spawn?: SpawnPlayer;
}

export const PLAYER_COMMANDS: Readonly<Partial<Record<NodeJS.Platform, readonly [string, ...string[]]>>> = {
  darwin: ['/usr/bin/afplay'],
  linux: ['/usr/bin/paplay'],
};
export const NO_PLAYER_MESSAGE = 'No audio player is available on this platform.';

const TEMP_PREFIX = 'rpg-voice-';
const PRIVATE_FILE_MODE = 0o600;
const EXTENSIONS: Readonly<Record<string, string>> = { 'audio/wav': 'wav', 'audio/mpeg': 'mp3' };
const DEFAULT_EXTENSION = 'bin';

const spawnPlayer: SpawnPlayer = (command, args) => nodeSpawn(command, [...args], { stdio: 'ignore' });

export const createProcessSink = ({
  platform = process.platform,
  spawn = spawnPlayer,
}: ProcessSinkOptions = {}): ProcessSink => {
  let dir: string | undefined;
  let counter = 0;
  let current: PlayerProcess | undefined;

  return {
    play: (chunk, _speed, signal) =>
      new Promise<void>((resolve, reject) => {
        const player = PLAYER_COMMANDS[platform];
        if (player === undefined) return reject(new Error(NO_PLAYER_MESSAGE));
        if (signal.aborted) return resolve();
        dir ??= mkdtempSync(join(tmpdir(), TEMP_PREFIX));
        const extension = EXTENSIONS[chunk.mimeType] ?? DEFAULT_EXTENSION;
        const file = join(dir, `${counter++}.${extension}`);
        writeFileSync(file, chunk.audio, { mode: PRIVATE_FILE_MODE });
        const [command, ...flags] = player;
        const child = spawn(command, [...flags, file]);
        current = child;
        const finish = (error?: Error) => {
          signal.removeEventListener('abort', stop);
          if (current === child) current = undefined;
          rmSync(file, { force: true });
          if (error === undefined) resolve();
          else reject(error);
        };
        const stop = () => child.kill('SIGKILL');
        signal.addEventListener('abort', stop, { once: true });
        child.on('close', () => finish());
        child.on('error', finish);
      }),
    pause: () => void current?.kill('SIGSTOP'),
    resume: () => void current?.kill('SIGCONT'),
    dispose: () => {
      current?.kill('SIGKILL');
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    },
  };
};
