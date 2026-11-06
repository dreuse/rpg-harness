import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ELECTRON_INSTALL_COMMAND, SKIP_ELECTRON_SMOKE_ENV, smokeSkip } from './smoke-skip.ts';

const BINARY = '/electron';
const DISPLAY = ':0';

test('rpg-42a.119 missing binary without opt-out fails and names the install command', () => {
  const result = smokeSkip({ binary: undefined, platform: 'darwin', display: undefined, env: {} });
  assert.match(result.failure ?? '', new RegExp(ELECTRON_INSTALL_COMMAND.replaceAll('.', '\\.')));
});

test('rpg-42a.119 missing binary with opt-out skips with a reason and no failure', () => {
  const result = smokeSkip({
    binary: undefined,
    platform: 'darwin',
    display: undefined,
    env: { [SKIP_ELECTRON_SMOKE_ENV]: '1' },
  });
  assert.equal(result.failure, undefined);
  assert.match(String(result.skip), new RegExp(SKIP_ELECTRON_SMOKE_ENV));
});

test('rpg-42a.119 Linux without display skips; with display runs', () => {
  assert.match(String(smokeSkip({ binary: BINARY, platform: 'linux', display: undefined, env: {} }).skip), /display/);
  assert.deepEqual(smokeSkip({ binary: BINARY, platform: 'linux', display: DISPLAY, env: {} }), {
    skip: false,
    failure: undefined,
  });
});
