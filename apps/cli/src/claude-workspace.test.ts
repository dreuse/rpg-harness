import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { CLAUDE_WORKSPACE_DIR, ensureClaudeWorkspace, WORKSPACE_SKILLS } from './claude-workspace.ts';
import { createEngineGateway } from './engine-gateway.ts';
import { CLAUDE_BIN, CLAUDE_BIN_ENV } from './gm-api.ts';
import { launchClaude } from './gm-claude-code.ts';

const PRIVATE_DIR_BITS = 0o777;
const PRIVATE_DIR_MODE = 0o700;
const REPO_SKILLS = join(import.meta.dirname, '../../../.claude/skills');
const SKILL_FILE = 'SKILL.md';
const STALE_FILE = 'stale.md';
const CAMPAIGN_DATABASE = '/data/My Campaign.sqlite';
const FAILURE_EXIT = 3;

const sandbox = (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), 'rpg-workspace-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const treeOf = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();

const FAKE_INTERACTIVE = (exitCode: number) => `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(__dirname, 'call.json'), JSON.stringify({ args: process.argv.slice(2), env: process.env, cwd: process.cwd() }));
process.exitCode = ${exitCode};
`;

const fakeInteractive = (t: TestContext, exitCode = 0) => {
  const dir = sandbox(t);
  const bin = join(dir, CLAUDE_BIN);
  writeFileSync(bin, FAKE_INTERACTIVE(exitCode));
  chmodSync(bin, 0o755);
  const call = () =>
    JSON.parse(readFileSync(join(dir, 'call.json'), 'utf8')) as {
      args: string[];
      env: Record<string, string>;
      cwd: string;
    };
  return { bin, call };
};

