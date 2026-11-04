import { execFileSync } from 'node:child_process';

const MIN_NODE_MAJOR = 24;
const SQLITE_MODULE = 'node:sqlite';
const PNPM = 'pnpm';
const FAILURE_EXIT_CODE = 1;

export const KNOWN_FLAKY: readonly string[] = [];

export type Probes = {
  readonly nodeVersion: string;
  readonly pnpmVersion: string | undefined;
  readonly hasSqlite: boolean;
};

export type Report = { readonly ok: boolean; readonly missing: string[]; readonly flaky: readonly string[] };

const nodeMajor = (version: string) => Number.parseInt(version.replace(/^v/, ''), 10);

export const checkPrerequisites = (probes: Probes, flaky: readonly string[] = KNOWN_FLAKY): Report => {
  const missing = [
    ...(nodeMajor(probes.nodeVersion) >= MIN_NODE_MAJOR
      ? []
      : [`node>=${MIN_NODE_MAJOR} (found ${probes.nodeVersion})`]),
    ...(probes.pnpmVersion ? [] : [PNPM]),
    ...(probes.hasSqlite ? [] : [SQLITE_MODULE]),
  ];
  return { ok: missing.length === 0, missing, flaky };
};

export const formatReport = (report: Report) =>
  [
    ...report.missing.map((name) => `missing prerequisite: ${name}`),
    ...report.flaky.map((file) => `known flaky: ${file}`),
    report.ok ? 'prerequisites ok' : `${report.missing.length} prerequisite(s) missing`,
  ].join('\n');

const probePnpm = () => {
  try {
    return execFileSync(PNPM, ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
};

const probeSqlite = () => process.getBuiltinModule(SQLITE_MODULE) !== undefined;

if (import.meta.main) {
  const report = checkPrerequisites({
    nodeVersion: process.version,
    pnpmVersion: probePnpm(),
    hasSqlite: probeSqlite(),
  });
  const output = formatReport(report);
  if (report.ok) console.log(output);
  else {
    console.error(output);
    process.exitCode = FAILURE_EXIT_CODE;
  }
}
