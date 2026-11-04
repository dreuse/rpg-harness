import { readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import type { IngestFormat } from '../../../packages/imports/src/formats.ts';
import type { Interpreter } from '../../../packages/imports/src/interpretation.ts';
import { runImportConversation } from '../../../packages/imports/src/workflow.ts';
import { D20_LITE_MANIFEST } from '../../../packages/rules/src/d20-lite.ts';
import { DICE_POOL_LITE_MANIFEST } from '../../../packages/rules/src/dice-pool-lite.ts';
import { parseRuleDsl } from '../../../packages/rules/src/dsl.ts';
import { NARRATIVE_MANIFEST } from '../../../packages/rules/src/narrative.ts';

const BUILT_IN_PACKS = [D20_LITE_MANIFEST, DICE_POOL_LITE_MANIFEST, NARRATIVE_MANIFEST];
const TEXT_FORMATS: readonly IngestFormat[] = ['text', 'markdown', 'yaml'];
const PARAGRAPH_BREAK = /\n\s*\n/;
const PARENT_SEGMENT = '..';
const FULL_CONFIDENCE = 1;
const NO_CONFIDENCE = 0;

const readPages = (bytes: Uint8Array, format: IngestFormat) => {
  if (format !== 'json' && !TEXT_FORMATS.includes(format)) throw new Error(`No reader for ${format} files yet.`);
  const text = new TextDecoder().decode(bytes);
  const passages = format === 'json' ? [text] : text.split(PARAGRAPH_BREAK);
  const blocks = passages
    .map((passage) => passage.trim())
    .filter(Boolean)
    .map((passage) => ({ type: 'text' as const, text: passage, quality: 'high' as const }));
  return [{ blocks }];
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const interpretRuleData: Interpreter = async ({ text }) => {
  const parsed = parseRuleDsl(parseJson(text));
  return parsed.ok
    ? { rule: parsed.rule, confidence: FULL_CONFIDENCE, evidence: text }
    : { confidence: NO_CONFIDENCE, evidence: '' };
};

const readInside = (root: string, file: string) => {
  const realRoot = realpathSync(root);
  const path = realpathSync(resolve(realRoot, file));
  const fromRoot = relative(realRoot, path);
  if (
    fromRoot === '' ||
    fromRoot === PARENT_SEGMENT ||
    fromRoot.startsWith(PARENT_SEGMENT + sep) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`${file} is outside the import folder.`);
  }
  return { fileName: basename(path), bytes: readFileSync(path) };
};

export async function* importRules(root: string, files: readonly string[], lines: AsyncIterable<string>) {
  const conversation = runImportConversation(
    {
      files: files.map((file) => readInside(root, file)),
      packs: BUILT_IN_PACKS,
      extract: { readPages },
      interpret: interpretRuleData,
    },
    lines,
  );
  for (;;) {
    const step = await conversation.next();
    if (!step.done) {
      yield step.value;
      continue;
    }
    if (step.value.status === 'incomplete') {
      throw new Error(`Import not completed: ${step.value.gaps.length} gap(s) left.`);
    }
    return;
  }
}
