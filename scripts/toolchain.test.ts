import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
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
