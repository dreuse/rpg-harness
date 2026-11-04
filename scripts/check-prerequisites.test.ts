import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPrerequisites, formatReport } from './check-prerequisites.ts';

const READY = { nodeVersion: 'v24.0.0', pnpmVersion: '11.7.0', hasSqlite: true };
const FLAKY = ['packages/example/src/slow.test.ts'];

test('known flaky or missing prerequisite is surfaced, not silently ignored', () => {
  const broken = checkPrerequisites({ nodeVersion: 'v22.9.0', pnpmVersion: undefined, hasSqlite: false }, FLAKY);
  assert.equal(broken.ok, false);
  assert.deepEqual(broken.missing, ['node>=24 (found v22.9.0)', 'pnpm', 'node:sqlite']);
  assert.deepEqual(broken.flaky, FLAKY);
  const text = formatReport(broken);
  assert.match(text, /missing prerequisite: node>=24 \(found v22\.9\.0\)/);
  assert.match(text, /missing prerequisite: pnpm/);
  assert.match(text, /missing prerequisite: node:sqlite/);
  assert.match(text, /known flaky: packages\/example\/src\/slow\.test\.ts/);
});

test('ready toolchain passes and still reports known flaky tests', () => {
  const ready = checkPrerequisites(READY, FLAKY);
  assert.deepEqual(ready, { ok: true, missing: [], flaky: FLAKY });
  assert.match(formatReport(ready), /known flaky/);
});
