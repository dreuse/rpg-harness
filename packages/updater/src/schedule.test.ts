import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CheckResult } from './release.ts';
import { checkOnStartup, DAY_MS, DEFAULT_STATE, readState, writeState } from './schedule.ts';

const NOW = Date.parse('2026-11-04T10:00:00Z');
const CURRENT: CheckResult = { status: 'current', version: '1.0.0' };

const withStateFile = (t: { after: (fn: () => void) => void }) => {
  const dir = mkdtempSync(join(tmpdir(), 'rpg-update-state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'updates.json');
};

const counter = () => {
  let calls = 0;
  return {
    check: async () => {
      calls += 1;
      return CURRENT;
    },
    calls: () => calls,
  };
};

test('checks by default and remembers when it checked', async (t) => {
  const file = withStateFile(t);
  const { check, calls } = counter();
  assert.deepEqual(readState(file), DEFAULT_STATE);
  assert.deepEqual(await checkOnStartup({ stateFile: file, now: NOW, check }), CURRENT);
  assert.equal(calls(), 1);
  assert.equal(readState(file).lastCheckAt, NOW);
});

test('checks at most once a day', async (t) => {
  const file = withStateFile(t);
  const { check, calls } = counter();
  await checkOnStartup({ stateFile: file, now: NOW, check });
  assert.equal(await checkOnStartup({ stateFile: file, now: NOW + DAY_MS - 1, check }), undefined);
  assert.equal(calls(), 1);
  await checkOnStartup({ stateFile: file, now: NOW + DAY_MS, check });
  assert.equal(calls(), 2);
});

test('makes no network call when auto-check is off', async (t) => {
  const file = withStateFile(t);
  writeState(file, { ...DEFAULT_STATE, autoCheck: false });
  let requests = 0;
  const fetch = async () => {
    requests += 1;
    return new Response('[]');
  };
  const check = async () => {
    await fetch();
    return CURRENT;
  };
  assert.equal(await checkOnStartup({ stateFile: file, now: NOW, check }), undefined);
  assert.equal(requests, 0);
});

test('falls back to defaults for an unreadable state file', (t) => {
  const file = withStateFile(t);
  writeFileSync(file, '{"autoCheck":"no","channel":"nightly","lastCheckAt":"x"');
  assert.deepEqual(readState(file), DEFAULT_STATE);
  writeFileSync(file, JSON.stringify({ autoCheck: false, channel: 'nightly', lastCheckAt: 'x' }));
  assert.deepEqual(readState(file), { ...DEFAULT_STATE, autoCheck: false });
});
