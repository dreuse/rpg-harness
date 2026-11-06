import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { F5_SERVICE_SOURCE } from './f5-tts-engine.ts';
import { F5_VOICES } from './f5-voices.ts';

const PYTHON = 'python3';
const PYTHON_AVAILABLE = spawnSync(PYTHON, ['--version']).status === 0;
const VOICE = F5_VOICES[0]?.id ?? '';

const runService = (code: string, input = ''): string => {
  const result = spawnSync(
    PYTHON,
    [
      '-I',
      '-B',
      '-c',
      `import importlib.util as u, json, sys
spec = u.spec_from_file_location('service', ${JSON.stringify(F5_SERVICE_SOURCE)})
service = u.module_from_spec(spec)
spec.loader.exec_module(service)
${code}`,
    ],
    { input },
  );
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout.toString();
};

const parsed = (request: unknown): unknown =>
  JSON.parse(
    runService(
      `print(json.dumps(service.parse(sys.stdin.read(), {${JSON.stringify(VOICE)}: {}})))`,
      JSON.stringify(request),
    ),
  );

const VALID = { text: 'Olá, mundo.', voice: VOICE, speed: 1.1 };

describe('f5 service', { skip: PYTHON_AVAILABLE ? false : 'python3 is not installed' }, () => {
  it('accepts a valid request', () => {
    assert.deepEqual(parsed(VALID), ['Olá, mundo.', VOICE, 1.1]);
  });

  it('expands digits through the injected converter and leaves other text alone', () => {
    const expanded = (text: string): string =>
      JSON.parse(runService(`print(json.dumps(service.expand_digits(sys.stdin.read(), lambda n: '<%d>' % n)))`, text));
    assert.equal(expanded('Tenho 42 gatos.'), 'Tenho <42> gatos.');
    assert.equal(expanded('1.000 moedas e 12.500'), '<1000> moedas e <12500>');
    assert.equal(expanded('3,5 e 3.5'), '<3> vírgula <5> e <3> vírgula <5>');
    assert.equal(expanded('0,05'), '<0> vírgula <0> <5>');
    assert.equal(expanded('10m e 3d6'), '<10> m e <3> d <6>');
    assert.equal(expanded('Olá, mundo.\nSem números.'), 'Olá, mundo.\nSem números.');
  });

  it('keeps the digits when the converter fails', () => {
    const code = `def fail(n):
    raise OverflowError(n)
print(json.dumps(service.expand_digits(sys.stdin.read(), fail)))`;
    assert.equal(JSON.parse(runService(code, 'Serial 12345 e 3,5.')), 'Serial 12345 e 3,5.');
  });

  it('rejects an unknown voice, empty or oversized text and out-of-range or non-numeric speed', () => {
    const bad = [
      { ...VALID, voice: '../../etc/passwd' },
      { ...VALID, text: '   ' },
      { ...VALID, text: 'a'.repeat(2001) },
      { ...VALID, speed: 5 },
      { ...VALID, speed: 0.1 },
      { ...VALID, speed: true },
      { ...VALID, speed: '1' },
    ];
    for (const request of bad) assert.equal(parsed(request), null, JSON.stringify(request));
  });

  it('extracts only the wanted members from a streamed archive and stops reading once it has them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rpg-f5-tar-'));
    try {
      const out = runService(
        `import io, tarfile
buffer = io.BytesIO()
with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
    for name, data in [('dev/skip.wav', b'skip'), ('dev/a.wav', b'AAAA'), ('dev/b.wav', b'BBBBBB')]:
        info = tarfile.TarInfo(name)
        info.size = len(data)
        archive.addfile(info, io.BytesIO(data))
buffer.seek(0)
members = [{'member': 'dev/a.wav', 'target': 'voices/a.wav'}, {'member': 'dev/b.wav', 'target': 'voices/b.wav'}]
service.extract_members(buffer, members, 1_000_000, ${JSON.stringify(dir)})
for name in ('a', 'b'):
    print(open(${JSON.stringify(dir)} + '/voices/' + name + '.wav', 'rb').read().decode())
try:
    buffer.seek(0)
    service.extract_members(buffer, [{'member': 'dev/missing.wav', 'target': 'voices/m.wav'}], 1_000_000, ${JSON.stringify(dir)})
except ValueError as error:
    print(error)
buffer.seek(0)
try:
    service.extract_members(buffer, members, 10, ${JSON.stringify(dir)})
except ValueError as error:
    print(error)`,
      ).split('\n');
      assert.deepEqual(out.slice(0, 4), [
        'AAAA',
        'BBBBBB',
        'archive is missing dev/missing.wav',
        'archive read limit exceeded',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('answers 400 to a negative or non-numeric Content-Length instead of waiting for the body', () => {
    const out = runService(
      `import socket, threading
from http.server import HTTPServer
class Model:
    voices = {${JSON.stringify(VOICE)}: {}}
server = HTTPServer(('127.0.0.1', 0), service.handler(Model(), 'token'))
threading.Thread(target=server.serve_forever, daemon=True).start()
for length in ('-1', 'abc'):
    with socket.create_connection(server.server_address, timeout=5) as client:
        client.sendall(('POST /synthesize HTTP/1.1\\r\\nHost: x\\r\\nAuthorization: Bearer token\\r\\nContent-Length: ' + length + '\\r\\n\\r\\n').encode())
        print(client.recv(64).decode().split(' ')[1])`,
    );
    assert.deepEqual(out.trim().split('\n'), ['400', '400']);
  });

  it('binds loopback, requires a bearer token, and sets its limits', () => {
    const source = readFileSync(F5_SERVICE_SOURCE, 'utf8');
    assert.ok(source.includes('HOST = "127.0.0.1"'));
    assert.ok(source.includes('hmac.compare_digest'));
    assert.ok(source.includes('MAX_BODY_BYTES'));
  });
});
