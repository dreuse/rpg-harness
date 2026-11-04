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

const ENV_PREFIX = 'RPG_VOICE_';
const ENV_SUFFIX = '_API_KEY';
const ENV_UNSAFE_CHARACTERS = /[^A-Z0-9]/g;
const ENV_SEPARATOR = '_';

export const secretEnvName = (providerId: string): string =>
  `${ENV_PREFIX}${providerId.toUpperCase().replace(ENV_UNSAFE_CHARACTERS, ENV_SEPARATOR)}${ENV_SUFFIX}`;

export const envSecretReader = (env: Readonly<Record<string, string | undefined>>): SecretReader => ({
  get: async (providerId) => {
    const value = env[secretEnvName(providerId)];
    return value?.trim() ? new Credential(value) : undefined;
  },
});

export type ProbeResult = 'ok' | 'unreachable' | 'unsupported';
export type ProviderHealth = ProbeResult | 'missing-credential';

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

export const checkProviderHealth = async (
  provider: ProviderDescriptor,
  secrets: SecretReader,
  probe: ProviderProbe,
): Promise<ProviderDiagnostic> => {
  const credential = provider.requiresCredential ? await secrets.get(provider.id) : undefined;
  const status =
    provider.requiresCredential && !credential ? 'missing-credential' : await probeSafely(probe, provider, credential);
  return { providerId: provider.id, kind: provider.kind, locality: provider.locality, status };
};
