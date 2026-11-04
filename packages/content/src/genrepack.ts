export const GENREPACK_CONTRACT_VERSION = 1;

export type Archetype = { readonly id: string; readonly name: string; readonly summary: string };

export type GenrePack = {
  readonly contractVersion: typeof GENREPACK_CONTRACT_VERSION;
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly archetypes: readonly Archetype[];
  readonly narrativeConstraints: readonly string[];
  readonly examples: readonly string[];
  readonly visualConventions: readonly string[];
  readonly suggestedCapabilities: readonly string[];
  readonly requiredRuleCapabilities?: readonly string[];
};

export type GenrePackIssue = { path: string; message: string };
export type GenrePackResult = { ok: true; pack: GenrePack } | { ok: false; issues: GenrePackIssue[] };

export const NON_EMPTY_STRING = 'must be a non-empty string';
const UNKNOWN_FIELD = 'is not an allowed field';
const STRING_FIELDS = ['id', 'version', 'name'] as const;
const STRING_LIST_FIELDS = ['narrativeConstraints', 'examples', 'visualConventions', 'suggestedCapabilities'] as const;
const REQUIRED_RULE_CAPABILITIES = 'requiredRuleCapabilities';
const ARCHETYPE_FIELDS = ['id', 'name', 'summary'] as const;
const ALLOWED_FIELDS: readonly string[] = [
  'contractVersion',
  'archetypes',
  REQUIRED_RULE_CAPABILITIES,
  ...STRING_FIELDS,
  ...STRING_LIST_FIELDS,
];

export const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

export const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

export const unknownFields = (record: Record<string, unknown>, allowed: readonly string[], prefix: string) =>
  Object.keys(record)
    .filter((key) => !allowed.includes(key))
    .map((key) => ({ path: `${prefix}${key}`, message: UNKNOWN_FIELD }));

export const readStringList = (value: unknown, path: string, issues: GenrePackIssue[]): readonly string[] => {
  if (!Array.isArray(value)) {
    issues.push({ path, message: 'must be an array' });
    return [];
  }
  const strings: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const item: unknown = value[index];
    if (isNonEmptyString(item)) strings.push(item);
    else issues.push({ path: `${path}.${index}`, message: NON_EMPTY_STRING });
  }
  return strings;
};

const readArchetypes = (value: unknown, issues: GenrePackIssue[]): readonly Archetype[] => {
  if (!Array.isArray(value)) {
    issues.push({ path: 'archetypes', message: 'must be an array' });
    return [];
  }
  const archetypes: Archetype[] = [];
  value.forEach((item, index) => {
    const path = `archetypes.${index}`;
    if (!isPlainRecord(item)) {
      issues.push({ path, message: 'must be an object' });
      return;
    }
    issues.push(...unknownFields(item, ARCHETYPE_FIELDS, `${path}.`));
    for (const field of ARCHETYPE_FIELDS) {
      if (!isNonEmptyString(item[field])) issues.push({ path: `${path}.${field}`, message: NON_EMPTY_STRING });
    }
    const { id, name, summary } = item;
    if (isNonEmptyString(id) && isNonEmptyString(name) && isNonEmptyString(summary)) {
      archetypes.push(Object.freeze({ id, name, summary }));
    }
  });
  return archetypes;
};

export const loadGenrePack = (input: unknown): GenrePackResult => {
  if (!isPlainRecord(input)) return { ok: false, issues: [{ path: '', message: 'must be an object' }] };
  const issues = unknownFields(input, ALLOWED_FIELDS, '');
  if (input.contractVersion !== GENREPACK_CONTRACT_VERSION) {
    issues.push({ path: 'contractVersion', message: `must be ${GENREPACK_CONTRACT_VERSION}` });
  }
  const { id, version, name } = input;
  for (const field of STRING_FIELDS) {
    if (!isNonEmptyString({ id, version, name }[field])) issues.push({ path: field, message: NON_EMPTY_STRING });
  }
  const archetypes = readArchetypes(input.archetypes, issues);
  const lists = Object.fromEntries(
    STRING_LIST_FIELDS.map((field) => [field, Object.freeze(readStringList(input[field], field, issues))]),
  ) as Record<(typeof STRING_LIST_FIELDS)[number], readonly string[]>;
  const required = Object.hasOwn(input, REQUIRED_RULE_CAPABILITIES)
    ? {
        requiredRuleCapabilities: Object.freeze(
          readStringList(input[REQUIRED_RULE_CAPABILITIES], REQUIRED_RULE_CAPABILITIES, issues),
        ),
      }
    : {};
  if (issues.length > 0) return { ok: false, issues };
  const pack: GenrePack = {
    contractVersion: GENREPACK_CONTRACT_VERSION,
    id: id as string,
    version: version as string,
    name: name as string,
    archetypes: Object.freeze(archetypes),
    ...lists,
    ...required,
  };
  return { ok: true, pack: Object.freeze(pack) };
};
