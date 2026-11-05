import assert from 'node:assert/strict';
import { decodeWav } from './delivery-shaping.ts';

const MS_PER_SECOND = 1000;

export const trailingSilenceMs = (audio: Uint8Array): number => {
  const wav = decodeWav(audio);
  assert.ok(wav);
  let silent = 0;
  while (silent < wav.samples.length && wav.samples[wav.samples.length - 1 - silent] === 0) silent += 1;
  return Math.round((silent * MS_PER_SECOND) / wav.sampleRate);
};
