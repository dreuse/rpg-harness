import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';
import {
  type Credential,
  checkProviderHealth,
  chooseProvider,
  envSecretReader,
  findEnvNameCollisions,
  KEYCHAIN_SERVICE,
  type KeychainBackend,
  type KeychainExec,
  keychainSecretStore,
  macosKeychainBackend,
  memorySecretStore,
  type ProbeResult,
  type ProviderDescriptor,
  type ProviderProbe,
  secretEnvName,
  validateProviderCatalog,
} from './providers.ts';

const LOCAL_STT_ID = 'local-whisper';
const REMOTE_STT_ID = 'cloud-stt';
const REMOTE_TTS_ID = 'cloud.tts-v2';
const UNKNOWN_ID = 'dnd-1.9-voice';
const API_KEY = 'sk-live-very-secret-4242';
const REMOTE_TTS_ENV = 'RPG_VOICE_CLOUD_TTS_V2_API_KEY';

const catalog: readonly ProviderDescriptor[] = [
  { id: LOCAL_STT_ID, kind: 'stt', locality: 'local', retention: 'none', requiresCredential: false },
  { id: REMOTE_STT_ID, kind: 'stt', locality: 'cloud', retention: 'session', requiresCredential: true },
  { id: REMOTE_TTS_ID, kind: 'tts', locality: 'cloud', retention: 'none', requiresCredential: true },
];

const descriptor = (id: string): ProviderDescriptor => {
  const found = catalog.find((provider) => provider.id === id);
  assert.ok(found);
  return found;
};

interface ProbeCall {
  readonly providerId: string;
  readonly secret: string | undefined;
}

const fakeKeychain = (): KeychainBackend & { readonly entries: Map<string, string> } => {
  const entries = new Map<string, string>();
  const key = (service: string, account: string): string => `${service}/${account}`;
  return {
    entries,
    getPassword: async (service, account) => entries.get(key(service, account)),
    setPassword: async (service, account, password) => {
      entries.set(key(service, account), password);
    },
    deletePassword: async (service, account) => {
      entries.delete(key(service, account));
    },
  };
};

const SECURITY_ITEM_NOT_FOUND = 44;
const SECURITY_FAILURE = 51;

interface ExecCall {
  readonly command: string;
  readonly args: readonly string[];
}

const fakeExec = (stdout: string, exitCode: number, calls: ExecCall[] = []): KeychainExec => {
  return async (command, args) => {
    calls.push({ command, args });
    return { stdout, exitCode };
  };
};

const failingReader = { get: async () => Promise.reject(new Error(`keychain locked ${API_KEY}`)) };

const fakeProbe = (result: ProbeResult | Error, calls: ProbeCall[] = []): ProviderProbe => {
  return async (provider, credential) => {
    calls.push({ providerId: provider.id, secret: credential?.reveal() });
    if (result instanceof Error) throw result;
    return result;
  };
};

