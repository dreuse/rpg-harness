import { basename, dirname } from 'node:path';
import { REPLY_HINT } from '../../../packages/imports/src/workflow.ts';
import { BUILT_IN_PACKS, importRules } from '../../cli/src/import-gateway.ts';
import { stageOwnRules } from '../../cli/src/own-rules-files.ts';
import type { ImportRequest, ImportResult } from './preload.ts';

export const NO_PENDING_IMPORT = 'No import is waiting for a decision.';
export const MIXED_FOLDERS = 'Pick files from one folder.';
export const BAD_IMPORT_REQUEST = 'The import request is not valid.';
const LINE_BREAK = '\n';
const USE = 'use';
const REFUSED = 'Activation refused';
const DRY_RUN = 'decline';
const ADDED_RULES_FILES = 'Added rules files: ';
const ADDED_SETTING_FILES = 'Added setting files: ';

export type ImportHostOptions = {
  readonly dataDir: string;
  readonly showOpenDialog: () => Promise<readonly string[]>;
};
type Pending = { readonly root: string; readonly files: readonly string[]; readonly packId: string };

const failed = (...lines: string[]): ImportResult => ({ status: 'failed', lines });

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const readRequest = (request: unknown): ImportRequest | undefined => {
  if (typeof request !== 'object' || request === null) return undefined;
  const { kind, packId, decision } = request as Record<string, unknown>;
  if (kind === 'pick' && typeof packId === 'string') return { kind, packId };
  if (kind === 'decide' && (decision === 'activate' || decision === 'decline')) return { kind, decision };
  if (kind === 'pickOwn' || kind === 'pickSetting') return { kind };
  return undefined;
};

const reportOf = (text: string | undefined) => (text ?? '').split(LINE_BREAK).filter((line) => line !== REPLY_HINT);

export const createImportHost = ({ dataDir, showOpenDialog }: ImportHostOptions) => {
  let pending: Pending | undefined;

  const converse = async ({ root, files, packId }: Pending, reply: string) => {
    const replies = (async function* () {
      yield `${USE} ${packId}`;
      yield reply;
    })();
    const lines: string[] = [];
    try {
      for await (const line of importRules(root, files, replies, dataDir)) lines.push(line);
    } catch (error) {
      return { error: messageOf(error), lines };
    }
    return { lines };
  };

  const pick = async (packId: string): Promise<ImportResult> => {
    if (!BUILT_IN_PACKS.some(({ id }) => id === packId)) return failed(`Rule pack ${packId} is not installed.`);
    const paths = await showOpenDialog();
    const [first] = paths;
    if (first === undefined) return { status: 'cancelled' };
    const root = dirname(first);
    if (paths.some((path) => dirname(path) !== root)) return failed(MIXED_FOLDERS);
    const next = { root, files: paths.map((path) => basename(path)), packId };
    const { error, lines } = await converse(next, DRY_RUN);
    if (error !== undefined) return failed(error);
    pending = next;
    return { status: 'preview', lines: reportOf(lines.at(-2)) };
  };

  let rulesNames: readonly string[] = [];
  let settingNames: readonly string[] = [];

  const pickOwn = async (kind: 'pickOwn' | 'pickSetting'): Promise<ImportResult> => {
    const paths = await showOpenDialog();
    const [first] = paths;
    if (first === undefined) return { status: 'cancelled' };
    const root = dirname(first);
    if (paths.some((path) => dirname(path) !== root)) return failed(MIXED_FOLDERS);
    try {
      const { names } = stageOwnRules(
        dataDir,
        root,
        paths.map((path) => basename(path)),
        kind === 'pickOwn' ? settingNames : rulesNames,
      );
      if (kind === 'pickSetting') {
        settingNames = names;
        return { status: 'settingFiles', names, lines: [`${ADDED_SETTING_FILES}${names.join(', ')}`] };
      }
      rulesNames = names;
      return { status: 'ownFiles', names, lines: [`${ADDED_RULES_FILES}${names.join(', ')}`] };
    } catch (error) {
      return failed(messageOf(error));
    }
  };

  const decide = async (decision: 'activate' | 'decline'): Promise<ImportResult> => {
    if (pending === undefined) return failed(NO_PENDING_IMPORT);
    const { error, lines } = await converse(pending, decision);
    if (error !== undefined)
      return failed(...lines.filter((line) => line.startsWith(REFUSED)).flatMap(reportOf), error);
    pending = undefined;
    return { status: decision === 'activate' ? 'installed' : 'declined', lines: reportOf(lines.at(-1)) };
  };

  return {
    run: async (input: unknown): Promise<ImportResult> => {
      const request = readRequest(input);
      if (request === undefined) return failed(BAD_IMPORT_REQUEST);
      if (request.kind === 'pickOwn' || request.kind === 'pickSetting') return pickOwn(request.kind);
      return request.kind === 'pick' ? pick(request.packId) : decide(request.decision);
    },
  };
};
