import { VISIBILITY_LEVELS, type Visibility } from './entity.ts';

export const CHARACTER_KIND = 'character';

export type ProfileTraitValue = string | number | boolean;
export type ProfileTrait = { readonly id: string; readonly value: ProfileTraitValue };
export type ProfileCondition = { readonly id: string };
export type RulePackLink = { readonly id: string; readonly edition: string; readonly revision: string };
export type RuleCitation = { readonly ruleId: string; readonly rulepack: RulePackLink; readonly section: string };

export type CharacterProfile = {
  readonly identity: Readonly<{ name: string } & Record<string, string>>;
  readonly motivations: readonly string[];
  readonly background: string;
  readonly traits: readonly ProfileTrait[];
  readonly conditions: readonly ProfileCondition[];
  readonly rulepack: RulePackLink;
};

export type ProfileIssue = { readonly path: string; readonly message: string };
export type ProfileResult = { ok: true; profile: CharacterProfile } | { ok: false; issues: ProfileIssue[] };

export class InvalidCharacterProfileError extends Error {
  readonly issues: readonly ProfileIssue[];
  constructor(issues: readonly ProfileIssue[]) {
    super(`invalid character profile: ${issues.map(({ path, message }) => `${path} ${message}`).join('; ')}`);
    this.issues = issues;
  }
}

const NON_EMPTY_STRING = 'must be a non-empty string';
const STRING = 'must be a string';
const OBJECT = 'must be a plain object';
const STRING_LIST = 'must be a list of strings';
const LIST = 'must be a list';
const TRAIT_VALUE = 'must be a string, boolean or finite number';
const DUPLICATE_ID = 'must be unique';
const VISIBILITY = 'must not be actor-scoped for a character profile';
const ACTOR_SCOPED = 'actor-scoped';
const RULEPACK_KEYS = ['id', 'edition', 'revision'] as const;

export type ProfileVisibility = Exclude<Visibility, typeof ACTOR_SCOPED>;
export const isProfileVisibility = (value: Visibility): value is ProfileVisibility =>
  VISIBILITY_LEVELS.includes(value) && value !== ACTOR_SCOPED;
export const VISIBILITY_ISSUE: ProfileIssue = { path: 'visibility', message: VISIBILITY };

type Fields = Record<string, unknown>;

const ownFields = (value: unknown): Fields | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  return Object.assign(Object.create(null), Object.fromEntries(Object.entries(value)));
};
const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isTraitValue = (value: unknown): value is ProfileTraitValue =>
  typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
const listOf = (value: unknown): unknown[] | undefined => (Array.isArray(value) ? Array.from(value) : undefined);

const parseIdentity = (input: unknown, issues: ProfileIssue[]): CharacterProfile['identity'] => {
  const fields = ownFields(input);
  if (fields === undefined) {
    issues.push({ path: 'identity', message: OBJECT });
    return { name: '' };
  }
  for (const [key, value] of Object.entries(fields))
    if (typeof value !== 'string') issues.push({ path: `identity.${key}`, message: STRING });
  if (!isNonEmptyString(fields.name)) issues.push({ path: 'identity.name', message: NON_EMPTY_STRING });
  return { ...fields } as CharacterProfile['identity'];
};

const parseEntries = (key: string, input: unknown, issues: ProfileIssue[]) => {
  const entries = listOf(input);
  if (entries === undefined) {
    issues.push({ path: key, message: LIST });
    return [];
  }
  const seen = new Set<unknown>();
  return entries.map((entry, index) => {
    const path = `${key}[${index}]`;
    const fields = ownFields(entry);
    if (fields === undefined) {
      issues.push({ path, message: OBJECT });
      return undefined;
    }
    if (!isNonEmptyString(fields.id)) issues.push({ path: `${path}.id`, message: NON_EMPTY_STRING });
    else if (seen.has(fields.id)) issues.push({ path: `${path}.id`, message: DUPLICATE_ID });
    seen.add(fields.id);
    return fields;
  });
};

const parseTraits = (input: unknown, issues: ProfileIssue[]) =>
  parseEntries('traits', input, issues).map((fields, index) => {
    if (fields !== undefined && !isTraitValue(fields.value))
      issues.push({ path: `traits[${index}].value`, message: TRAIT_VALUE });
    return { id: fields?.id, value: fields?.value } as ProfileTrait;
  });

const parseRulePack = (input: unknown, issues: ProfileIssue[]): RulePackLink => {
  const fields = ownFields(input);
  if (fields === undefined) {
    issues.push({ path: 'rulepack', message: OBJECT });
    return { id: '', edition: '', revision: '' };
  }
  for (const key of RULEPACK_KEYS)
    if (!isNonEmptyString(fields[key])) issues.push({ path: `rulepack.${key}`, message: NON_EMPTY_STRING });
  return { id: fields.id, edition: fields.edition, revision: fields.revision } as RulePackLink;
};

const parseMotivations = (input: unknown, issues: ProfileIssue[]) => {
  const motivations = listOf(input);
  if (motivations === undefined || !motivations.every((entry) => typeof entry === 'string'))
    issues.push({ path: 'motivations', message: STRING_LIST });
  return (motivations ?? []) as string[];
};

export const parseCharacterProfile = (input: unknown): ProfileResult => {
  const fields = ownFields(input);
  if (fields === undefined) return { ok: false, issues: [{ path: '', message: OBJECT }] };
  const issues: ProfileIssue[] = [];
  const identity = parseIdentity(fields.identity, issues);
  const motivations = parseMotivations(fields.motivations, issues);
  const { background } = fields;
  if (typeof background !== 'string') issues.push({ path: 'background', message: STRING });
  const traits = parseTraits(fields.traits, issues);
  const conditions = parseEntries('conditions', fields.conditions, issues).map(
    (entry) => ({ id: entry?.id }) as ProfileCondition,
  );
  const rulepack = parseRulePack(fields.rulepack, issues);
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    profile: { identity, motivations, background: background as string, traits, conditions, rulepack },
  };
};
