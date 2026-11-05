import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateManifest } from '../packages/rules/src/rulepack.ts';

const ROOT = join(import.meta.dirname, '..');
const DOC = join(ROOT, 'docs', 'product', 'q08-install-and-recovery.md');
const TEXT = 'utf8';
const SOURCE_DIRS = ['apps', 'packages'];
const SOURCE_FILE = /\.ts$/;
const TEST_FILE = /\.test\.ts$/;
const SKIPPED_DIRS = new Set(['node_modules', 'dist']);
const FENCE = /```(\w*)\n([\s\S]*?)```/g;
const PNPM_FILTER = /^pnpm --filter (\S+) (\S+)/;
const PNPM_SCRIPT = /^pnpm (?!--filter)(\S+)/;
const RPG_COMMAND = /^pnpm rpg (\S+)/;
const ENV_ASSIGNMENT = /(?:^|\s)([A-Z][A-Z0-9_]*(?:<[a-z-]+>[A-Z0-9_]*)*)=/gm;
const PLACEHOLDER = /<[a-z-]+>/;
const PATH_REFERENCE = /`((?:apps|packages|examples|docs|scripts)\/[\w./-]+)`/g;
const PNPM_BUILTINS = new Set(['install']);
const MIN_ENV_LENGTH = 4;
const SHELL_LANGS = new Set(['bash', 'sh']);
const API_KEY_HEADING = '## API-key desktop providers';
const SUBSCRIPTION_HEADING = '## Subscription-based Claude Code';
const REQUIRED_HEADINGS = [
  '## Clean install',
  '## RulePack authoring',
  '## Backup and recovery',
  '## Audio and desktop',
];

const doc = (): string => readFileSync(DOC, TEXT);
const json = (file: string): Record<string, unknown> => JSON.parse(readFileSync(join(ROOT, file), TEXT));

const blocks = (text: string) => [...text.matchAll(FENCE)].map(([, lang = '', body = '']) => ({ lang, body }));

const section = (text: string, heading: string): string => {
  const start = text.indexOf(`${heading}\n`);
  if (start < 0) return '';
  const rest = text.slice(start + heading.length);
  const next = rest.search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next);
};

const sources = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : sources(path);
    return SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name) ? [path] : [];
  });

const workspaceScripts = (): Map<string, Record<string, string>> => {
  const found = new Map<string, Record<string, string>>();
  for (const dir of ['apps']) {
    for (const app of readdirSync(join(ROOT, dir))) {
      const pkg = json(join(dir, app, 'package.json'));
      found.set(String(pkg.name), (pkg.scripts ?? {}) as Record<string, string>);
    }
  }
  return found;
};

const shellLines = (text: string): string[] =>
  blocks(text)
    .filter(({ lang }) => SHELL_LANGS.has(lang))
    .flatMap(({ body }) => body.split('\n'))
    .map((line) => line.replace(/^(?:[A-Z_]+=\S*\s+)+(?=pnpm)/, '').trim());

test('verify clean-install quickstart, rulepack authoring and backup and audio/desktop docs', () => {
  assert.ok(existsSync(DOC), 'docs/product/q08-install-and-recovery.md must exist');
  const text = doc();
  for (const heading of REQUIRED_HEADINGS) assert.ok(text.includes(`${heading}\n`), `missing ${heading}`);

  const rootScripts = json('package.json').scripts as Record<string, string>;
  const apps = workspaceScripts();
  const lines = shellLines(text);
  assert.ok(lines.some((line) => line === 'pnpm check:prereqs'));
  for (const line of lines) {
    const filtered = PNPM_FILTER.exec(line);
    if (filtered) {
      assert.ok(apps.get(filtered[1] ?? '')?.[filtered[2] ?? ''], `unknown workspace script: ${line}`);
      continue;
    }
    const script = PNPM_SCRIPT.exec(line)?.[1];
    if (script && !PNPM_BUILTINS.has(script)) assert.ok(rootScripts[script], `unknown pnpm script: ${line}`);
  }

  const cli = readFileSync(join(ROOT, 'apps', 'cli', 'src', 'main.ts'), TEXT);
  for (const line of lines) {
    const command = RPG_COMMAND.exec(line)?.[1];
    if (command) assert.ok(cli.includes(`name: '${command}'`), `unknown rpg command: ${line}`);
  }

  const code = SOURCE_DIRS.flatMap(sources)
    .map((file) => readFileSync(join(ROOT, file), TEXT))
    .join('\n');
  const names = new Set([
    ...blocks(text).flatMap(({ body }) => [...body.matchAll(ENV_ASSIGNMENT)].map((m) => m[1] ?? '')),
  ]);
  for (const name of names) {
    if (name.length < MIN_ENV_LENGTH) continue;
    for (const fragment of name.split(PLACEHOLDER).filter(Boolean)) {
      assert.ok(code.includes(fragment), `env fragment not read by code: ${fragment} in ${name}`);
    }
  }
  assert.ok(names.has('RPG_DATA_DIR') && names.has('RPG_CAMPAIGN'));

  for (const [, path = ''] of text.matchAll(PATH_REFERENCE)) {
    assert.ok(existsSync(join(ROOT, path)), `missing path: ${path}`);
  }

  for (const { lang, body } of blocks(text)) {
    if (lang === 'json') assert.equal(validateManifest(JSON.parse(body)).ok, true, 'RulePack example must validate');
  }
  assert.ok(blocks(text).some(({ lang }) => lang === 'json'));
});

test('instructions distinguish subscription-based claude code from api-key desktop providers', () => {
  const text = doc();
  const subscription = section(text, SUBSCRIPTION_HEADING);
  const apiKey = section(text, API_KEY_HEADING);
  assert.ok(subscription.includes('mcp'), 'subscription section must cover the MCP route');
  assert.ok(apiKey.includes('ANTHROPIC_API_KEY'));
  assert.ok(apiKey.includes('does not use a Claude login'));
  assert.doesNotMatch(apiKey, /subscription|oauth|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_AUTH_TOKEN/i);
  assert.match(subscription, /own machine|local/i);
});
