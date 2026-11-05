import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, parseVersion } from './version.ts';

const ordered = ['0.9.0', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0'];

const sign = (value: number) => Math.sign(value);

test('orders versions by semantic version precedence', () => {
  const parsed = ordered.map((text) => parseVersion(text));
  for (const [index, version] of parsed.entries()) {
    const next = parsed[index + 1];
    if (version === undefined || next === undefined) continue;
    assert.equal(sign(compareVersions(version, next)), -1, `${version.text} < ${next.text}`);
    assert.equal(sign(compareVersions(next, version)), 1);
  }
});

test('reads tags with a v prefix and build metadata', () => {
  const tagged = parseVersion('v2.3.4+build.7');
  const plain = parseVersion('2.3.4');
  assert.ok(tagged && plain);
  assert.equal(tagged.text, '2.3.4');
  assert.equal(compareVersions(tagged, plain), 0);
});

test('rejects text that is not a version', () => {
  for (const text of ['', 'latest', '1.2', '1.2.3.4', 'v1.x.0']) assert.equal(parseVersion(text), undefined, text);
});

test('marks pre-release versions', () => {
  assert.equal(parseVersion('1.0.0-rc.1')?.prerelease, true);
  assert.equal(parseVersion('1.0.0')?.prerelease, false);
});
