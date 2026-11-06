import type { CompiledRule, RuleDsl } from '../../rules/src/dsl.ts';
import { parseRuleDsl } from '../../rules/src/dsl.ts';
import type { RulePackManifest } from '../../rules/src/rulepack.ts';
import { reviewSources, type SourceClaim } from './ambiguity.ts';
import { type ApprovedPlugin, compileDrafts, type MechanicDraft } from './compile-drafts.ts';
import { type Extraction, type ExtractOptions, extractDocument } from './extraction.ts';
import { type Interpreter, interpretClauses } from './interpretation.ts';
import {
  decideActivation,
  type ImportPreview,
  previewImport,
  type RulePackRef,
  type SourceExample,
} from './preview.ts';
import type { Provenance } from './provenance.ts';
import { type StageInput, stageDocuments } from './staging.ts';
import { type UntrustedContent, wrapUntrusted } from './untrusted.ts';

export type ImportWorkflowInput = {
  readonly files: readonly StageInput[];
  readonly packs: readonly RulePackManifest[];
  readonly extract: ExtractOptions;
  readonly interpret: Interpreter;
  readonly approvedPlugins?: readonly ApprovedPlugin[];
  readonly claims?: readonly SourceClaim[];
  readonly examples?: readonly SourceExample[];
};

export const GAP_KINDS = [
  'stage_failed',
  'extraction_failed',
  'extraction_incomplete',
  'no_content',
  'unsupported_mechanic',
  'unresolved_finding',
  'source_test_failed',
  'rule_pack_mismatch',
] as const;
export type GapKind = (typeof GAP_KINDS)[number];
export type ImportGap = { readonly kind: GapKind; readonly source: string; readonly detail: string };

type Leaf = string | number | boolean;
export type MechanicEdit = { readonly ruleId: string; readonly field: string; readonly from: Leaf; readonly to: Leaf };

export type ImportOutcome =
  | { status: 'activated'; rulePack: RulePackRef; rules: CompiledRule[]; edits: MechanicEdit[]; gaps: [] }
  | { status: 'declined' | 'incomplete'; edits: MechanicEdit[]; gaps: ImportGap[] };

const USE = /^use\s+(\S+)$/i;
const SET = /^set\s+(\S+)\s+([^=\s]+)\s*(?:=|\s+to\s+)\s*(.+)$/i;
const ACTIVATE = 'activate';
const DECLINE = 'decline';
const SHOW = 'show';
const HELP = 'help';
const FIELD_SEPARATOR = '.';
const KIND_KEY = 'kind';
const ROOT_KEYS = new Set(['dslVersion', 'id']);
const TABLE_CELL_SEPARATOR = ' | ';
const BOOLEAN_TEXT = { true: true, false: false } as const;
const INDENT = '  ';
export const REPLY_HINT = 'Reply: use <rule pack>, set <rule> <field>=<value>, show, activate, decline or help.';
const HELP_TEXT = [
  'use <rule pack> - choose the rule pack the imported rules run on.',
  'set <rule> <field>=<value> - change one value of a rule, for example set my-rule costs.0.amount.value=2.',
  'show - show the preview again.',
  'activate - make the previewed rules the effective ruleset. Every gap must be fixed first.',
  'decline - stop without activating anything.',
].join('\n');

const describeSource = ({ fileName, locator }: Provenance) =>
  locator.kind === 'unknown'
    ? fileName
    : [
        fileName,
        ...(locator.page === undefined ? [] : [`p.${locator.page}`]),
        ...(locator.section ? [`§${locator.section}`] : []),
        ...(locator.title ? [locator.title] : []),
      ].join(' ');

const clausesOf = ({ pages }: Extraction): UntrustedContent[] =>
  pages.flatMap(({ blocks }) =>
    blocks.flatMap((block) =>
      block.type === 'text'
        ? [block.content]
        : block.rows.flatMap((row) =>
            row[0] ? [wrapUntrusted(row.map((cell) => cell.text).join(TABLE_CELL_SEPARATOR), row[0].provenance)] : [],
          ),
    ),
  );

type Intake = { drafts: MechanicDraft[]; gaps: ImportGap[]; lines: string[] };

