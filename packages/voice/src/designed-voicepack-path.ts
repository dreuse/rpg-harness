import { join } from 'node:path';
import type { DesignedVoice } from './designed-voices.ts';

export const DESIGNED_VOICEPACK_DIR = join(import.meta.dirname, '..', 'voicepacks');

export const designedVoicepackPath = ({ file }: DesignedVoice): string => join(DESIGNED_VOICEPACK_DIR, file);

export const DESIGNED_MANIFEST_FILE = join(import.meta.dirname, 'designed-manifest.ts');
