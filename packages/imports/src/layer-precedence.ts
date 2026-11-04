import { isDeepStrictEqual } from 'node:util';
import { deepFreeze } from '../../rules/src/compile.ts';
import { isNonEmptyString, isRecord, type ManifestIssue, NON_EMPTY_STRING } from '../../rules/src/rulepack.ts';
import type { RulePackRef } from './preview.ts';

export const LAYER_KINDS = ['base', 'supplement', 'errata', 'option', 'campaign'] as const;
const SUPPLEMENT = 'supplement';
const LAYERS_PATH = 'layers';
const ORDER_PATH = 'supplementOrder';
const RESOLUTIONS_PATH = 'resolutions';
const LIST_SEPARATOR = ', ';

export type LayerKind = (typeof LAYER_KINDS)[number];
export type RuleEntry = Readonly<{ id: string; revision: string; value: unknown }>;
export type RuleLayer = Readonly<{
  kind: LayerKind;
  sourceRef: string;
  rulePack: RulePackRef;
  entries: readonly RuleEntry[];
}>;
export type LayerInput = Readonly<{
  rulePack: RulePackRef;
  layers: readonly RuleLayer[];
  supplementOrder?: readonly string[];
  resolutions?: Readonly<Record<string, string>>;
}>;

export type EntrySource = Readonly<{ kind: LayerKind; sourceRef: string; revision: string }>;
export type ResolvedEntry = Readonly<{
  id: string;
  revision: string;
  value: unknown;
  source: EntrySource;
  shadowed: readonly EntrySource[];
  resolution: 'precedence' | 'explicit';
}>;
export type ResolvedLayers = Readonly<{ rulePack: RulePackRef; entries: readonly ResolvedEntry[] }>;

export type LayerErrorCode =
  | 'InvalidLayer'
  | 'RulePackMismatch'
  | 'EditionMismatch'
  | 'RevisionMismatch'
  | 'DuplicateSource'
  | 'DuplicateEntry'
  | 'InvalidSupplementOrder'
  | 'VersionConflict'
  | 'InvalidResolution';
export type LayerError = { code: LayerErrorCode; issues: ManifestIssue[] };
export type LayerResult = { ok: true; resolved: ResolvedLayers } | { ok: false; error: LayerError };

type Candidate = Readonly<{ rank: readonly number[]; source: EntrySource; entry: RuleEntry }>;

const fail = (code: LayerErrorCode, issues: ManifestIssue[]) => ({ ok: false as const, error: { code, issues } });

const packIssues = (rulePack: RulePackRef, layers: readonly RuleLayer[], key: keyof RulePackRef) =>
  layers.flatMap((layer, index) =>
    layer.rulePack[key] === rulePack[key]
      ? []
      : [{ path: `${LAYERS_PATH}.${index}.rulePack.${key}`, message: `must be ${rulePack[key]}` }],
  );

const duplicateIssues = (values: readonly string[], path: (index: number) => string) =>
  values.flatMap((value, index) =>
    values.indexOf(value) === index ? [] : [{ path: path(index), message: `${value} is listed more than once` }],
  );

const orderIssues = (layers: readonly RuleLayer[], order: readonly string[]): ManifestIssue[] => {
  if (order.length === 0) return [];
  const supplements = layers.filter(({ kind }) => kind === SUPPLEMENT).map(({ sourceRef }) => sourceRef);
  return [
    ...duplicateIssues(order, (index) => `${ORDER_PATH}.${index}`),
    ...order.flatMap((ref, index) =>
      supplements.includes(ref) ? [] : [{ path: `${ORDER_PATH}.${index}`, message: `${ref} is not a supplement` }],
    ),
    ...supplements.flatMap((ref) =>
      order.includes(ref) ? [] : [{ path: ORDER_PATH, message: `must list supplement ${ref}` }],
    ),
  ];
};

const compareRank = (left: readonly number[], right: readonly number[]) =>
  (right[0] ?? 0) - (left[0] ?? 0) || (right[1] ?? 0) - (left[1] ?? 0);

const candidatesById = (layers: readonly RuleLayer[], order: readonly string[]) => {
  const byId = new Map<string, Candidate[]>();
  for (const { kind, sourceRef, entries } of layers) {
    const rank = [LAYER_KINDS.indexOf(kind), kind === SUPPLEMENT ? order.indexOf(sourceRef) : 0];
    for (const entry of entries) {
      const candidate = { rank, source: { kind, sourceRef, revision: entry.revision }, entry };
      byId.set(entry.id, [...(byId.get(entry.id) ?? []), candidate]);
    }
  }
  return [...byId].sort(([left], [right]) => (left < right ? -1 : Number(left > right)));
};

const conflicting = (candidates: readonly Candidate[]) => {
  const [top] = candidates;
  const tied = candidates.filter(({ rank }) => top && compareRank(rank, top.rank) === 0);
  const differs = tied.some(
    ({ entry }) => top && !isDeepStrictEqual([entry.revision, entry.value], [top.entry.revision, top.entry.value]),
  );
  return differs ? tied : [];
};

const MUST_BE_ARRAY = 'must be an array';
const MUST_BE_OBJECT = 'must be an object';

const entryIssues = (entries: unknown, path: string): ManifestIssue[] => {
  if (!Array.isArray(entries)) return [{ path, message: MUST_BE_ARRAY }];
  return entries.flatMap((entry, index) => {
    const entryPath = `${path}.${index}`;
    if (!isRecord(entry)) return [{ path: entryPath, message: MUST_BE_OBJECT }];
    return (['id', 'revision'] as const).flatMap((key) =>
      isNonEmptyString(entry[key]) ? [] : [{ path: `${entryPath}.${key}`, message: NON_EMPTY_STRING }],
    );
  });
};

