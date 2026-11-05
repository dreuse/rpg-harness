import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { createWriteStream, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import { type Fetch, type QuietStatus, type Release, type ReleaseAsset, requestQuietly } from './release.ts';

const CHECKSUMS_ASSET = 'SHA256SUMS';
const SIGNATURE_ASSET = 'SHA256SUMS.sig';

const CHECKSUM = 'sha256';
const HEX = 'hex';
const BASE64 = 'base64';
const TEXT = 'utf8';
const CHECKSUM_LINE = /^([0-9a-f]{64}) [ *](.+)$/;
const LINE_BREAK = /\r?\n/;
const PARTIAL_SUFFIX = '.part';
const CREATE_EXCLUSIVE = 'wx';
const CONTENT_LENGTH = 'content-length';
const MAX_SIGNED_FILE_BYTES = 64 * 1024;
const SIGNING_KEY_TYPE = 'ed25519';

export type DownloadResult =
  | { readonly status: 'verified'; readonly file: string }
  | { readonly status: 'rejected'; readonly reason: string }
  | QuietStatus;
export type DownloadOptions = {
  readonly fetch: Fetch;
  readonly release: Release;
  readonly assetName: string;
  readonly publicKey: string;
  readonly dir: string;
};

const rejected = (reason: string) => ({ status: 'rejected', reason }) as const;
const NO_BUILD = rejected('the release has no signed build for this system');
const INCOMPLETE = rejected('download is incomplete');
const incomplete = () => new Error(INCOMPLETE.reason);

const verifySignature = (data: Buffer, signature: string, publicKey: string): boolean => {
  try {
    const key = createPublicKey(publicKey);
    return key.asymmetricKeyType === SIGNING_KEY_TYPE && verify(null, data, key, Buffer.from(signature.trim(), BASE64));
  } catch {
    return false;
  }
};

const checksumsOf = (text: string) =>
  new Map(
    text
      .split(LINE_BREAK)
      .map((line) => CHECKSUM_LINE.exec(line))
      .flatMap((match) => (match?.[1] && match[2] ? [[match[2], match[1]] as const] : [])),
  );

const readSmall = async (fetch: Fetch, asset: ReleaseAsset): Promise<Buffer | DownloadResult> => {
  if (asset.size > MAX_SIGNED_FILE_BYTES) return INCOMPLETE;
  const response = await requestQuietly(fetch, asset.url);
  if (!(response instanceof Response)) return response.status === 'unavailable' ? INCOMPLETE : response;
  if (response.body === null) return INCOMPLETE;
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of Readable.fromWeb(response.body as ReadableStream<Uint8Array>)) {
      bytes += chunk.length;
      if (bytes > asset.size) return INCOMPLETE;
      chunks.push(chunk);
    }
  } catch {
    return INCOMPLETE;
  }
  return Buffer.concat(chunks);
};

const save = async (response: Response, asset: ReleaseAsset, temp: string) => {
  const declared = response.headers.get(CONTENT_LENGTH);
  if (response.body === null || (declared !== null && Number(declared) !== asset.size)) throw incomplete();
  const hash = createHash(CHECKSUM);
  let bytes = 0;
  await pipeline(
    Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
    async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        bytes += chunk.length;
        if (bytes > asset.size) throw incomplete();
        hash.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(temp, { flags: CREATE_EXCLUSIVE }),
  );
  if (bytes !== asset.size) throw incomplete();
  return hash.digest(HEX);
};

export const downloadVerified = async ({
  fetch,
  release,
  assetName,
  publicKey,
  dir,
}: DownloadOptions): Promise<DownloadResult> => {
  const find = (name: string) => release.assets.find((asset) => asset.name === name);
  const asset = find(assetName);
  const checksumsAsset = find(CHECKSUMS_ASSET);
  const signatureAsset = find(SIGNATURE_ASSET);
  if (asset === undefined || checksumsAsset === undefined || signatureAsset === undefined) return NO_BUILD;
  const checksums = await readSmall(fetch, checksumsAsset);
  if (!Buffer.isBuffer(checksums)) return checksums;
  const signature = await readSmall(fetch, signatureAsset);
  if (!Buffer.isBuffer(signature)) return signature;
  if (!verifySignature(checksums, signature.toString(TEXT), publicKey)) return rejected('signature does not match');
  const expected = checksumsOf(checksums.toString(TEXT)).get(assetName);
  if (expected === undefined) return rejected('checksum is missing');
  const response = await requestQuietly(fetch, asset.url);
  if (!(response instanceof Response)) return response.status === 'unavailable' ? INCOMPLETE : response;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, assetName);
  const temp = `${file}.${randomUUID()}${PARTIAL_SUFFIX}`;
  try {
    const actual = await save(response, asset, temp);
    if (actual !== expected) {
      rmSync(temp, { force: true });
      return rejected('checksum does not match');
    }
    renameSync(temp, file);
    return { status: 'verified', file };
  } catch {
    rmSync(temp, { force: true });
    await response.body?.cancel().catch(() => undefined);
    return INCOMPLETE;
  }
};
