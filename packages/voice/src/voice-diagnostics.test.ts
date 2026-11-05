import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVoiceDiagnostics } from './voice-diagnostics.ts';

const CAMPAIGN_TEXT = 'The dragon Vyrnax guards the vault under Emberfall';

test('rpg-cm63.7 diagnostics report median first audio, cache hit rate, errors and stage times', () => {
  const diagnostics = createVoiceDiagnostics();
  diagnostics.record({ firstAudioMs: 300, cacheHit: false, stages: { synthesis: 200, transfer: 40, decode: 60 } });
  diagnostics.record({ firstAudioMs: 100, cacheHit: true, stages: { synthesis: 0, transfer: 40, decode: 60 } });
  diagnostics.record({ firstAudioMs: 200, cacheHit: false, stages: { synthesis: 120, transfer: 20, decode: 60 } });
  diagnostics.fail(Object.assign(new Error('slow'), { name: 'TimeoutError' }));
  diagnostics.fail(new Error('boom'));

  assert.deepEqual(diagnostics.summary(), {
    samples: 3,
    firstAudioMs: 200,
    cacheHitRate: 1 / 3,
    errors: { timeout: 1, 'provider-error': 1 },
    stages: { synthesis: 120, transfer: 40, decode: 60 },
  });
});

test('rpg-cm63.7 diagnostics start empty and reset to empty', () => {
  const diagnostics = createVoiceDiagnostics();
  const empty = { samples: 0, cacheHitRate: 0, errors: {}, stages: {} };
  assert.deepEqual(diagnostics.summary(), empty);
  diagnostics.record({ firstAudioMs: 10, cacheHit: true, stages: { decode: 5 } });
  diagnostics.reset();
  assert.deepEqual(diagnostics.summary(), empty);
});

test('rpg-cm63.7 diagnostics never carry campaign text from samples or errors', () => {
  const diagnostics = createVoiceDiagnostics();
  const leaky = {
    firstAudioMs: 90,
    cacheHit: false,
    stages: { synthesis: 80, [CAMPAIGN_TEXT]: 1 },
    text: CAMPAIGN_TEXT,
  };
  diagnostics.record(leaky as never);
  diagnostics.record({ firstAudioMs: CAMPAIGN_TEXT, cacheHit: CAMPAIGN_TEXT, stages: CAMPAIGN_TEXT } as never);
  diagnostics.fail(Object.assign(new Error(CAMPAIGN_TEXT), { name: CAMPAIGN_TEXT, text: CAMPAIGN_TEXT }));
  diagnostics.fail(CAMPAIGN_TEXT);

  const summary = JSON.stringify(diagnostics.summary());
  assert.doesNotMatch(summary, /dragon|Vyrnax|Emberfall/);
  assert.deepEqual(diagnostics.summary(), {
    samples: 1,
    firstAudioMs: 90,
    cacheHitRate: 0,
    errors: { 'provider-error': 2 },
    stages: { synthesis: 80 },
  });
});
