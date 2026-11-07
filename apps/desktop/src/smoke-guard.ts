export const EPIPE_CODE = 'EPIPE';
export const QUIET_EXIT = 0;
export const FAILURE_EXIT = 1;

type Emitter = { on: (event: string, listener: (error: Error) => void) => unknown };
type GuardedProcess = Emitter & { stdout: Emitter; stderr: Emitter & { write: (text: string) => unknown } };

export const guardSmokeProcess = (proc: GuardedProcess, exit: (code: number) => void) => {
  const fail = (error: Error) => {
    proc.stderr.write(`${error.stack ?? error.message}\n`);
    exit(FAILURE_EXIT);
  };
  const onStreamError = (error: Error) =>
    (error as NodeJS.ErrnoException).code === EPIPE_CODE ? exit(QUIET_EXIT) : fail(error);
  proc.stdout.on('error', onStreamError);
  proc.stderr.on('error', onStreamError);
  proc.on('uncaughtException', fail);
};

const ERROR_LEVEL = 'error';

type RendererEvents = { on: (event: string, listener: (...args: any[]) => void) => unknown };

export const guardRenderer = (
  contents: RendererEvents,
  write: (text: string) => unknown,
  exit: (code: number) => void,
) => {
  const fail = (message: string) => {
    write(`renderer error: ${message}\n`);
    exit(FAILURE_EXIT);
  };
  contents.on('console-message', (event: { level: string; message: string }) => {
    if (event.level === ERROR_LEVEL) fail(event.message);
  });
  contents.on('render-process-gone', (_event: unknown, details: { reason: string }) => fail(details.reason));
  contents.on('did-fail-load', (_event: unknown, _code: number, description: string, url: string) =>
    fail(`${description} ${url}`),
  );
  contents.on('preload-error', (_event: unknown, path: string, error: Error) => fail(`${path} ${error.message}`));
};
