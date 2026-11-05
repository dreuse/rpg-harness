import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { createSoundManager, SOUND_USER_AGENT } from './sound-downloader.ts';
import type { SoundEntry } from './sound-manifest.ts';
import { DEFAULT_RETRY_AFTER_SECONDS, parseRateLimited, SoundRateLimitedError } from './sound-rate-limit.ts';

const CONTENT = new TextEncoder().encode('loop-audio');
const TAMPERED = new TextEncoder().encode('evil-audio');
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
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
    sha256: sha256(CONTENT),
    bytes: CONTENT.length,
  },
];
const dirs: string[] = [];
const NOT_FOUND = 404;

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'sound-manager-'));
  dirs.push(dir);
  return dir;
};

const serving =
  (body: Uint8Array<ArrayBuffer>, status = 200): typeof fetch =>
  async () =>
    new Response(status === 200 ? body : null, { status });

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test('offers the total size and the hosts the sounds come from', async () => {
  const manager = createSoundManager({ dir: await tempDir(), sounds: SOUNDS });
  assert.equal(manager.offer.bytes, CONTENT.length);
  assert.equal(manager.offer.source, 'https://sounds.example');
});

test('refuses to download without consent to the offered size and source', async () => {
  const dir = await tempDir();
  const manager = createSoundManager({ dir, sounds: SOUNDS, fetch: serving(CONTENT) });
  await assert.rejects(
    manager.download({ ...manager.offer, accepted: true, bytes: manager.offer.bytes + 1 }),
    /explicit consent/,
  );
  assert.deepEqual(await readdir(dir), []);
});

test('downloads once with consent, verifies sha256 and reports installed sounds', async () => {
  const dir = await tempDir();
  const manager = createSoundManager({ dir, sounds: SOUNDS, fetch: serving(CONTENT) });
  assert.equal(manager.pathOf('music', 'calm'), undefined);
  const progress: number[] = [];
  await manager.download({ ...manager.offer, accepted: true }, undefined, (bytes) => progress.push(bytes));
  const path = manager.pathOf('music', 'calm');
  assert.equal(path, join(dir, 'music/calm.ogg'));
  assert.deepEqual(new Uint8Array(await readFile(path ?? '')), CONTENT);
  assert.deepEqual(await manager.status(), { installed: true, bytes: CONTENT.length });
  assert.deepEqual(progress, [CONTENT.length]);
});

test('does not download again when a verified file is already installed', async () => {
  const dir = await tempDir();
  let calls = 0;
  const counting: typeof fetch = async () => {
    calls += 1;
    return new Response(CONTENT);
  };
  const manager = createSoundManager({ dir, sounds: SOUNDS, fetch: counting });
  await manager.download({ ...manager.offer, accepted: true });
  await manager.download({ ...manager.offer, accepted: true });
  assert.equal(calls, 1);
});

test('rejects and removes a file whose sha256 does not match', async () => {
  const dir = await tempDir();
  const manager = createSoundManager({ dir, sounds: SOUNDS, fetch: serving(TAMPERED) });
  await assert.rejects(manager.download({ ...manager.offer, accepted: true }), /checksum mismatch/);
  assert.equal(manager.pathOf('music', 'calm'), undefined);
  assert.deepEqual(await manager.status(), { installed: false, bytes: 0 });
});

test('fails on an HTTP error without leaving files', async () => {
  const manager = createSoundManager({ dir: await tempDir(), sounds: SOUNDS, fetch: serving(CONTENT, NOT_FOUND) });
  await assert.rejects(manager.download({ ...manager.offer, accepted: true }), /HTTP 404/);
  assert.equal(manager.pathOf('music', 'calm'), undefined);
});

test('remove deletes every downloaded sound', async () => {
  const dir = await tempDir();
  const manager = createSoundManager({ dir, sounds: SOUNDS, fetch: serving(CONTENT) });
  await manager.download({ ...manager.offer, accepted: true });
  await manager.remove();
  assert.equal(manager.pathOf('music', 'calm'), undefined);
});

const CONSENTED = { accepted: true } as const;
const REDIRECT = 302;
const TOO_MANY_HOPS = 6;

