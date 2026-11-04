import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createScriptedRng } from '../packages/testkit/src/fixtures.ts';

const ROOT = join(import.meta.dirname, '..');
const CI_STEPS = [
  'pnpm check:prereqs',
  'pnpm typecheck',
  'pnpm lint',
  'pnpm test',
  'pnpm test:integration',
  'pnpm build',
];
const FIXTURE_DRAW = 0.25;
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

test('package.json pins node and pnpm prerequisites', () => {
  const manifest = JSON.parse(read('package.json'));
  assert.match(manifest.engines.node, /^>=\d+/);
  assert.match(manifest.engines.pnpm, /^>=\d+/);
  assert.match(manifest.packageManager, /^pnpm@\d+\.\d+\.\d+$/);
});

test('pnpm refuses to install on an unsupported toolchain', () => {
  assert.match(read('pnpm-workspace.yaml'), /^engineStrict: true$/m);
});

test('quality profile scripts exist', () => {
  const { scripts } = JSON.parse(read('package.json'));
  for (const name of ['typecheck', 'lint', 'format', 'test', 'build']) {
    assert.ok(scripts[name], `missing script ${name}`);
  }
});

test('build deterministic fixtures and continuous tests for types, lint, unit and integration', () => {
  const { scripts } = JSON.parse(read('package.json'));
  assert.match(scripts['test:integration'], /^node --test "packages\/\*\/src\/\*\*\/\*\.integration\.test\.ts"$/);
  assert.match(scripts.test, /"packages\/\*\/src\/\*\*\/\*\.test\.ts"/);
  assert.match(scripts['check:prereqs'], /scripts\/check-prerequisites\.ts/);
  const workflow = read('.github/workflows/ci.yml');
  for (const step of CI_STEPS) assert.match(workflow, new RegExp(`- run: ${step}$`, 'm'), `ci.yml misses ${step}`);
  const values = [FIXTURE_DRAW];
  assert.deepEqual([createScriptedRng(values)(), createScriptedRng(values)()], [FIXTURE_DRAW, FIXTURE_DRAW]);
});