describe('rpg-42a.47 Claude Code workspace', () => {
  it('creates a private workspace with the project files and the rpg skills', (t) => {
    const workspace = join(sandbox(t), CLAUDE_WORKSPACE_DIR);
    ensureClaudeWorkspace(workspace);
    assert.equal(statSync(workspace).mode & PRIVATE_DIR_BITS, PRIVATE_DIR_MODE);
    assert.ok(existsSync(join(workspace, 'CLAUDE.md')));
    assert.deepEqual(JSON.parse(readFileSync(join(workspace, '.mcp.json'), 'utf8')), { mcpServers: {} });
    for (const skill of WORKSPACE_SKILLS)
      assert.equal(
        readFileSync(join(workspace, '.claude', 'skills', skill, SKILL_FILE), 'utf8'),
        readFileSync(join(REPO_SKILLS, skill, SKILL_FILE), 'utf8'),
      );
    assert.deepEqual(WORKSPACE_SKILLS, ['rpg-gm', 'rpg-scene']);
  });

  it('is idempotent and leaves matching files untouched', (t) => {
    const workspace = join(sandbox(t), CLAUDE_WORKSPACE_DIR);
    ensureClaudeWorkspace(workspace);
    const before = treeOf(workspace).map((file) => [file, statSync(file).mtimeMs]);
    ensureClaudeWorkspace(workspace);
    assert.deepEqual(
      treeOf(workspace).map((file) => [file, statSync(file).mtimeMs]),
      before,
    );
  });

  it('refreshes an older workspace and drops files the new version no longer ships', (t) => {
    const workspace = join(sandbox(t), CLAUDE_WORKSPACE_DIR);
    ensureClaudeWorkspace(workspace);
    const skill = join(workspace, '.claude', 'skills', 'rpg-gm', SKILL_FILE);
    const marker = treeOf(workspace).find((file) => file.endsWith('.rpg-workspace-version')) ?? '';
    assert.ok(marker !== '');
    writeFileSync(skill, 'old version');
    writeFileSync(join(workspace, '.claude', 'skills', 'rpg-gm', STALE_FILE), 'stale');
    writeFileSync(marker, 'older-digest');
    ensureClaudeWorkspace(workspace);
    assert.equal(readFileSync(skill, 'utf8'), readFileSync(join(REPO_SKILLS, 'rpg-gm', SKILL_FILE), 'utf8'));
    assert.ok(!existsSync(join(workspace, '.claude', 'skills', 'rpg-gm', STALE_FILE)));
  });

  it('refresh never follows a symlinked .claude out of the workspace', (t) => {
    const workspace = join(sandbox(t), CLAUDE_WORKSPACE_DIR);
    ensureClaudeWorkspace(workspace);
    const marker = join(workspace, '.rpg-workspace-version');
    const outside = sandbox(t);
    const mine = join(outside, 'skills', 'mine', SKILL_FILE);
    mkdirSync(join(outside, 'skills', 'mine'), { recursive: true });
    writeFileSync(mine, 'mine');
    rmSync(join(workspace, '.claude'), { recursive: true });
    symlinkSync(outside, join(workspace, '.claude'));
    writeFileSync(marker, 'older-digest');
    ensureClaudeWorkspace(workspace);
    assert.equal(readFileSync(mine, 'utf8'), 'mine');
    assert.deepEqual(readdirSync(join(outside, 'skills')), ['mine']);
    assert.ok(!lstatSync(join(workspace, '.claude')).isSymbolicLink());
    for (const skill of WORKSPACE_SKILLS)
      assert.ok(existsSync(join(workspace, '.claude', 'skills', skill, SKILL_FILE)));
  });

  it('refreshes when a managed file changed on disk even if the marker matches', (t) => {
    const workspace = join(sandbox(t), CLAUDE_WORKSPACE_DIR);
    ensureClaudeWorkspace(workspace);
    const claudeMd = join(workspace, 'CLAUDE.md');
    const original = readFileSync(claudeMd, 'utf8');
    writeFileSync(claudeMd, 'tampered');
    ensureClaudeWorkspace(workspace);
    assert.equal(readFileSync(claudeMd, 'utf8'), original);
  });

  it('rpg claude opens interactive claude in the workspace with the game server for the campaign', (t) => {
    const { bin, call } = fakeInteractive(t);
    const dataDir = sandbox(t);
    const env = {
      PATH: '/usr/bin',
      HOME: dataDir,
      TERM: 'xterm',
      ANTHROPIC_API_KEY: 'sk-never',
      [CLAUDE_BIN_ENV]: bin,
    };
    assert.equal(launchClaude(env, dataDir, CAMPAIGN_DATABASE), 0);
    const { args, cwd, env: childEnv } = call();
    assert.equal(cwd, realpathSync(join(dataDir, CLAUDE_WORKSPACE_DIR)));
    assert.deepEqual(args.slice(0, 2), ['--setting-sources', 'project']);
    const config = JSON.parse(args[args.indexOf('--mcp-config') + 1] ?? '');
    assert.equal(config.mcpServers.rpg.env.RPG_DATABASE_PATH, CAMPAIGN_DATABASE);
    assert.equal(childEnv.TERM, 'xterm');
    assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
    assert.ok(!args.some((arg) => /dangerously|bypassPermissions/.test(arg)));
  });

  it('rpg claude without a campaign passes no game server and returns the exit code', (t) => {
    const { bin, call } = fakeInteractive(t, FAILURE_EXIT);
    const dataDir = sandbox(t);
    const env = { PATH: '/usr/bin', [CLAUDE_BIN_ENV]: bin };
    assert.equal(launchClaude(env, dataDir), FAILURE_EXIT);
    assert.deepEqual(call().args, ['--setting-sources', 'project']);
  });

  it('rpg claude says so when claude is not installed', (t) => {
    assert.throws(() => launchClaude({ PATH: '', [CLAUDE_BIN_ENV]: '' }, sandbox(t)), /Claude Code was not found/);
  });

  it('rpg claude refuses a campaign that does not exist', (t) => {
    assert.throws(() => createEngineGateway(sandbox(t)).claude('Nowhere'), /Nowhere/);
  });

  it('writes nothing under HOME/.claude or CLAUDE_CONFIG_DIR', (t) => {
    const { bin } = fakeInteractive(t);
    const home = sandbox(t);
    const configDir = sandbox(t);
    const dataDir = sandbox(t);
    launchClaude({ HOME: home, CLAUDE_CONFIG_DIR: configDir, [CLAUDE_BIN_ENV]: bin }, dataDir, CAMPAIGN_DATABASE);
    ensureClaudeWorkspace(join(dataDir, CLAUDE_WORKSPACE_DIR));
    assert.deepEqual(readdirSync(home), []);
    assert.deepEqual(readdirSync(configDir), []);
  });
});
