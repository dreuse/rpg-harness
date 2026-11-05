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
export const WINDOWS_WAV_ONLY_MESSAGE = 'The Windows player decodes WAV only.';
const WINDOWS_PLATFORM = 'win32';
const WINDOWS_COMMAND = 'powershell.exe';
const WINDOWS_FLAGS = ['-NoProfile', '-NonInteractive', '-EncodedCommand'] as const;
const POWERSHELL_QUOTES = /['\u2018\u2019\u201A\u201B]/g;

export const windowsPlayerScript = (file: string): string =>
  `(New-Object System.Media.SoundPlayer '${file.replace(POWERSHELL_QUOTES, (quote) => quote + quote)}').PlaySync()`;

const playerInvocation = (platform: NodeJS.Platform, file: string): readonly [string, ...string[]] | undefined => {
  if (platform === WINDOWS_PLATFORM)
    return [WINDOWS_COMMAND, ...WINDOWS_FLAGS, Buffer.from(windowsPlayerScript(file), 'utf16le').toString('base64')];
  const player = PLAYER_COMMANDS[platform];
  return player === undefined ? undefined : [...player, file];
};
const WAV_MIME_TYPE = 'audio/wav';
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
        if (platform !== WINDOWS_PLATFORM && PLAYER_COMMANDS[platform] === undefined)
          return reject(new Error(NO_PLAYER_MESSAGE));
        if (signal.aborted) return resolve();
        if (platform === WINDOWS_PLATFORM && chunk.mimeType !== WAV_MIME_TYPE)
          return reject(new Error(WINDOWS_WAV_ONLY_MESSAGE));
        dir ??= mkdtempSync(join(tmpdir(), TEMP_PREFIX));
        const extension = EXTENSIONS[chunk.mimeType] ?? DEFAULT_EXTENSION;
        const file = join(dir, `${counter++}.${extension}`);
        writeFileSync(file, chunk.audio, { mode: PRIVATE_FILE_MODE });
        const [command, ...args] = playerInvocation(platform, file) as readonly [string, ...string[]];
        const child = spawn(command, args);
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
    pause: () => void (platform === WINDOWS_PLATFORM ? undefined : current?.kill('SIGSTOP')),
    resume: () => void (platform === WINDOWS_PLATFORM ? undefined : current?.kill('SIGCONT')),
    dispose: () => {
      current?.kill('SIGKILL');
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    },
  };
};
