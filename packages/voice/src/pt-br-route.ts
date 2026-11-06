import { mlxAudioSupported } from './mlx-audio-engine.ts';

export type PtBrRoute = 'mlx' | 'onnx';

export const PT_BR_ROUTE_ENV = 'RPG_PT_BR_ROUTE';

const ONNX_ONLY = 'onnx';

export const choosePtBrRoute = (
  platform: string = process.platform,
  arch: string = process.arch,
  env: NodeJS.ProcessEnv = process.env,
): PtBrRoute => (env[PT_BR_ROUTE_ENV] !== ONNX_ONLY && mlxAudioSupported(platform, arch) ? 'mlx' : 'onnx');
