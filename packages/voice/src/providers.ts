import type { Locality, PrivacyDisclosure } from './voice.ts';

export type ProviderKind = 'stt' | 'tts';

export interface ProviderDescriptor extends PrivacyDisclosure {
  readonly kind: ProviderKind;
  readonly requiresCredential: boolean;
}

export interface UnknownProviderError {
  readonly code: 'unknown-provider';
  readonly kind: ProviderKind;
  readonly providerId: string;
}

export type ProviderChoice =
  | { readonly ok: true; readonly provider: ProviderDescriptor }
  | { readonly ok: false; readonly error: UnknownProviderError };

export const chooseProvider = (
  catalog: readonly ProviderDescriptor[],
  kind: ProviderKind,
  providerId: string,
): ProviderChoice => {
  const provider = catalog.find((candidate) => candidate.id === providerId && candidate.kind === kind);
  return provider ? { ok: true, provider } : { ok: false, error: { code: 'unknown-provider', kind, providerId } };
};

export class Credential {
  readonly #value: string;

  constructor(value: string) {
    if (value.trim() === '') throw new RangeError('credential must be non-empty');
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }
}

export interface SecretStore {
  get(providerId: string): Promise<Credential | undefined>;
  set(providerId: string, secret: string): Promise<void>;
  delete(providerId: string): Promise<void>;
}

export type SecretReader = Pick<SecretStore, 'get'>;

export const memorySecretStore = (): SecretStore => {
  const secrets = new Map<string, Credential>();
  return {
    get: async (providerId) => secrets.get(providerId),
    set: async (providerId, secret) => {
      secrets.set(providerId, new Credential(secret));
    },
    delete: async (providerId) => {
      secrets.delete(providerId);
    },
  };
};

export const KEYCHAIN_SERVICE = 'rpg-harness.voice';

export interface KeychainBackend {
  getPassword(service: string, account: string): Promise<string | undefined>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<void>;
}

const toCredential = (value: string | undefined): Credential | undefined => {
  const trimmed = value?.trim();
  return trimmed ? new Credential(trimmed) : undefined;
};

export const keychainSecretStore = (backend: KeychainBackend): SecretStore => ({
  get: async (providerId) => toCredential(await backend.getPassword(KEYCHAIN_SERVICE, providerId)),
  set: async (providerId, secret) => {
    await backend.setPassword(KEYCHAIN_SERVICE, providerId, new Credential(secret).reveal());
  },
  delete: async (providerId) => {
    await backend.deletePassword(KEYCHAIN_SERVICE, providerId);
  },
});

const ENV_PREFIX = 'RPG_VOICE_';
const ENV_SUFFIX = '_API_KEY';
const ENV_UNSAFE_CHARACTERS = /[^A-Z0-9]/g;
const ENV_SEPARATOR = '_';

export const secretEnvName = (providerId: string): string =>
  `${ENV_PREFIX}${providerId.toUpperCase().replace(ENV_UNSAFE_CHARACTERS, ENV_SEPARATOR)}${ENV_SUFFIX}`;

export const envSecretReader = (env: Readonly<Record<string, string | undefined>>): SecretReader => ({
  get: async (providerId) => toCredential(env[secretEnvName(providerId)]),
});

export const findEnvNameCollisions = (providerIds: readonly string[]): string[] => {
  const counts = new Map<string, number>();
  for (const id of providerIds) counts.set(secretEnvName(id), (counts.get(secretEnvName(id)) ?? 0) + 1);
  return providerIds.filter((id) => (counts.get(secretEnvName(id)) ?? 0) > 1);
};

export type ProbeResult = 'ok' | 'unreachable' | 'unsupported';
export type ProviderHealth = ProbeResult | 'missing-credential' | 'credential-store-error';

export type ProviderProbe = (provider: ProviderDescriptor, credential: Credential | undefined) => Promise<ProbeResult>;

export interface ProviderDiagnostic {
  readonly providerId: string;
  readonly kind: ProviderKind;
  readonly locality: Locality;
  readonly status: ProviderHealth;
}

const probeSafely = async (
  probe: ProviderProbe,
  provider: ProviderDescriptor,
  credential: Credential | undefined,
): Promise<ProbeResult> => {
  try {
    return await probe(provider, credential);
  } catch {
    return 'unreachable';
  }
};

const CREDENTIAL_STORE_ERROR = Symbol('credential-store-error');

const readCredentialSafely = async (
  secrets: SecretReader,
  providerId: string,
): Promise<Credential | undefined | typeof CREDENTIAL_STORE_ERROR> => {
  try {
    return await secrets.get(providerId);
  } catch {
    return CREDENTIAL_STORE_ERROR;
  }
};

const healthOf = async (
  provider: ProviderDescriptor,
  secrets: SecretReader,
  probe: ProviderProbe,
): Promise<ProviderHealth> => {
  if (!provider.requiresCredential) return probeSafely(probe, provider, undefined);
  const credential = await readCredentialSafely(secrets, provider.id);
  if (credential === CREDENTIAL_STORE_ERROR) return 'credential-store-error';
  return credential ? probeSafely(probe, provider, credential) : 'missing-credential';
};

export const checkProviderHealth = async (
  provider: ProviderDescriptor,
  secrets: SecretReader,
  probe: ProviderProbe,
): Promise<ProviderDiagnostic> => ({
  providerId: provider.id,
  kind: provider.kind,
  locality: provider.locality,
  status: await healthOf(provider, secrets, probe),
});

export interface EnvNameCollisionError {
  readonly code: 'env-name-collision';
  readonly providerIds: readonly string[];
}

export type CatalogValidation =
  | { readonly ok: true; readonly catalog: readonly ProviderDescriptor[] }
  | { readonly ok: false; readonly error: EnvNameCollisionError };

export const validateProviderCatalog = (catalog: readonly ProviderDescriptor[]): CatalogValidation => {
  const providerIds = findEnvNameCollisions(catalog.map((provider) => provider.id));
  return providerIds.length === 0
    ? { ok: true, catalog }
    : { ok: false, error: { code: 'env-name-collision', providerIds } };
};
