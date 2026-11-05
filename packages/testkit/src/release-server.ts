import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export const RELEASES_PATH = '/repos/owner/repo/releases';
export const CHECKSUMS_NAME = 'SHA256SUMS';
export const SIGNATURE_NAME = 'SHA256SUMS.sig';

const LOCALHOST = '127.0.0.1';
const ANY_PORT = 0;
const OK = 200;
const NOT_FOUND = 404;
const JSON_TYPE = { 'content-type': 'application/json' };
const DOWNLOAD_PATH = '/download';
const BASE64 = 'base64';
const PEM = 'pem';

export type Route = {
  readonly status?: number;
  readonly body?: string | Buffer;
  readonly headers?: Readonly<Record<string, string>>;
  readonly truncateAt?: number;
};

export type PublishedRelease = {
  readonly version: string;
  readonly files: Readonly<Record<string, string | Buffer>>;
  readonly notes?: string;
  readonly prerelease?: boolean;
  readonly draft?: boolean;
};

export type SigningKeys = { readonly publicKey: string; readonly privateKey: KeyObject };

export const createSigningKeys = (): SigningKeys => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey: publicKey.export({ type: 'spki', format: PEM }).toString(), privateKey };
};

export const checksumsFor = (files: Readonly<Record<string, string | Buffer>>) =>
  Object.entries(files)
    .map(([name, bytes]) => `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`)
    .join('');

export const signatureFor = (checksums: string, privateKey: KeyObject) =>
  sign(null, Buffer.from(checksums), privateKey).toString(BASE64);

export const startReleaseServer = async (keys: SigningKeys) => {
  const routes = new Map<string, Route>();
  const releases: unknown[] = [];
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? '';
    requests.push(path);
    const route = routes.get(path) ?? (path === RELEASES_PATH ? { body: JSON.stringify(releases) } : undefined);
    if (route === undefined) {
      response.writeHead(NOT_FOUND).end();
      return;
    }
    const body = Buffer.from(route.body ?? '');
    response.writeHead(route.status ?? OK, {
      ...JSON_TYPE,
      'content-length': String(body.length),
      ...route.headers,
    });
    if (route.truncateAt === undefined) {
      response.end(body);
      return;
    }
    response.write(body.subarray(0, route.truncateAt), () => response.socket?.destroy());
  });
  await new Promise<void>((resolve) => server.listen(ANY_PORT, LOCALHOST, resolve));
  const url = `http://${LOCALHOST}:${(server.address() as AddressInfo).port}`;
  const assetPath = (version: string, name: string) => `${DOWNLOAD_PATH}/${version}/${name}`;
  const serve = (path: string, route: Route) => routes.set(path, route);
  const publish = ({ version, files, notes = '', prerelease = false, draft = false }: PublishedRelease) => {
    const checksums = checksumsFor(files);
    const all = { ...files, [CHECKSUMS_NAME]: checksums, [SIGNATURE_NAME]: signatureFor(checksums, keys.privateKey) };
    for (const [name, body] of Object.entries(all)) serve(assetPath(version, name), { body });
    releases.push({
      tag_name: `v${version}`,
      body: notes,
      prerelease,
      draft,
      assets: Object.entries(all).map(([name, body]) => ({
        name,
        size: Buffer.byteLength(body),
        browser_download_url: `${url}${assetPath(version, name)}`,
      })),
    });
  };
  return {
    releasesUrl: `${url}${RELEASES_PATH}`,
    requests,
    serve,
    publish,
    assetPath,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
};

export type ReleaseServer = Awaited<ReturnType<typeof startReleaseServer>>;
