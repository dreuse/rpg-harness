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