test('allow local/provider choice, api key safe storage and availability diagnostics', async (t) => {
  await t.test('chooses a local or a remote provider by kind', () => {
    assert.deepEqual(chooseProvider(catalog, 'stt', LOCAL_STT_ID), { ok: true, provider: descriptor(LOCAL_STT_ID) });
    assert.deepEqual(chooseProvider(catalog, 'stt', REMOTE_STT_ID), { ok: true, provider: descriptor(REMOTE_STT_ID) });
    assert.deepEqual(chooseProvider(catalog, 'tts', REMOTE_TTS_ID), { ok: true, provider: descriptor(REMOTE_TTS_ID) });
  });

  await t.test('returns a typed error for an unknown id and never substitutes another provider', () => {
    assert.deepEqual(chooseProvider(catalog, 'stt', UNKNOWN_ID), {
      ok: false,
      error: { code: 'unknown-provider', kind: 'stt', providerId: UNKNOWN_ID },
    });
    assert.deepEqual(chooseProvider(catalog, 'tts', LOCAL_STT_ID), {
      ok: false,
      error: { code: 'unknown-provider', kind: 'tts', providerId: LOCAL_STT_ID },
    });
    assert.deepEqual(chooseProvider([], 'tts', REMOTE_TTS_ID), {
      ok: false,
      error: { code: 'unknown-provider', kind: 'tts', providerId: REMOTE_TTS_ID },
    });
  });

  await t.test('stores, reads and deletes a credential by provider id', async () => {
    const store = memorySecretStore();
    assert.equal(await store.get(REMOTE_STT_ID), undefined);
    await store.set(REMOTE_STT_ID, API_KEY);
    assert.equal((await store.get(REMOTE_STT_ID))?.reveal(), API_KEY);
    assert.equal(await store.get(REMOTE_TTS_ID), undefined);
    await store.delete(REMOTE_STT_ID);
    assert.equal(await store.get(REMOTE_STT_ID), undefined);
  });

  await t.test('rejects an empty credential', async () => {
    const store = memorySecretStore();
    await assert.rejects(store.set(REMOTE_STT_ID, ''), RangeError);
    await assert.rejects(store.set(REMOTE_STT_ID, '   '), RangeError);
  });

  await t.test('reads a credential from an environment variable named after the provider', async () => {
    assert.equal(secretEnvName(REMOTE_TTS_ID), REMOTE_TTS_ENV);
    const reader = envSecretReader({ [REMOTE_TTS_ENV]: API_KEY, [secretEnvName(REMOTE_STT_ID)]: '' });
    assert.equal((await reader.get(REMOTE_TTS_ID))?.reveal(), API_KEY);
    assert.equal(await reader.get(REMOTE_STT_ID), undefined);
    assert.equal(await reader.get(LOCAL_STT_ID), undefined);
  });

  await t.test('trims the environment value before creating the credential', async () => {
    const reader = envSecretReader({ [REMOTE_TTS_ENV]: `  ${API_KEY}\n` });
    assert.equal((await reader.get(REMOTE_TTS_ID))?.reveal(), API_KEY);
  });

  await t.test('finds provider ids whose environment variable names collide', () => {
    assert.deepEqual(findEnvNameCollisions(['cloud.tts', 'cloud-tts', 'CLOUD_TTS', LOCAL_STT_ID]), [
      'cloud.tts',
      'cloud-tts',
      'CLOUD_TTS',
    ]);
    assert.deepEqual(findEnvNameCollisions(catalog.map((provider) => provider.id)), []);
  });

  await t.test('rejects a catalog whose provider ids share an environment variable name', () => {
    assert.deepEqual(validateProviderCatalog(catalog), { ok: true, catalog });
    const colliding = [...catalog, { ...catalog[2], id: 'cloud-tts-v2' }] as readonly ProviderDescriptor[];
    assert.deepEqual(validateProviderCatalog(colliding), {
      ok: false,
      error: { code: 'env-name-collision', providerIds: [REMOTE_TTS_ID, 'cloud-tts-v2'] },
    });
  });

  await t.test('stores, reads and deletes a credential in the OS keychain backend', async () => {
    const backend = fakeKeychain();
    const store = keychainSecretStore(backend);
    assert.equal(await store.get(REMOTE_STT_ID), undefined);
    await store.set(REMOTE_STT_ID, API_KEY);
    assert.equal(backend.entries.get(`${KEYCHAIN_SERVICE}/${REMOTE_STT_ID}`), API_KEY);
    assert.equal((await store.get(REMOTE_STT_ID))?.reveal(), API_KEY);
    await store.delete(REMOTE_STT_ID);
    assert.equal(await store.get(REMOTE_STT_ID), undefined);
  });

  await t.test('treats an empty keychain value as absent and rejects an empty credential', async () => {
    const backend = fakeKeychain();
    backend.entries.set(`${KEYCHAIN_SERVICE}/${REMOTE_STT_ID}`, '   ');
    const store = keychainSecretStore(backend);
    assert.equal(await store.get(REMOTE_STT_ID), undefined);
    await assert.rejects(store.set(REMOTE_TTS_ID, ' '), RangeError);
    assert.equal(backend.entries.has(`${KEYCHAIN_SERVICE}/${REMOTE_TTS_ID}`), false);
  });

  await t.test('stores the trimmed secret in the keychain backend', async () => {
    const backend = fakeKeychain();
    await keychainSecretStore(backend).set(REMOTE_STT_ID, ' key ');
    assert.equal(backend.entries.get(`${KEYCHAIN_SERVICE}/${REMOTE_STT_ID}`), 'key');
  });

  await t.test('reads a macOS keychain password and strips the trailing newline', async () => {
    const calls: ExecCall[] = [];
    const backend = macosKeychainBackend(fakeExec(`${API_KEY}\n`, 0, calls));
    assert.equal(await backend.getPassword(KEYCHAIN_SERVICE, REMOTE_STT_ID), API_KEY);
    assert.deepEqual(calls, [
      { command: 'security', args: ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', REMOTE_STT_ID, '-w'] },
    ]);
  });

  await t.test('treats a missing macOS keychain entry as absent', async () => {
    const backend = macosKeychainBackend(fakeExec('', SECURITY_ITEM_NOT_FOUND));
    assert.equal(await backend.getPassword(KEYCHAIN_SERVICE, REMOTE_STT_ID), undefined);
    await backend.deletePassword(KEYCHAIN_SERVICE, REMOTE_STT_ID);
  });

  await t.test('writes and deletes macOS keychain entries', async () => {
    const calls: ExecCall[] = [];
    const backend = macosKeychainBackend(fakeExec('', 0, calls));
    await backend.setPassword(KEYCHAIN_SERVICE, REMOTE_STT_ID, API_KEY);
    await backend.deletePassword(KEYCHAIN_SERVICE, REMOTE_STT_ID);
    assert.deepEqual(calls, [
      {
        command: 'security',
        args: ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', REMOTE_STT_ID, '-w', API_KEY],
      },
      { command: 'security', args: ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', REMOTE_STT_ID] },
    ]);
  });

  await t.test('throws on macOS keychain failures without exposing the password', async () => {
    const backend = macosKeychainBackend(fakeExec(API_KEY, SECURITY_FAILURE));
    const hidesSecret = (error: unknown): boolean =>
      error instanceof Error && !inspect(error).includes(API_KEY) && !error.message.includes(API_KEY);
    await assert.rejects(backend.setPassword(KEYCHAIN_SERVICE, REMOTE_STT_ID, API_KEY), hidesSecret);
    await assert.rejects(backend.getPassword(KEYCHAIN_SERVICE, REMOTE_STT_ID), hidesSecret);
    await assert.rejects(backend.deletePassword(KEYCHAIN_SERVICE, REMOTE_STT_ID), hidesSecret);
  });

  await t.test('reports credential-store-error without probing when the store fails', async () => {
    const calls: ProbeCall[] = [];
    const health = await checkProviderHealth(descriptor(REMOTE_STT_ID), failingReader, fakeProbe('ok', calls));
    assert.deepEqual(health, {
      providerId: REMOTE_STT_ID,
      kind: 'stt',
      locality: 'cloud',
      status: 'credential-store-error',
    });
    assert.deepEqual(calls, []);
  });

  await t.test('reports ok for a local provider without asking for a credential', async () => {
    const calls: ProbeCall[] = [];
    const health = await checkProviderHealth(descriptor(LOCAL_STT_ID), memorySecretStore(), fakeProbe('ok', calls));
    assert.deepEqual(health, { providerId: LOCAL_STT_ID, kind: 'stt', locality: 'local', status: 'ok' });
    assert.deepEqual(calls, [{ providerId: LOCAL_STT_ID, secret: undefined }]);
  });

  await t.test('reports missing-credential without probing a remote provider', async () => {
    const calls: ProbeCall[] = [];
    const health = await checkProviderHealth(descriptor(REMOTE_STT_ID), memorySecretStore(), fakeProbe('ok', calls));
    assert.equal(health.status, 'missing-credential');
    assert.deepEqual(calls, []);
  });

  await t.test('passes the stored credential to the probe and reports its result', async () => {
    const store = memorySecretStore();
    await store.set(REMOTE_STT_ID, API_KEY);
    const calls: ProbeCall[] = [];
    const ok = await checkProviderHealth(descriptor(REMOTE_STT_ID), store, fakeProbe('ok', calls));
    assert.equal(ok.status, 'ok');
    assert.deepEqual(calls, [{ providerId: REMOTE_STT_ID, secret: API_KEY }]);
    const down = await checkProviderHealth(descriptor(REMOTE_STT_ID), store, fakeProbe('unreachable'));
    assert.equal(down.status, 'unreachable');
    const unsupported = await checkProviderHealth(descriptor(LOCAL_STT_ID), store, fakeProbe('unsupported'));
    assert.equal(unsupported.status, 'unsupported');
  });

  await t.test('reports unreachable when the probe throws', async () => {
    const health = await checkProviderHealth(
      descriptor(LOCAL_STT_ID),
      memorySecretStore(),
      fakeProbe(new Error('connect ECONNREFUSED')),
    );
    assert.equal(health.status, 'unreachable');
  });
});

test('no credentials are logged or committed to campaign exports', async (t) => {
  const store = memorySecretStore();
  await store.set(REMOTE_TTS_ID, API_KEY);
  const credential = (await store.get(REMOTE_TTS_ID)) as Credential;

  const assertAbsent = (value: unknown): void => {
    assert.doesNotMatch(JSON.stringify(value) ?? '', new RegExp(API_KEY));
    assert.doesNotMatch(String(value), new RegExp(API_KEY));
    assert.doesNotMatch(inspect(value, { showHidden: true, depth: Number.POSITIVE_INFINITY }), new RegExp(API_KEY));
  };

  await t.test('a credential never serializes, prints or inspects its value', () => {
    assertAbsent(credential);
    assertAbsent({ credential });
    assert.doesNotMatch(`${credential}`, new RegExp(API_KEY));
  });

  await t.test('the store itself never exposes stored values when logged or exported', () => {
    assertAbsent(store);
  });

  await t.test('provider choice config and diagnostics hold no credential', async () => {
    const choice = chooseProvider(catalog, 'tts', REMOTE_TTS_ID);
    assertAbsent(choice);
    const diagnostics = await Promise.all([
      checkProviderHealth(descriptor(REMOTE_TTS_ID), store, fakeProbe('ok')),
      checkProviderHealth(descriptor(REMOTE_TTS_ID), store, fakeProbe('unreachable')),
      checkProviderHealth(descriptor(REMOTE_TTS_ID), store, fakeProbe(new Error(`401 bad key ${API_KEY}`))),
      checkProviderHealth(descriptor(REMOTE_TTS_ID), failingReader, fakeProbe('ok')),
    ]);
    assertAbsent(diagnostics);
    assertAbsent({ campaign: { voice: { choice, diagnostics } } });
  });

  await t.test('an env reader never exposes the environment it reads', async () => {
    const reader = envSecretReader({ [REMOTE_TTS_ENV]: API_KEY });
    assertAbsent(reader);
    assertAbsent(await reader.get(REMOTE_TTS_ID));
  });

  await t.test('a keychain store never exposes stored values when logged or exported', async () => {
    const keychain = keychainSecretStore(fakeKeychain());
    await keychain.set(REMOTE_TTS_ID, API_KEY);
    assertAbsent(keychain);
    assertAbsent(await keychain.get(REMOTE_TTS_ID));
  });

  await t.test('rejected input errors never echo the credential', async () => {
    const error = await memorySecretStore()
      .set(REMOTE_TTS_ID, ' ')
      .catch((caught: unknown) => caught);
    assertAbsent(error);
  });
});
