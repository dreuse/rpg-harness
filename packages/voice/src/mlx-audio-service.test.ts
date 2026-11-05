import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SERVICE = fileURLToPath(new URL('./mlx-audio-service.py', import.meta.url));
const PYTHON = 'python3';
const STOPPED = 'stopped';
const POLL_SECONDS = 0.01;
const probe = spawnSync(PYTHON, ['--version']);
const PYTHON_AVAILABLE = probe.status === 0;

const run = (body: string) =>
  spawnSync(PYTHON, [
    '-I',
    '-B',
    '-c',
    `import importlib.util as u, os
spec = u.spec_from_file_location('service', ${JSON.stringify(SERVICE)})
service = u.module_from_spec(spec)
spec.loader.exec_module(service)
${body}`,
  ]);

describe('mlx audio service parent watchdog', { skip: PYTHON_AVAILABLE ? false : 'python3 is not installed' }, () => {
  it('stops the service when the parent pid changes', () => {
    const result = run(`service.exit_when_orphaned(os.getppid() + 1, lambda: print('${STOPPED}'), ${POLL_SECONDS})`);
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(result.stdout.toString().trim(), STOPPED);
  });

  it('keeps polling while the parent is unchanged', () => {
    const result = run(
      `calls = []
def parent():
    calls.append(1)
    return os.getppid() if len(calls) < 3 else -1
service.exit_when_orphaned(os.getppid(), lambda: print(len(calls)), ${POLL_SECONDS}, parent)`,
    );
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(result.stdout.toString().trim(), '3');
  });
});
