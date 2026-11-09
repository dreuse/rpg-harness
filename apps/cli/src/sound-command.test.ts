import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import type { SoundEntry } from '../../../packages/voice/src/sound-manifest.ts';
import { readSoundSettings, soundCommand, soundRequestOf, writeSoundSettings } from './sound-command.ts';
import { SOUND_SETTINGS_FILE } from './sound-files.ts';

const dirs: string[] = [];
const BODY = new TextEncoder().encode('audio');
const SOUNDS: readonly SoundEntry[] = [
  {
    kind: 'music',
    key: 'calm',
    file: 'music/calm.ogg',
    mimeType: 'audio/ogg',
    url: 'https://sounds.example/calm.ogg',
    sourcePage: 'https://sounds.example/calm',
    author: 'Someone',
    license: 'CC0',
    sha256: createHash('sha256').update(BODY).digest('hex'),
    bytes: BODY.length,
  },
];
const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sound-command-'));
  dirs.push(dir);
  return dir;
};
const collect = async (lines: AsyncIterable<string>) => {
  const out: string[] = [];
  for await (const line of lines) out.push(line);
  return out.join('\n');
};
const none = { enabled: {}, volume: {}, download: false, accept: false };

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test('everything is off by default and the status says so', async () => {
  const dir = await tempDir();
  const text = await collect(soundCommand(dir, none, { sounds: SOUNDS }));
  assert.match(text, /ambience: off, volume 50%/);
  assert.match(text, /effects: off, volume 50%/);
  assert.match(text, /music: off, volume 50%/);
  assert.deepEqual(readSoundSettings(dir).music, { enabled: false, volume: 0.5 });
});

test('turns channels on and sets volumes, and saves them', async () => {
  const dir = await tempDir();
  const text = await collect(
    soundCommand(dir, { ...none, enabled: { music: true }, volume: { music: 0.25 } }, { sounds: SOUNDS }),
  );
  assert.match(text, /music: on, volume 25%/);
  assert.deepEqual(readSoundSettings(dir).music, { enabled: true, volume: 0.25 });
  JSON.parse(await readFile(join(dir, SOUND_SETTINGS_FILE), 'utf8'));
});

test('a corrupt settings file falls back to everything off', async () => {
  const dir = await tempDir();
  writeSoundSettings(dir, readSoundSettings(dir));
  await writeFile(join(dir, SOUND_SETTINGS_FILE), '{nope');
  assert.equal(readSoundSettings(dir).music.enabled, false);
});

test('download shows the offer and downloads nothing without consent', async () => {
  const dir = await tempDir();
  let calls = 0;
  const fetchSpy: typeof fetch = async () => {
    calls += 1;
    return new Response(BODY);
  };
  const text = await collect(soundCommand(dir, { ...none, download: true }, { sounds: SOUNDS, fetch: fetchSpy }));
  assert.match(text, /https:\/\/sounds\.example/);
  assert.match(text, /--yes/);
  assert.equal(calls, 0);
});

test('download with consent fetches and verifies the sounds once', async () => {
  const dir = await tempDir();
  const fetchOk: typeof fetch = async () => new Response(BODY);
  const text = await collect(
    soundCommand(dir, { ...none, download: true, accept: true }, { sounds: SOUNDS, fetch: fetchOk }),
  );
  assert.match(text, /Downloaded/);
  assert.match(await collect(soundCommand(dir, none, { sounds: SOUNDS })), /sounds installed: yes/);
});

test('a failed checksum is reported and nothing is installed', async () => {
  const dir = await tempDir();
  const evil: typeof fetch = async () => new Response(new TextEncoder().encode('evil'));
  await assert.rejects(
    collect(soundCommand(dir, { ...none, download: true, accept: true }, { sounds: SOUNDS, fetch: evil })),
    /The sound download failed: .*checksum mismatch/,
  );
});

test('a permanent 403 is reported in pt-BR without the internal code or a connection hint', async () => {
  const dir = await tempDir();
  const blocked: typeof fetch = async () => new Response(null, { status: 403 });
  await assert.rejects(
    collect(
      soundCommand(dir, { ...none, download: true, accept: true }, { sounds: SOUNDS, fetch: blocked, locale: 'pt-BR' }),
    ),
    (error: Error) =>
      /Alguns sons não puderam ser baixados do servidor/.test(error.message) &&
      /HTTP 403/.test(error.message) &&
      !/sound-unavailable|conexão/.test(error.message),
  );
});

test('parses option values and rejects invalid ones', () => {
  assert.deepEqual(soundRequestOf({ music: true, 'music-volume': '0.4', yes: true, download: true }), {
    enabled: { music: true },
    volume: { music: 0.4 },
    download: true,
    accept: true,
  });
  assert.equal(typeof soundRequestOf({ 'music-volume': '2' }), 'string');
  assert.equal(typeof soundRequestOf({ 'effects-volume': 'loud' }), 'string');
  assert.equal(typeof soundRequestOf({ yes: true }), 'string');
});

test('rpg-cm63.34 the status and download lines speak pt-BR', async () => {
  const dir = await tempDir();
  const text = await collect(soundCommand(dir, none, { sounds: SOUNDS, locale: 'pt-BR' }));
  assert.match(text, /^ambiência: desligada, volume 50%$/m);
  assert.match(text, /^efeitos: desligados, volume 50%$/m);
  assert.match(text, /^música: desligada, volume 50%$/m);
  assert.match(text, /sons instalados: não \(execute sound --download\)/);
  const offer = await collect(soundCommand(dir, { ...none, download: true }, { sounds: SOUNDS, locale: 'pt-BR' }));
  assert.match(offer, /Baixe .* MiB de sons CC0 de https:\/\/sounds\.example/);
  assert.match(offer, /--download --yes/);
  const done = await collect(
    soundCommand(
      dir,
      { ...none, download: true, accept: true },
      { sounds: SOUNDS, locale: 'pt-BR', fetch: async () => new Response(BODY) },
    ),
  );
  assert.match(done, /Sons baixados e verificados\./);
});
