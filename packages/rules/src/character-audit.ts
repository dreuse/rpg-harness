import type { CharacterId, EventId } from '../../domain/src/campaign.ts';
import type { RulePackLink } from '../../domain/src/character.ts';
import type { ResolutionError } from './resolve.ts';
import { isNonEmptyString, isRecord, type ManifestIssue, NON_EMPTY_STRING } from './rulepack.ts';

export const REVISION_KINDS = ['resource', 'backstory', 'equipment', 'rulepack'] as const;
export const REVISION_ORIGINS = ['manual-correction', 'in-world', 'ruleset-migration', 'approved-migration'] as const;

export type RevisionKind = (typeof REVISION_KINDS)[number];
export type RevisionOrigin = (typeof REVISION_ORIGINS)[number];
export type RevisionValue = string | number | boolean;

export type CharacterRevision = Readonly<{
  characterId: CharacterId;
  kind: RevisionKind;
  targetId: string;
  origin: RevisionOrigin;
  cause: EventId;
  source: string;
  rulepack: Readonly<RulePackLink>;
  previous: RevisionValue;
  next: RevisionValue;
}>;
export type RevisionInput = { [K in keyof CharacterRevision]: unknown };
export type RevisionResult = { ok: true; log: readonly CharacterRevision[] } | { ok: false; error: ResolutionError };

const ID_FIELDS = ['characterId', 'targetId', 'cause', 'source'] as const;
const RULEPACK_KEYS = ['id', 'edition', 'revision'] as const;
const RULEPACK_KIND: RevisionKind = 'rulepack';
const VALUE_FIELDS = ['previous', 'next'] as const;
const UNCHANGED = 'must differ from previous';
const STALE_PREVIOUS = 'must equal the latest recorded value';
const KIND_CHANGED = 'must equal the latest recorded kind';

const VALUE_CHECKS: Record<RevisionKind, { message: string; accepts: (value: unknown) => boolean }> = {
  resource: { message: 'must be a finite number', accepts: (value) => Number.isFinite(value) },
  backstory: { message: 'must be a string', accepts: (value) => typeof value === 'string' },
  equipment: { message: 'must be a boolean', accepts: (value) => typeof value === 'boolean' },
  rulepack: { message: NON_EMPTY_STRING, accepts: isNonEmptyString },
};

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T => list.includes(value as T);

const validate = (input: RevisionInput): ManifestIssue[] => {
  const issues: ManifestIssue[] = [];
  const at = (path: string, message: string) => issues.push({ path, message });
  for (const field of ID_FIELDS) if (!isNonEmptyString(input[field])) at(field, NON_EMPTY_STRING);
  if (!isOneOf(REVISION_KINDS, input.kind)) at('kind', `must be one of ${REVISION_KINDS.join(', ')}`);
  if (!isOneOf(REVISION_ORIGINS, input.origin)) at('origin', `must be one of ${REVISION_ORIGINS.join(', ')}`);
  const { rulepack } = input;
  if (!isRecord(rulepack)) at('rulepack', 'must be an object');
  else for (const key of RULEPACK_KEYS) if (!isNonEmptyString(rulepack[key])) at(`rulepack.${key}`, NON_EMPTY_STRING);
  if (isOneOf(REVISION_KINDS, input.kind)) {
    const { message, accepts } = VALUE_CHECKS[input.kind];
    for (const field of VALUE_FIELDS) if (!accepts(input[field])) at(field, message);
  }
  if (issues.length === 0 && input.previous === input.next) at('next', UNCHANGED);
  return issues;
};

const continuityIssues = (log: readonly CharacterRevision[], entry: CharacterRevision): ManifestIssue[] => {
  const isRulePack = entry.kind === RULEPACK_KIND;
  const last = log.findLast(
    ({ characterId, targetId, kind }) =>
      characterId === entry.characterId && targetId === entry.targetId && (kind === RULEPACK_KIND) === isRulePack,
  );
  if (last === undefined) return [];
  if (last.kind !== entry.kind) return [{ path: 'kind', message: KIND_CHANGED }];
  if (last.next !== entry.previous) return [{ path: 'previous', message: STALE_PREVIOUS }];
  return [];
};

export const appendRevision = (log: readonly CharacterRevision[], input: RevisionInput): RevisionResult => {
  if (!isRecord(input))
    return { ok: false, error: { code: 'InvalidAction', issues: [{ path: '', message: 'must be an object' }] } };
  const fields: RevisionInput = {
    ...input,
    rulepack: isRecord(input.rulepack) ? { ...input.rulepack } : input.rulepack,
  };
  const issues = validate(fields);
  if (issues.length > 0) return { ok: false, error: { code: 'InvalidAction', issues } };
  const { characterId, kind, targetId, origin, cause, source, rulepack, previous, next } = fields as CharacterRevision;
  const entry: CharacterRevision = Object.freeze({
    characterId,
    kind,
    targetId,
    origin,
    cause,
    source,
    rulepack: Object.freeze({ id: rulepack.id, edition: rulepack.edition, revision: rulepack.revision }),
    previous,
    next,
  });
  const continuity = continuityIssues(log, entry);
  if (continuity.length > 0) return { ok: false, error: { code: 'InvalidAction', issues: continuity } };
  return { ok: true, log: Object.freeze([...log, entry]) };
};
