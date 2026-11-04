import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const SCOPE = '@rpg/';
const WORKSPACE_DIRS = ['packages', 'apps'];
const APPS_DIR = 'apps';

const ALLOWED_IMPORTS: Record<string, readonly string[]> = {
  domain: [],
  rules: ['domain'],
  engine: ['domain', 'rules'],
  persistence: ['domain'],
  memory: ['domain'],
  narrative: ['domain', 'memory'],
  world: ['domain'],
  imports: ['domain', 'rules'],
  'client-protocol': ['domain'],
  voice: ['client-protocol'],
  mcp: ['domain', 'persistence'],
  testkit: ['domain'],
};

type Manifest = { name: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

function workspaceManifests(): { dir: string; manifest: Manifest }[] {
  return WORKSPACE_DIRS.flatMap((dir) => {
    const base = join(ROOT, dir);
    if (!existsSync(base)) return [];
    return readdirSync(base)
      .map((name) => join(base, name, 'package.json'))
      .filter(existsSync)
      .map((path) => ({ dir, manifest: JSON.parse(readFileSync(path, 'utf8')) as Manifest }));
  });
}

function internalDeps(manifest: Manifest): string[] {
  return Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter((dep) => dep.startsWith(SCOPE))
    .map((dep) => dep.slice(SCOPE.length));
}

function violations(entries: { dir: string; manifest: Manifest }[]): string[] {
  return entries
    .filter(({ dir }) => dir !== APPS_DIR)
    .flatMap(({ manifest }) => {
      const allowed = ALLOWED_IMPORTS[manifest.name.slice(SCOPE.length)];
      if (!allowed) return [`${manifest.name} missing from docs/product/p02-engine-boundaries.md table`];
      return internalDeps(manifest)
        .filter((dep) => !allowed.includes(dep))
        .map((dep) => `${manifest.name} may not depend on ${SCOPE}${dep}`);
    });
}

test('workspace packages follow the module table', () => {
  assert.deepEqual(violations(workspaceManifests()), []);
});

test('rejects a forbidden dependency and an unlisted package', () => {
  const found = violations([
    { dir: 'packages', manifest: { name: '@rpg/narrative', dependencies: { '@rpg/persistence': '*' } } },
    { dir: 'packages', manifest: { name: '@rpg/unknown' } },
    { dir: 'apps', manifest: { name: '@rpg/cli', dependencies: { '@rpg/persistence': '*' } } },
  ]);
  assert.deepEqual(found, [
    '@rpg/narrative may not depend on @rpg/persistence',
    '@rpg/unknown missing from docs/product/p02-engine-boundaries.md table',
  ]);
});