const consent = (manager: ReturnType<typeof createSoundManager>) => ({ ...manager.offer, ...CONSENTED });

test('refuses a content-length that differs from the manifest without reading the body', async () => {
  let read = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        read = true;
        controller.enqueue(CONTENT);
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const lying: typeof fetch = async () =>
    new Response(body, { headers: { 'content-length': String(CONTENT.length + 1) } });
  const manager = createSoundManager({ dir: await tempDir(), sounds: SOUNDS, fetch: lying });
  await assert.rejects(manager.download(consent(manager)), /content-length/);
  assert.equal(read, false);
});

test('refuses a body larger than the manifest size', async () => {
  const oversized = new TextEncoder().encode('loop-audio-and-more');
  const manager = createSoundManager({ dir: await tempDir(), sounds: SOUNDS, fetch: serving(oversized) });
  await assert.rejects(manager.download(consent(manager)), /larger than/);
  assert.deepEqual(await manager.status(), { installed: false, bytes: 0 });
});

test('follows https redirects manually', async () => {
  const urls: string[] = [];
  const redirecting: typeof fetch = async (input, init) => {
    urls.push(String(input));
    assert.equal(init?.redirect, 'manual');
    return urls.length === 1
      ? new Response(null, { status: REDIRECT, headers: { location: 'https://cdn.example/calm.ogg' } })
      : new Response(CONTENT);
  };
  const manager = createSoundManager({ dir: await tempDir(), sounds: SOUNDS, fetch: redirecting });
  await manager.download(consent(manager));
  assert.deepEqual(urls, ['https://sounds.example/calm.ogg', 'https://cdn.example/calm.ogg']);
});

test('refuses a redirect to http, a missing location and too many hops', async () => {
  const redirectTo =
    (location: string | undefined): typeof fetch =>
    async () =>
      new Response(null, { status: REDIRECT, headers: location ? { location } : {} });
  for (const location of ['http://evil.example/calm.ogg', undefined, 'not a url']) {
    const manager = createSoundManager({ dir: await tempDir(), sounds: SOUNDS, fetch: redirectTo(location) });
    await assert.rejects(manager.download(consent(manager)));
  }
  let hops = 0;
  const looping: typeof fetch = async () => {
    hops += 1;
    return new Response(null, { status: REDIRECT, headers: { location: 'https://sounds.example/again' } });
  };
  const manager = createSoundManager({ dir: await tempDir(), sounds: SOUNDS, fetch: looping });
  await assert.rejects(manager.download(consent(manager)), /redirect/);
  assert.equal(hops, TOO_MANY_HOPS);
});

test('refuses a non-https sound url', async () => {
  const sounds = [{ ...SOUNDS[0]!, url: 'http://sounds.example/calm.ogg' }];
  let calls = 0;
  const counting: typeof fetch = async () => {
    calls += 1;
    return new Response(CONTENT);
  };
  const manager = createSoundManager({ dir: await tempDir(), sounds, fetch: counting });
  await assert.rejects(manager.download(consent(manager)), /https/);
  assert.equal(calls, 0);
});

test('status and download treat a same-size file with wrong content as not installed', async () => {
  const dir = await tempDir();
  const manager = createSoundManager({ dir, sounds: SOUNDS, fetch: serving(CONTENT) });
  await manager.download(consent(manager));
  await writeFile(join(dir, 'music/calm.ogg'), TAMPERED);
  assert.deepEqual(await manager.status(), { installed: false, bytes: TAMPERED.length });
  await manager.download(consent(manager));
  assert.deepEqual(new Uint8Array(await readFile(join(dir, 'music/calm.ogg'))), CONTENT);
  assert.deepEqual(await manager.status(), { installed: true, bytes: CONTENT.length });
});

const RATE_LIMITED = 429;
const SERVICE_UNAVAILABLE = 503;
const SHORT_WAIT_SECONDS = 5;
const LONG_WAIT_SECONDS = 600;
const USER_AGENT = 'user-agent';
const noSleep = async (): Promise<void> => {};

