import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isCondensed,
  MAX_RULES_DOCUMENT_CHARS,
  MAX_RULES_DOCUMENTS,
  type RulesDocument,
  type SETTING_DOCUMENT_KIND,
} from '../../../packages/engine/src/own-rules.ts';
import { classifyFile, type IngestFormat, isSafeFileName } from '../../../packages/imports/src/formats.ts';
import { makeProvenance, UNKNOWN_LOCATOR } from '../../../packages/imports/src/provenance.ts';
import { interpretImported, wrapUntrusted } from '../../../packages/imports/src/untrusted.ts';
import { condense } from '../../../packages/memory/src/rules.ts';
import { readInside } from './import-gateway.ts';

export const OWN_RULES_DIR = 'own-rules';
export const OWN_RULES_FORMATS: readonly IngestFormat[] = ['text', 'markdown', 'yaml'];
const HEAD_BYTES = 16;

const failureText = (file: string, failure: string) =>
  failure === 'mime_mismatch' ? `${file} is not a text file.` : `${file} is not supported: use md, txt or yaml files.`;

const textOf = (file: string, bytes: Uint8Array): { format: IngestFormat; text: string } => {
  const probe = classifyFile({ fileName: file, size: bytes.length, head: bytes.subarray(0, HEAD_BYTES) });
  if (!probe.ok) throw new Error(failureText(file, probe.failure));
  if (!OWN_RULES_FORMATS.includes(probe.format)) throw new Error(failureText(file, 'unsupported_format'));
  const text = new TextDecoder().decode(bytes);
  if (text.length > MAX_RULES_DOCUMENT_CHARS)
    throw new Error(`${file} is longer than ${MAX_RULES_DOCUMENT_CHARS} characters.`);
  return { format: probe.format, text };
};

export const stageOwnRules = (
  dataDir: string,
  root: string,
  files: readonly string[],
  keep: readonly string[] = [],
) => {
  if (files.length === 0 || files.length > MAX_RULES_DOCUMENTS)
    throw new Error(`Pick from 1 to ${MAX_RULES_DOCUMENTS} rules files.`);
  const clash = files.find((file) => keep.includes(file));
  if (clash !== undefined) throw new Error(`${clash} is already added as another kind of file.`);
  const staged = files.map((file) => {
    const { fileName, bytes } = readInside(root, file);
    textOf(fileName, bytes);
    return { fileName, bytes };
  });
  const dir = join(dataDir, OWN_RULES_DIR);
  mkdirSync(dir, { recursive: true });
  for (const entry of readdirSync(dir))
    if (!keep.includes(entry)) rmSync(join(dir, entry), { recursive: true, force: true });
  for (const { fileName, bytes } of staged) writeFileSync(join(dir, fileName), bytes);
  return { names: staged.map(({ fileName }) => fileName) };
};

const condensedFor = (text: string) => {
  const condensed = condense(text);
  return isCondensed(condensed) ? { condensed } : {};
};

export const loadOwnRules = (
  dataDir: string,
  names: readonly string[],
  kind?: typeof SETTING_DOCUMENT_KIND,
): RulesDocument[] => {
  const dir = join(dataDir, OWN_RULES_DIR);
  if (new Set(names).size !== names.length) throw new Error('A rules file was added twice.');
  return names.map((name) => {
    if (!isSafeFileName(name) || !existsSync(dir) || !readdirSync(dir).includes(name))
      throw new Error(`${name} was not added as a rules file.`);
    const { fileName, bytes } = readInside(dir, name);
    const { format, text } = textOf(fileName, bytes);
    const provenance = makeProvenance({
      sourceHash: createHash('sha256').update(bytes).digest('hex'),
      fileName,
      format,
      locator: UNKNOWN_LOCATOR,
      quality: 'high',
    });
    const data = interpretImported(wrapUntrusted(text, provenance));
    return {
      name: fileName,
      format,
      sourceHash: data.provenance.sourceHash,
      text: data.text,
      ...condensedFor(data.text),
      ...(kind === undefined ? {} : { kind }),
    };
  });
};
