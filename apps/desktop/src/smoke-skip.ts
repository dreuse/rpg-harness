export const SKIP_ELECTRON_SMOKE_ENV = 'RPG_SKIP_ELECTRON_SMOKE';
export const ELECTRON_INSTALL_COMMAND = 'node node_modules/electron/install.js';
const OPT_OUT = '1';
const LINUX = 'linux';

export type SmokeSkipInput = {
  binary: string | undefined;
  platform: string;
  display: string | undefined;
  env: NodeJS.ProcessEnv;
};

export const smokeSkip = ({ binary, platform, display, env }: SmokeSkipInput) => {
  if (binary === undefined) {
    return env[SKIP_ELECTRON_SMOKE_ENV] === OPT_OUT
      ? { skip: `Electron smoke skipped by ${SKIP_ELECTRON_SMOKE_ENV}=${OPT_OUT}`, failure: undefined }
      : {
          skip: 'Electron binary is not installed',
          failure: `Electron binary is not installed; run "${ELECTRON_INSTALL_COMMAND}" in apps/desktop, or set ${SKIP_ELECTRON_SMOKE_ENV}=${OPT_OUT} to skip`,
        };
  }
  const noDisplay = platform === LINUX && !display;
  return { skip: noDisplay ? 'no display for Electron (run under xvfb-run)' : (false as const), failure: undefined };
};