async function intake({ files, extract, interpret }: ImportWorkflowInput): Promise<Intake> {
  const result: Intake = { drafts: [], gaps: [], lines: [] };
  const staged = stageDocuments(files);
  for (const [index, document] of staged.entries()) {
    const source = document.fileName ?? `file ${index + 1}`;
    if (!document.ok) {
      result.gaps.push({ kind: 'stage_failed', source, detail: document.failure });
      continue;
    }
    let extraction: Extraction;
    try {
      extraction = await extractDocument(document, files[index]?.bytes ?? new Uint8Array(), extract);
    } catch (error) {
      result.gaps.push({
        kind: 'extraction_failed',
        source,
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    for (const page of extraction.pages.filter(({ complete }) => !complete)) {
      result.gaps.push({
        kind: 'extraction_incomplete',
        source: page.page === undefined ? source : `${source} p.${page.page}`,
        detail: extraction.journey.failure ?? 'extraction_failed',
      });
    }
    const clauses = clausesOf(extraction);
    if (clauses.length === 0) result.gaps.push({ kind: 'no_content', source, detail: 'no readable rules text' });
    result.drafts.push(...(await interpretClauses(clauses, interpret)));
    result.lines.push(`Read ${document.fileName}: ${clauses.length} passage(s).`);
  }
  return result;
}

function previewGaps({ coverage, tests, summary }: ImportPreview, findings: ReturnType<typeof reviewSources>) {
  const gaps: ImportGap[] = [];
  for (const entry of coverage) {
    if (entry.status !== 'unsupported') continue;
    const issues = entry.error?.issues.map(({ path, message }) => `${path} ${message}`) ?? [];
    gaps.push({
      kind: 'unsupported_mechanic',
      source: describeSource(entry.provenance),
      detail: [entry.reason, ...issues].join('; '),
    });
  }
  for (const finding of findings.findings) {
    gaps.push({
      kind: 'unresolved_finding',
      source: finding.claims.map(({ provenance }) => describeSource(provenance)).join(', '),
      detail:
        finding.kind === 'unknown_edition' ? `${finding.kind} ${finding.edition}` : `${finding.kind} ${finding.term}`,
    });
  }
  for (const failed of tests.filter(({ status }) => status !== 'passed')) {
    gaps.push({ kind: 'source_test_failed', source: describeSource(failed.provenance), detail: failed.ruleId });
  }
  if (summary.mismatchedRulePack > 0) {
    gaps.push({ kind: 'rule_pack_mismatch', source: summary.rulePack.id, detail: `${summary.mismatchedRulePack}` });
  }
  return gaps;
}

const isLeaf = (value: unknown): value is Leaf => ['string', 'number', 'boolean'].includes(typeof value);

function leaves(value: unknown, path: string[] = []): [string, Leaf][] {
  if (isLeaf(value)) return [[path.join(FIELD_SEPARATOR), value]];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) =>
    key === KIND_KEY || (path.length === 0 && ROOT_KEYS.has(key)) ? [] : leaves(child, [...path, key]),
  );
}

function withLeaf(rule: RuleDsl, field: string, value: Leaf): unknown {
  const copy: Record<string, unknown> = structuredClone(rule);
  const keys = field.split(FIELD_SEPARATOR);
  const last = keys.pop() as string;
  const parent = keys.reduce<Record<string, unknown>>((node, key) => node[key] as Record<string, unknown>, copy);
  parent[last] = value;
  return copy;
}

function coerce(current: Leaf, text: string): { value: Leaf } | { error: string } {
  if (typeof current === 'number') {
    const number = Number(text);
    return Number.isFinite(number) ? { value: number } : { error: `${text} must be a number.` };
  }
  if (typeof current === 'boolean') {
    return Object.hasOwn(BOOLEAN_TEXT, text)
      ? { value: BOOLEAN_TEXT[text as keyof typeof BOOLEAN_TEXT] }
      : { error: `${text} must be true or false.` };
  }
  return { value: text };
}

const renderPreview = (preview: ImportPreview, gaps: readonly ImportGap[]) => {
  const { summary, rules } = preview;
  const { id, edition, revision } = summary.rulePack;
  return [
    `Rule pack: ${id} edition ${edition} revision ${revision}.`,
    `Rules ready: ${summary.executable}. Plugins: ${summary.plugins}. Unsupported: ${summary.unsupported}. Open questions: ${summary.findings}. Source tests passed: ${summary.testsPassed} of ${summary.testsPassed + summary.testsFailed}.`,
    ...(rules.length ? ['Rules you can change:'] : []),
    ...rules.flatMap(({ rule }) => leaves(rule).map(([field, value]) => `${INDENT}${rule.id} ${field}=${value}`)),
    ...(gaps.length ? ['Gaps to fix before activation:', ...renderGaps(gaps)] : ['No gaps found.']),
    REPLY_HINT,
  ].join('\n');
};

const renderGaps = (gaps: readonly ImportGap[]) =>
  gaps.map(({ kind, source, detail }) => `${INDENT}- ${kind} in ${source}: ${detail}`);

export async function* runImportConversation(
  input: ImportWorkflowInput,
  replies: AsyncIterable<string>,
): AsyncGenerator<string, ImportOutcome> {
  const { drafts, gaps: intakeGaps, lines } = await intake(input);
  yield* lines;
  const edits: MechanicEdit[] = [];
  let pack: RulePackManifest | undefined;
  let preview: ImportPreview | undefined;
  let gaps: ImportGap[] = [...intakeGaps];

  const refresh = () => {
    if (!pack) return;
    const review = reviewSources({ knownEditions: [pack.edition], claims: input.claims ?? [] });
    preview = previewImport({
      rulePack: pack,
      compilation: compileDrafts(drafts, pack, input.approvedPlugins ?? []),
      review,
      examples: input.examples ?? [],
    });
    gaps = [...intakeGaps, ...previewGaps(preview, review)];
  };

  const edit = (ruleId: string, field: string, text: string): string => {
    const index = drafts.findIndex(({ rule }) => rule?.id === ruleId);
    const rule = drafts[index]?.rule;
    if (!rule) return `No rule named ${ruleId}.`;
    const current = new Map(leaves(rule)).get(field);
    if (current === undefined) return `No field ${field} in ${ruleId}.`;
    const coerced = coerce(current, text);
    if ('error' in coerced) return coerced.error;
    const { value } = coerced;
    const parsed = parseRuleDsl(withLeaf(rule, field, value));
    if (!parsed.ok)
      return `Change rejected: ${parsed.error.issues.map(({ path, message }) => `${path} ${message}`).join('; ')}.`;
    drafts[index] = { ...(drafts[index] as MechanicDraft), rule: parsed.rule };
    edits.push({ ruleId, field, from: current, to: value });
    return `Changed ${ruleId} ${field} from ${current} to ${value}.`;
  };

  yield [
    'Choose the rule pack for these rules:',
    ...input.packs.map(({ id, edition, revision }) => `${INDENT}${id} (edition ${edition}, revision ${revision})`),
    ...(intakeGaps.length ? ['Gaps found while reading files:', ...renderGaps(intakeGaps)] : []),
    REPLY_HINT,
  ].join('\n');

  for await (const line of replies) {
    const reply = line.trim();
    const used = USE.exec(reply);
    const set = SET.exec(reply);
    if (reply === '') continue;
    if (used) {
      const chosen = input.packs.find(({ id }) => id === used[1]);
      if (!chosen) {
        yield `No rule pack named ${used[1]}.`;
        continue;
      }
      pack = chosen;
      refresh();
      if (preview) yield renderPreview(preview, gaps);
    } else if (set) {
      const [, ruleId = '', field = '', value = ''] = set;
      yield edit(ruleId, field, value.trim());
      refresh();
      if (preview) yield renderPreview(preview, gaps);
    } else if (reply === SHOW) {
      yield preview ? renderPreview(preview, gaps) : 'Choose a rule pack first.';
    } else if (reply === HELP) {
      yield HELP_TEXT;
    } else if (reply === DECLINE) {
      yield 'Import declined. No rules were activated.';
      return { status: 'declined', edits, gaps };
    } else if (reply === ACTIVATE) {
      if (!preview || !pack) {
        yield 'Choose a rule pack first.';
        continue;
      }
      const decision = decideActivation(preview, 'activate');
      if (gaps.length > 0 || !decision.activated) {
        yield ['Activation refused. Fix these gaps or decline:', ...renderGaps(gaps)].join('\n');
        continue;
      }
      yield `Activated ${decision.rules.length} rule(s) on ${decision.rulePack.id} revision ${decision.rulePack.revision}.`;
      return { status: 'activated', rulePack: decision.rulePack, rules: decision.rules, edits, gaps: [] };
    } else {
      yield `I did not understand "${reply}". ${REPLY_HINT}`;
    }
  }
  yield ['Import not completed. Nothing was activated.', ...renderGaps(gaps)].join('\n');
  return { status: 'incomplete', edits, gaps };
}
