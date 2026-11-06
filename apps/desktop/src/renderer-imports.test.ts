import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';

const RENDERER_ENTRY = resolve(import.meta.dirname, 'page.ts');
const VALUE_IMPORT = /^(?:import|export)\s+(?!type\b)(?:[^;]*?\sfrom\s+)?'([^']+)'/gms;
const RELATIVE = '.';
const NODE_BUILTIN = 'node:';
const TEXT = 'utf8';

const nodeImportsFrom = (entry: string) => {
  const seen = new Set<string>();
  const found: string[] = [];
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const [, specifier] of readFileSync(file, TEXT).matchAll(VALUE_IMPORT)) {
      if (specifier === undefined) continue;
      if (specifier.startsWith(NODE_BUILTIN)) found.push(`${file} -> ${specifier}`);
      else if (specifier.startsWith(RELATIVE)) visit(resolve(dirname(file), specifier));
    }
  };
  visit(entry);
  return found;
};

test('the desktop renderer loads no Node built-in module', () => {
  assert.deepEqual(nodeImportsFrom(RENDERER_ENTRY), []);
});
