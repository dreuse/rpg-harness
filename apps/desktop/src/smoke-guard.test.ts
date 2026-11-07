import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { EPIPE_CODE, FAILURE_EXIT, guardRenderer, guardSmokeProcess, QUIET_EXIT } from './smoke-guard.ts';

const fakeProcess = () => {
  const stderr: string[] = [];
  const proc = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: Object.assign(new EventEmitter(), { write: (text: string) => stderr.push(text) }),
  });
  const exits: number[] = [];
  guardSmokeProcess(proc, (code) => exits.push(code));
  return { proc, stderr, exits };
};

test('stdout EPIPE exits quietly', () => {
  const { proc, stderr, exits } = fakeProcess();
  proc.stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: EPIPE_CODE }));
  assert.deepEqual(exits, [QUIET_EXIT]);
  assert.deepEqual(stderr, []);
});

test('other stdout errors exit non-zero with the error on stderr', () => {
  const { proc, stderr, exits } = fakeProcess();
  proc.stdout.emit('error', new Error('disk on fire'));
  assert.deepEqual(exits, [FAILURE_EXIT]);
  assert.match(stderr.join(''), /disk on fire/);
});

test('uncaught exception exits non-zero with the error on stderr', () => {
  const { proc, stderr, exits } = fakeProcess();
  proc.emit('uncaughtException', new Error('boom'));
  assert.deepEqual(exits, [FAILURE_EXIT]);
  assert.match(stderr.join(''), /boom/);
});

test('a real closed stdout reader ends the process without an uncaught exception', async () => {
  const script = `
    import { guardSmokeProcess } from ${JSON.stringify(new URL('./smoke-guard.ts', import.meta.url).href)};
    guardSmokeProcess(process, (code) => process.exit(code));
    setTimeout(() => { for (let i = 0; i < 1000; i++) process.stdout.write('x'.repeat(1000)); }, 300);
    setTimeout(() => process.exit(99), 5000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  child.stdout.destroy();
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, QUIET_EXIT, stderr);
  assert.doesNotMatch(stderr, /Uncaught|EPIPE/);
});

const fakeRenderer = () => {
  const contents = new EventEmitter();
  const stderr: string[] = [];
  const exits: number[] = [];
  guardRenderer(
    contents,
    (text) => stderr.push(text),
    (code) => exits.push(code),
  );
  return { contents, stderr, exits };
};

test('a renderer console error exits non-zero with the message on stderr', () => {
  const { contents, stderr, exits } = fakeRenderer();
  contents.emit('console-message', { level: 'error', message: 'Cannot set properties of null' });
  assert.deepEqual(exits, [FAILURE_EXIT]);
  assert.match(stderr.join(''), /Cannot set properties of null/);
});

test('renderer info and warning messages do not fail the run', () => {
  const { contents, exits } = fakeRenderer();
  contents.emit('console-message', { level: 'info', message: 'hello' });
  contents.emit('console-message', { level: 'warning', message: 'hmm' });
  assert.deepEqual(exits, []);
});

test('a gone render process exits non-zero with the reason on stderr', () => {
  const { contents, stderr, exits } = fakeRenderer();
  contents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.deepEqual(exits, [FAILURE_EXIT]);
  assert.match(stderr.join(''), /crashed/);
});

test('a failed page load exits non-zero with the description on stderr', () => {
  const { contents, stderr, exits } = fakeRenderer();
  contents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'app://rpg/index.html', true);
  assert.deepEqual(exits, [FAILURE_EXIT]);
  assert.match(stderr.join(''), /ERR_FILE_NOT_FOUND/);
});

test('a preload error exits non-zero with the error on stderr', () => {
  const { contents, stderr, exits } = fakeRenderer();
  contents.emit('preload-error', {}, '/tmp/preload.cjs', new Error('bridge broke'));
  assert.deepEqual(exits, [FAILURE_EXIT]);
  assert.match(stderr.join(''), /bridge broke/);
});
