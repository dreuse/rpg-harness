import { compareVersions, parseVersion, type Version } from './version.ts';

const RELEASE_OWNER = 'OWNER_PLACEHOLDER';
const RELEASE_REPO = 'REPO_PLACEHOLDER';
export const RELEASE_PUBLIC_KEY = 'OWNER_ED25519_PUBLIC_KEY_PEM_PLACEHOLDER';
export const DEFAULT_RELEASES_URL = `https://api.github.com/repos/${RELEASE_OWNER}/${RELEASE_REPO}/releases`;
export const RELEASES_URL_ENV = 'RPG_RELEASES_URL';
export const STABLE_CHANNEL = 'stable';
export const PRE_RELEASE_CHANNEL = 'pre-release';
const CHANNELS = [STABLE_CHANNEL, PRE_RELEASE_CHANNEL] as const;

const RATE_LIMIT_STATUSES = [403, 429];
const GITHUB_JSON = { accept: 'application/vnd.github+json' };
const SAFE_ASSET_NAME = /^[\w.+-]+$/;
const DOTS_ONLY = /^\.+$/;

export type Channel = (typeof CHANNELS)[number];
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export type ReleaseAsset = { readonly name: string; readonly url: string; readonly size: number };
export type Release = { readonly version: string; readonly notes: string; readonly assets: readonly ReleaseAsset[] };
export type QuietStatus = { readonly status: 'offline' } | { readonly status: 'rate-limited' };
export type CheckResult =
  | { readonly status: 'available'; readonly current: string; readonly release: Release }
  | { readonly status: 'current'; readonly version: string }
  | { readonly status: 'unavailable' }
  | QuietStatus;
export type CheckOptions = {
  readonly fetch: Fetch;
  readonly releasesUrl: string;
  readonly currentVersion: string;
  readonly channel: Channel;
  readonly signal?: AbortSignal;
};

const OFFLINE = { status: 'offline' } as const;
const RATE_LIMITED = { status: 'rate-limited' } as const;
const UNAVAILABLE = { status: 'unavailable' } as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isChannel = (value: unknown): value is Channel => CHANNELS.some((channel) => channel === value);

export const requestQuietly = async (
  fetch: Fetch,
  url: string,
  init: RequestInit = {},
): Promise<Response | QuietStatus | typeof UNAVAILABLE> => {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    return OFFLINE;
  }
  if (response.ok) return response;
  await response.body?.cancel();
  return RATE_LIMIT_STATUSES.includes(response.status) ? RATE_LIMITED : UNAVAILABLE;
};

const assetOf = (value: unknown): ReleaseAsset[] => {
  if (!isRecord(value)) return [];
  const { name, browser_download_url: url, size } = value;
  if (typeof name !== 'string' || !SAFE_ASSET_NAME.test(name) || DOTS_ONLY.test(name)) return [];
  if (typeof url !== 'string' || !Number.isSafeInteger(size) || Number(size) < 0) return [];
  return [{ name, url, size: Number(size) }];
};

type Candidate = { readonly release: Release; readonly parsed: Version; readonly prerelease: boolean };

const candidateOf = (value: unknown): Candidate[] => {
  if (!isRecord(value) || value.draft === true || typeof value.tag_name !== 'string') return [];
  const parsed = parseVersion(value.tag_name);
  if (parsed === undefined || !Array.isArray(value.assets)) return [];
  const notes = typeof value.body === 'string' ? value.body : '';
  return [
    {
      release: { version: parsed.text, notes, assets: value.assets.flatMap(assetOf) },
      parsed,
      prerelease: value.prerelease === true || parsed.prerelease,
    },
  ];
};

export const isNewer = (candidate: string, current: string) => {
  const next = parseVersion(candidate);
  const installed = parseVersion(current);
  return next !== undefined && installed !== undefined && compareVersions(next, installed) > 0;
};

export const checkForUpdate = async ({
  fetch,
  releasesUrl,
  currentVersion,
  channel,
  signal,
}: CheckOptions): Promise<CheckResult> => {
  const current = parseVersion(currentVersion);
  if (current === undefined) return UNAVAILABLE;
  const response = await requestQuietly(fetch, releasesUrl, { headers: GITHUB_JSON, ...(signal && { signal }) });
  if (!(response instanceof Response)) return response;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return UNAVAILABLE;
  }
  if (!Array.isArray(body)) return UNAVAILABLE;
  const [newest] = body
    .flatMap(candidateOf)
    .filter(({ prerelease }) => channel === PRE_RELEASE_CHANNEL || !prerelease)
    .filter(({ parsed }) => compareVersions(parsed, current) > 0)
    .sort((a, b) => compareVersions(b.parsed, a.parsed));
  if (newest === undefined) return { status: 'current', version: current.text };
  return { status: 'available', current: current.text, release: newest.release };
};
