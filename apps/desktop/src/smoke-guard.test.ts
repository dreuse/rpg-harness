import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { EPIPE_CODE, FAILURE_EXIT, guardSmokeProcess, QUIET_EXIT } from './smoke-guard.ts';

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
