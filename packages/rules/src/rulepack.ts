export const RULEPACK_CONTRACT_VERSION = 1;

export const SUPPORTED_PRIMITIVES = [
  'random',
  'comparison',
  'arithmetic',
  'modifier',
  'resourceCost',
  'condition',
  'actionOrder',
  'decision',
  'transition',
  'effects',
] as const;

export type Primitive = (typeof SUPPORTED_PRIMITIVES)[number];

const ADJUDICATED = 'adjudicated';

export type CapabilityValue = boolean | typeof ADJUDICATED;
export type CapabilityState = 'deterministic' | typeof ADJUDICATED | 'disabled';

export type RulePackManifest = {
  contractVersion: typeof RULEPACK_CONTRACT_VERSION;
  id: string;
  edition: string;
  revision: string;
  capabilities: Record<string, CapabilityValue>;
  characterSheetSchemaId?: string;
  sourceRefs: string[];
};

export type ManifestIssue = { path: string; message: string };
export type ManifestResult = { ok: true; manifest: RulePackManifest } | { ok: false; issues: ManifestIssue[] };

const REQUIRED_STRINGS = ['id', 'edition', 'revision'] as const;
export const NON_EMPTY_STRING = 'must be a non-empty string';

export const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

export const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const isCapabilityValue = (value: unknown): value is CapabilityValue =>
  typeof value === 'boolean' || value === ADJUDICATED;

export const validateManifest = (input: unknown): ManifestResult => {
  if (!isRecord(input)) return { ok: false, issues: [{ path: '', message: 'must be an object' }] };
  const { contractVersion, id, edition, revision, capabilities, characterSheetSchemaId, sourceRefs } = input;
  const hasSheet = Object.hasOwn(input, 'characterSheetSchemaId');
  const issues: ManifestIssue[] = [];
  if (contractVersion !== RULEPACK_CONTRACT_VERSION) {
    issues.push({ path: 'contractVersion', message: `must be ${RULEPACK_CONTRACT_VERSION}` });
  }
  const strings = { id, edition, revision };
  for (const key of REQUIRED_STRINGS) {
    if (!isNonEmptyString(strings[key])) issues.push({ path: key, message: NON_EMPTY_STRING });
  }
  const capabilityEntries = isRecord(capabilities) ? Object.entries(capabilities) : [];
  if (!isRecord(capabilities)) issues.push({ path: 'capabilities', message: 'must be an object' });
  for (const [name, value] of capabilityEntries) {
    if (name.length === 0) issues.push({ path: 'capabilities', message: 'keys must be non-empty strings' });
    if (!isCapabilityValue(value)) {
      issues.push({ path: `capabilities.${name}`, message: `must be boolean or '${ADJUDICATED}'` });
    }
  }
  if (hasSheet && !isNonEmptyString(characterSheetSchemaId)) {
    issues.push({ path: 'characterSheetSchemaId', message: NON_EMPTY_STRING });
  }
  const refs: unknown[] = Array.isArray(sourceRefs) ? [...sourceRefs] : [];
  if (!Array.isArray(sourceRefs)) issues.push({ path: 'sourceRefs', message: 'must be an array' });
  refs.forEach((ref, index) => {
    if (typeof ref !== 'string') issues.push({ path: `sourceRefs.${index}`, message: 'must be a string' });
  });
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    manifest: {
      contractVersion: RULEPACK_CONTRACT_VERSION,
      id: id as string,
      edition: edition as string,
      revision: revision as string,
      capabilities: Object.fromEntries(capabilityEntries) as Record<string, CapabilityValue>,
      ...(hasSheet ? { characterSheetSchemaId: characterSheetSchemaId as string } : {}),
      sourceRefs: refs as string[],
    },
  };
};

const toState = (value: CapabilityValue | undefined): CapabilityState => {
  if (value === true) return 'deterministic';
  if (value === ADJUDICATED) return ADJUDICATED;
  return 'disabled';
};

export const capabilityState = (manifest: RulePackManifest, name: string): CapabilityState =>
  toState(Object.hasOwn(manifest.capabilities, name) ? manifest.capabilities[name] : undefined);

export const listCapabilities = (manifest: RulePackManifest) =>
  Object.entries(manifest.capabilities).map(([name, value]) => ({ name, state: toState(value) }));

export class CapabilityDisabledError extends Error {
  readonly code = 'CapabilityDisabled';
  readonly packId: string;
  readonly capability: string;

  constructor(packId: string, capability: string) {
    super(`Capability ${capability} is disabled in rule pack ${packId}`);
    this.name = 'CapabilityDisabledError';
    this.packId = packId;
    this.capability = capability;
  }
}

export const requireCapability = (manifest: RulePackManifest, name: string): Exclude<CapabilityState, 'disabled'> => {
  const state = capabilityState(manifest, name);
  if (state === 'disabled') throw new CapabilityDisabledError(manifest.id, name);
  return state;
};