const refIssues = (rulePack: unknown, path: string): ManifestIssue[] => {
  if (!isRecord(rulePack)) return [{ path, message: MUST_BE_OBJECT }];
  return (['id', 'edition', 'revision'] as const).flatMap((key) =>
    isNonEmptyString(rulePack[key]) ? [] : [{ path: `${path}.${key}`, message: NON_EMPTY_STRING }],
  );
};

const layerIssues = (layer: unknown, path: string): ManifestIssue[] => {
  if (!isRecord(layer)) return [{ path, message: MUST_BE_OBJECT }];
  return [
    ...(LAYER_KINDS.includes(layer.kind as LayerKind)
      ? []
      : [{ path: `${path}.kind`, message: `must be one of ${LAYER_KINDS.join(LIST_SEPARATOR)}` }]),
    ...(isNonEmptyString(layer.sourceRef) ? [] : [{ path: `${path}.sourceRef`, message: NON_EMPTY_STRING }]),
    ...refIssues(layer.rulePack, `${path}.rulePack`),
    ...entryIssues(layer.entries, `${path}.entries`),
  ];
};

const shapeIssues = (input: unknown): ManifestIssue[] => {
  if (!isRecord(input)) return [{ path: '', message: MUST_BE_OBJECT }];
  const { rulePack, layers, supplementOrder = [], resolutions = {} } = input;
  return [
    ...refIssues(rulePack, 'rulePack'),
    ...(Array.isArray(layers)
      ? layers.flatMap((layer, index) => layerIssues(layer, `${LAYERS_PATH}.${index}`))
      : [{ path: LAYERS_PATH, message: MUST_BE_ARRAY }]),
    ...(Array.isArray(supplementOrder) && supplementOrder.every((ref) => typeof ref === 'string')
      ? []
      : [{ path: ORDER_PATH, message: 'must be an array of strings' }]),
    ...(isRecord(resolutions) && Object.values(resolutions).every((ref) => typeof ref === 'string')
      ? []
      : [{ path: RESOLUTIONS_PATH, message: 'must be an object of strings' }]),
  ];
};

const cloneInput = (input: LayerInput): LayerInput | undefined => {
  try {
    return structuredClone(input);
  } catch {
    return undefined;
  }
};

export const resolveLayers = (input: LayerInput): LayerResult => {
  const cloned = cloneInput(input);
  if (!cloned) return fail('InvalidLayer', [{ path: LAYERS_PATH, message: 'must be plain data' }]);
  const shape = shapeIssues(cloned);
  if (shape.length > 0) return fail('InvalidLayer', shape);
  const { rulePack, layers, supplementOrder = [], resolutions = {} } = cloned;
  const foreign = packIssues(rulePack, layers, 'id');
  if (foreign.length > 0) return fail('RulePackMismatch', foreign);
  const mixed = packIssues(rulePack, layers, 'edition');
  if (mixed.length > 0) return fail('EditionMismatch', mixed);
  const drift = packIssues(rulePack, layers, 'revision');
  if (drift.length > 0) return fail('RevisionMismatch', drift);
  const sources = duplicateIssues(
    layers.map(({ sourceRef }) => sourceRef),
    (index) => `${LAYERS_PATH}.${index}.sourceRef`,
  );
  if (sources.length > 0) return fail('DuplicateSource', sources);
  const entries = layers.flatMap(({ entries: layerEntries }, index) =>
    duplicateIssues(
      layerEntries.map(({ id }) => id),
      (entry) => `${LAYERS_PATH}.${index}.entries.${entry}.id`,
    ),
  );
  if (entries.length > 0) return fail('DuplicateEntry', entries);
  const order = orderIssues(layers, supplementOrder);
  if (order.length > 0) return fail('InvalidSupplementOrder', order);

  const grouped = candidatesById(layers, supplementOrder).map(
    ([id, candidates]) => [id, [...candidates].sort((left, right) => compareRank(left.rank, right.rank))] as const,
  );
  const conflicts = new Map(grouped.map(([id, candidates]) => [id, conflicting(candidates)]));
  const invalid = Object.entries(resolutions).flatMap(([id, ref]) => {
    const contenders = conflicts.get(id) ?? [];
    return contenders.some(({ source }) => source.sourceRef === ref)
      ? []
      : [{ path: `${RESOLUTIONS_PATH}.${id}`, message: `${ref} is not a conflicting source for ${id}` }];
  });
  if (invalid.length > 0) return fail('InvalidResolution', invalid);
  const unresolved = [...conflicts].flatMap(([id, contenders]) =>
    contenders.length === 0 || Object.hasOwn(resolutions, id)
      ? []
      : [
          {
            path: `${RESOLUTIONS_PATH}.${id}`,
            message: `must name one of ${contenders
              .map(({ source }) => source.sourceRef)
              .sort()
              .join(LIST_SEPARATOR)}`,
          },
        ],
  );
  if (unresolved.length > 0) return fail('VersionConflict', unresolved);

  const resolved = grouped.map(([id, candidates]): ResolvedEntry => {
    const explicit = Object.hasOwn(resolutions, id);
    const winner =
      (explicit ? candidates.find(({ source }) => source.sourceRef === resolutions[id]) : undefined) ??
      (candidates[0] as Candidate);
    return {
      id,
      revision: winner.entry.revision,
      value: winner.entry.value,
      source: winner.source,
      shadowed: candidates.filter((candidate) => candidate !== winner).map(({ source }) => source),
      resolution: explicit ? 'explicit' : 'precedence',
    };
  });
  const { id, edition, revision } = rulePack;
  return { ok: true, resolved: deepFreeze({ rulePack: { id, edition, revision }, entries: resolved }) };
};
