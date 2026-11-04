import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTOCOL_ERROR_CODES } from './protocol.ts';
import { parseViewDescriptor, VIEW_IDS, VIEW_REGISTRY } from './view-registry.ts';

const descriptor = (viewId: string, kind: string, extra: object = {}) => ({
  viewId,
  components: [{ kind, id: 'c1', label: 'Label', ...extra }],
});

const expectRejected = (input: unknown) => {
  const result = parseViewDescriptor(input);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(PROTOCOL_ERROR_CODES.includes(result.error.code));
};

test('represent sheet, inventory, quest, encounter, clock, map and investigation views', () => {
  assert.deepEqual([...VIEW_IDS], ['sheet', 'inventory', 'quest', 'encounter', 'clock', 'map', 'investigation']);
  for (const viewId of VIEW_IDS) {
    const kind = VIEW_REGISTRY[viewId][0] as string;
    const result = parseViewDescriptor(descriptor(viewId, kind));
    assert.equal(result.ok, true, viewId);
    if (result.ok) {
      assert.equal(result.value.viewId, viewId);
      assert.ok(Object.isFrozen(result.value));
      assert.ok(Object.isFrozen(result.value.components[0]));
    }
  }
});

test('renderers reject unapproved arbitrary ui code in imported packs', () => {
  const valid = descriptor('sheet', 'field');
  expectRejected(null);
  expectRejected([]);
  expectRejected({ ...valid, viewId: 'dashboard' });
  expectRejected(descriptor('sheet', 'iframe'));
  expectRejected(descriptor('clock', 'field'));
  expectRejected({ ...valid, onClick: () => 1 });
  for (const key of ['script', 'render', 'html', 'component', 'code', 'onClick']) {
    expectRejected({ ...valid, [key]: 'x' });
    expectRejected(descriptor('sheet', 'field', { [key]: 'x' }));
  }
  expectRejected(descriptor('sheet', 'field', { label: () => 'x' }));
  expectRejected(descriptor('sheet', 'field', { label: 1 }));
  expectRejected(descriptor('sheet', 'field', { id: '' }));
  expectRejected({ viewId: 'sheet', components: [valid.components[0], valid.components[0]] });
  expectRejected({ viewId: 'sheet', components: 'x' });
  expectRejected({ ...valid, components: { ...valid.components, length: 1 } });
  expectRejected(
    Object.defineProperties({ viewId: 'sheet' }, { components: { get: () => valid.components, enumerable: true } }),
  );
  expectRejected({
    viewId: 'sheet',
    components: [Object.defineProperties({ kind: 'field', id: 'c1' }, { label: { get: () => 'x', enumerable: true } })],
  });
  expectRejected(
    new (class Sheet {
      viewId = 'sheet';
      components = [];
    })(),
  );
  expectRejected(JSON.parse('{"viewId":"sheet","components":[],"__proto__":{"x":1}}'));
  expectRejected(descriptor('sheet', 'field', { constructor: 'x' }));
  expectRejected({ ...valid, [Symbol('s')]: 1 });
  expectRejected(
    new Proxy(valid, {
      ownKeys() {
        throw new Error('trap');
      },
    }),
  );
  expectRejected({
    viewId: 'sheet',
    components: new Proxy([], {
      get() {
        throw new Error('trap');
      },
    }),
  });
});

test('labels stay inert text and the input is copied', () => {
  const label = '<script>alert(1)</script>';
  const input = descriptor('sheet', 'field', { label });
  const result = parseViewDescriptor(input);
  assert.equal(result.ok && result.value.components[0]?.label, label);
  assert.notEqual(result.ok && result.value.components[0], input.components[0]);
});
