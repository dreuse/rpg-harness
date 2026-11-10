import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BUNDLED_MANIFEST_PATH, loadBundledManifest, validateSoundManifest } from './sound-manifest.ts';
import { BASE_SOUND_TABLE } from './sound-selection.ts';

const SHA = 'a'.repeat(64);
const entry = (overrides: Record<string, unknown> = {}) => ({
  kind: 'music',
  key: 'calm',
  file: 'music/calm.ogg',
  mimeType: 'audio/ogg',
  url: 'https://sounds.example/calm.ogg',
  sourcePage: 'https://sounds.example/calm',
  author: 'Someone',
  license: 'CC0',
  sha256: SHA,
  bytes: 10,
  ...overrides,
});
const manifest = (...sounds: unknown[]) => ({ version: 1, sounds });
const issuesOf = (value: unknown) => {
  const result = validateSoundManifest(value);
  assert.equal(result.ok, false);
  return result.ok ? [] : result.issues;
};

test('accepts a complete CC0 entry', () => {
  const result = validateSoundManifest(manifest(entry()));
  assert.equal(result.ok, true);
});

test('rejects an entry without sha256', () => {
  const { sha256: _omitted, ...rest } = entry();
  assert.deepEqual(issuesOf(manifest(rest)), [{ index: 0, field: 'sha256' }]);
});

test('rejects a malformed sha256', () => {
  assert.deepEqual(issuesOf(manifest(entry({ sha256: 'abc' }))), [{ index: 0, field: 'sha256' }]);
});

test('rejects an entry without license', () => {
  const { license: _omitted, ...rest } = entry();
  assert.deepEqual(issuesOf(manifest(rest)), [{ index: 0, field: 'license' }]);
});

test('rejects any license that is not CC0', () => {
  assert.deepEqual(issuesOf(manifest(entry({ license: 'CC-BY-4.0' }))), [{ index: 0, field: 'license' }]);
});

test('rejects unsafe file paths, non-https urls and unknown kinds', () => {
  const issues = issuesOf(
    manifest(
      entry({ key: 'a', file: '../escape.ogg' }),
      entry({ key: 'b', url: 'http://x.example/a.ogg' }),
      entry({ key: 'c', kind: 'speech' }),
    ),
  );
  assert.deepEqual(issues, [
    { index: 0, field: 'file' },
    { index: 1, field: 'url' },
    { index: 2, field: 'kind' },
  ]);
});

test('rejects duplicate kind and key pairs', () => {
  assert.deepEqual(issuesOf(manifest(entry(), entry({ file: 'music/other.ogg' }))), [{ index: 1, field: 'key' }]);
});

test('rejects a document that is not a manifest', () => {
  assert.deepEqual(issuesOf({ version: 2, sounds: [] }), [{ index: -1, field: 'version' }]);
  assert.deepEqual(issuesOf(null), [{ index: -1, field: 'version' }]);
});

test('the bundled manifest passes validation and covers the four music beds', () => {
  const sounds = loadBundledManifest();
  assert.ok(BUNDLED_MANIFEST_PATH.endsWith('manifest.json'));
  const music = sounds.filter(({ kind }) => kind === 'music').map(({ key }) => key);
  assert.deepEqual(music.toSorted(), ['calm', 'combat', 'exploration', 'tension']);
});

test('the bundled manifest ships ambience and effect files with distinct hashes', () => {
  const sounds = loadBundledManifest();
  const keysOf = (wanted: string) =>
    sounds
      .filter(({ kind }) => kind === wanted)
      .map(({ key }) => key)
      .toSorted();
  assert.deepEqual(keysOf('ambience'), [
    'battle',
    'cave',
    'city',
    'forest',
    'rain',
    'sea',
    'storm',
    'stream',
    'tavern',
    'tension',
  ]);
  assert.deepEqual(keysOf('effect'), ['bell', 'door-knock', 'gong', 'metal-hit']);
  assert.equal(new Set(sounds.map(({ sha256 }) => sha256)).size, sounds.length);
});

const mappedAmbienceKeys = () =>
  new Set([
    ...Object.values(BASE_SOUND_TABLE.locations),
    ...Object.values(BASE_SOUND_TABLE.moods).flatMap(({ ambience }) => (ambience === undefined ? [] : [ambience])),
  ]);

test('every ambience key referenced by a base mapping has a manifest entry', () => {
  const shipped = new Set(
    loadBundledManifest()
      .filter(({ kind }) => kind === 'ambience')
      .map(({ key }) => key),
  );
  assert.deepEqual([...mappedAmbienceKeys()].filter((key) => !shipped.has(key)).toSorted(), []);
});

test('every shipped ambience key is the target of a base mapping', () => {
  const targets = new Set([
    ...Object.values(BASE_SOUND_TABLE.locations),
    ...Object.values(BASE_SOUND_TABLE.moods).map(({ ambience }) => ambience),
  ]);
  const ambience = loadBundledManifest().filter(({ kind }) => kind === 'ambience');
  assert.deepEqual(
    ambience.filter(({ key }) => !targets.has(key)).map(({ key }) => key),
    [],
  );
});

const BLOCKED_HOST = 'opengameart.org';

test('no bundled sound is hosted on a site that blocks automated clients', () => {
  for (const { url } of loadBundledManifest()) assert.notEqual(new URL(url).hostname, BLOCKED_HOST, url);
});

test('the bundled manifest loads when the install path has a space', async () => {
  const root = join(mkdtempSync(join(tmpdir(), 'rpg-')), 'RPG Harness');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'sounds'));
  copyFileSync(join(import.meta.dirname, 'sound-manifest.ts'), join(root, 'src', 'sound-manifest.ts'));
  copyFileSync(join(import.meta.dirname, '..', 'sounds', 'manifest.json'), join(root, 'sounds', 'manifest.json'));
  const moved = await import(join(root, 'src', 'sound-manifest.ts'));
  assert.ok(moved.loadBundledManifest().length > 0);
});
