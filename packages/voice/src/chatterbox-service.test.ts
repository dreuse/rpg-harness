import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { CHATTERBOX_SERVICE_SOURCE, CHATTERBOX_VOICE } from './chatterbox-engine.ts';

const PYTHON = 'python3';
const probe = spawnSync(PYTHON, ['--version']);
const PYTHON_AVAILABLE = probe.status === 0;

const parsed = (request: unknown): unknown => {
  const result = spawnSync(
    PYTHON,
    [
      '-I',
      '-B',
      '-c',
      `import importlib.util as u, json, sys
spec = u.spec_from_file_location('service', ${JSON.stringify(CHATTERBOX_SERVICE_SOURCE)})
service = u.module_from_spec(spec)
spec.loader.exec_module(service)
print(json.dumps(service.parse(sys.stdin.read())))`,
    ],
    { input: JSON.stringify(request) },
  );
  assert.equal(result.status, 0, result.stderr.toString());
  return JSON.parse(result.stdout.toString());
};

const VALID = { text: 'Olá, mundo.', voice: CHATTERBOX_VOICE, exaggeration: 0.7, cfg_weight: 0.3 };

describe('chatterbox service request validation', {
  skip: PYTHON_AVAILABLE ? false : 'python3 is not installed',
}, () => {
  it('accepts a valid request', () => {
    assert.deepEqual(parsed(VALID), ['Olá, mundo.', 0.7, 0.3]);
  });

  it('rejects an unknown voice, empty or oversized text and out-of-range or non-numeric settings', () => {
    const bad = [
      { ...VALID, voice: '../../etc/passwd' },
      { ...VALID, text: '   ' },
      { ...VALID, text: 'a'.repeat(2001) },
      { ...VALID, exaggeration: 5 },
      { ...VALID, exaggeration: true },
      { ...VALID, cfg_weight: -0.1 },
      { ...VALID, cfg_weight: '0.3' },
    ];
    for (const request of bad) assert.equal(parsed(request), null, JSON.stringify(request));
  });

  it('picks cuda, then mps, then cpu', () => {
    const devices = [
      [true, true, 'cuda'],
      [false, true, 'mps'],
      [false, false, 'cpu'],
    ] as const;
    for (const [cuda, mps, expected] of devices) {
      const result = spawnSync(
        PYTHON,
        [
          '-I',
          '-B',
          '-c',
          `import importlib.util as u, sys, types
sys.modules['torch'] = types.SimpleNamespace(
    cuda=types.SimpleNamespace(is_available=lambda: ${cuda ? 'True' : 'False'}),
    backends=types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: ${mps ? 'True' : 'False'})),
)
spec = u.spec_from_file_location('service', ${JSON.stringify(CHATTERBOX_SERVICE_SOURCE)})
service = u.module_from_spec(spec)
spec.loader.exec_module(service)
print(service.pick_device())`,
        ],
        { encoding: 'utf8' },
      );
      assert.equal(result.stdout.trim(), expected, result.stderr);
    }
  });
});
