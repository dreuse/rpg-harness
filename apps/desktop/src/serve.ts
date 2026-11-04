import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { extname, join, relative, sep } from 'node:path';

export const APP_SCHEME = 'rpg';
export const APP_HOST = 'app';
export const APP_ROOT = join(import.meta.dirname, '..', '..', '..');
export const PAGE_PATH = 'apps/desktop/src/index.html';
export const PAGE_URL = `${APP_SCHEME}://${APP_HOST}/${PAGE_PATH}`;
export const PRELOAD_SOURCE = join(APP_ROOT, 'apps/desktop/src/preload.ts');
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SERVED_DIRS = ['apps/desktop/src/', 'packages/'];
const TEST_SUFFIX = '.test.ts';
const PARENT = '..';
const TEXT = 'utf8';
const OK = 200;
const NOT_FOUND = 404;
const HTML = '.html';
const TYPESCRIPT = '.ts';
const CSS = '.css';
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  [HTML]: 'text/html; charset=utf-8',
  [CSS]: 'text/css; charset=utf-8',
  [TYPESCRIPT]: 'text/javascript; charset=utf-8',
};
const EXPORT_KEYWORD = /^export /gm;
const PRELOAD_ENTRY = "\nexposeBridge(require('electron'));\n";

const notFound = () => new Response(null, { status: NOT_FOUND });

const servedPath = (root: string, url: string): string | undefined => {
  const { host, pathname } = new URL(url);
  if (host !== APP_HOST) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const path = join(root, decoded);
  const inside = relative(root, path).split(sep).join('/');
  if (inside.startsWith(PARENT) || inside.endsWith(TEST_SUFFIX)) return undefined;
  if (!SERVED_DIRS.some((dir) => inside.startsWith(dir))) return undefined;
  return Object.hasOwn(CONTENT_TYPES, extname(path)) ? path : undefined;
};

export const serveAsset = async (root: string, url: string): Promise<Response> => {
  const path = servedPath(root, url);
  if (path === undefined) return notFound();
  let source: string;
  try {
    source = await readFile(path, TEXT);
  } catch {
    return notFound();
  }
  const type = extname(path);
  const body = type === TYPESCRIPT ? stripTypeScriptTypes(source) : source;
  return new Response(body, {
    status: OK,
    headers: { 'content-type': CONTENT_TYPES[type] ?? '', 'content-security-policy': CONTENT_SECURITY_POLICY },
  });
};

export const bundlePreload = (source: string) =>
  stripTypeScriptTypes(source).replace(EXPORT_KEYWORD, '') + PRELOAD_ENTRY;