test('sends a named user agent on the first request and on every redirect hop', async () => {
  const agents: (string | null)[] = [];
  const redirecting: typeof fetch = async (_input, init) => {
    agents.push(new Headers(init?.headers).get(USER_AGENT));
    return agents.length === 1
      ? new Response(null, { status: REDIRECT, headers: { location: 'https://cdn.example/calm.ogg' } })
      : new Response(CONTENT);
  };
  const manager = createSoundManager({ dir: await tempDir(), sounds: SOUNDS, fetch: redirecting });
  await manager.download(consent(manager));
  assert.deepEqual(agents, [SOUND_USER_AGENT, SOUND_USER_AGENT]);
  assert.match(SOUND_USER_AGENT, /^RPGHarness\/\S+ \(https:\/\/github\.com\/rpg-harness; sound pack downloader\)$/);
});

for (const status of [RATE_LIMITED, SERVICE_UNAVAILABLE]) {
  test(`waits once and retries after HTTP ${status} with a short Retry-After`, async () => {
    const waits: number[] = [];
    let calls = 0;
    const flaky: typeof fetch = async () => {
      calls += 1;
      return calls === 1
        ? new Response(null, { status, headers: { 'retry-after': String(SHORT_WAIT_SECONDS) } })
        : new Response(CONTENT);
    };
    const manager = createSoundManager({
      dir: await tempDir(),
      sounds: SOUNDS,
      fetch: flaky,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    await manager.download(consent(manager));
    assert.deepEqual(waits, [SHORT_WAIT_SECONDS * 1000]);
    assert.equal(calls, 2);
  });
}

test('throws a typed error after a second rate limit without a third request', async () => {
  let calls = 0;
  const limited: typeof fetch = async () => {
    calls += 1;
    return new Response(null, { status: RATE_LIMITED, headers: { 'retry-after': '1' } });
  };
  const manager = createSoundManager({ dir: await tempDir(), sounds: SOUNDS, fetch: limited, sleep: noSleep });
  await assert.rejects(manager.download(consent(manager)), SoundRateLimitedError);
  assert.equal(calls, 2);
});

for (const header of [String(LONG_WAIT_SECONDS), undefined, 'soon']) {
  test(`stops with the retry delay when Retry-After is ${header ?? 'missing'}`, async () => {
    let calls = 0;
    const limited: typeof fetch = async () => {
      calls += 1;
      return new Response(null, {
        status: RATE_LIMITED,
        headers: header === undefined ? {} : { 'retry-after': header },
      });
    };
    const manager = createSoundManager({ dir: await tempDir(), sounds: SOUNDS, fetch: limited, sleep: noSleep });
    const error = await manager.download(consent(manager)).catch((caught: unknown) => caught);
    assert.ok(error instanceof SoundRateLimitedError);
    assert.equal(error.retryAfterSeconds, header === '600' ? LONG_WAIT_SECONDS : DEFAULT_RETRY_AFTER_SECONDS);
    assert.equal(calls, 1);
    assert.equal(parseRateLimited(error.message), error.retryAfterSeconds);
  });
}

test('keeps verified files after a mid-manifest rate limit so a retry resumes', async () => {
  const second = new TextEncoder().encode('second-audio');
  const sounds: readonly SoundEntry[] = [
    SOUNDS[0]!,
    {
      ...SOUNDS[0]!,
      key: 'storm',
      file: 'music/storm.ogg',
      url: 'https://sounds.example/storm.ogg',
      sha256: sha256(second),
      bytes: second.length,
    },
  ];
  const requested: string[] = [];
  let limit = true;
  const host: typeof fetch = async (input) => {
    requested.push(String(input));
    if (String(input).endsWith('storm.ogg')) {
      return limit
        ? new Response(null, { status: RATE_LIMITED, headers: { 'retry-after': String(LONG_WAIT_SECONDS) } })
        : new Response(second);
    }
    return new Response(CONTENT);
  };
  const manager = createSoundManager({ dir: await tempDir(), sounds, fetch: host, sleep: noSleep });
  await assert.rejects(manager.download(consent(manager)), SoundRateLimitedError);
  assert.notEqual(manager.pathOf('music', 'calm'), undefined);
  limit = false;
  requested.length = 0;
  await manager.download(consent(manager));
  assert.deepEqual(requested, ['https://sounds.example/storm.ogg']);
  assert.equal((await manager.status()).installed, true);
});
