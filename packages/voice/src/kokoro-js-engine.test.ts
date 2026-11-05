import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createKokoroJsEngine } from './kokoro-js-engine.ts';

test('is not ready and refuses synthesis while no model is installed or loaded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kokoro-engine-'));
  try {
    const engine = createKokoroJsEngine(dir);
    assert.equal(engine.ready(), false);
    await assert.rejects(engine.synthesize('Hello.', 'af_heart', new AbortController().signal), /not loaded/);
    await engine.unload();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
