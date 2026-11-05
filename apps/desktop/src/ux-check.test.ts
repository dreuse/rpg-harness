import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import {
  type AuditElement,
  type AuditPage,
  auditPage,
  BLOCKING_IMPACTS,
  decodePng,
  type Image,
  pixelDiffRatio,
} from './ux-check.ts';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const RGB = 2;
const RGBA = 6;
const BIT_DEPTH = 8;

const chunk = (type: string, data: Uint8Array) => {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
};

const png = (width: number, height: number, colorType: number, rows: readonly number[]) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(BIT_DEPTH, 8);
  header.writeUInt8(colorType, 9);
  return Buffer.concat([
    Buffer.from(SIGNATURE),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from(rows))),
    chunk('IEND', new Uint8Array()),
  ]);
};

test('rpg-42a.17 decodePng reverses every PNG row filter for RGB images', () => {
  const filtered = [
    [1, 10, 20, 30, 5, 5, 5],
    [4, 2, 2, 2, 5, 5, 5],
    [3, 10, 15, 20, 12, 12, 12],
    [2, 1, 1, 1, 1, 1, 1],
  ].flat();
  const image = decodePng(png(2, 4, RGB, filtered));
  assert.deepEqual([image.width, image.height, image.channels], [2, 4, 3]);
  assert.deepEqual(
    [...image.data],
    [10, 20, 30, 15, 25, 35, 12, 22, 32, 20, 30, 40, 16, 26, 36, 30, 40, 50, 17, 27, 37, 31, 41, 51],
  );
});

test('rpg-42a.17 decodePng reads RGBA images and rejects anything that is not a PNG', () => {
  const image = decodePng(png(1, 1, RGBA, [0, 1, 2, 3, 4]));
  assert.deepEqual([image.channels, ...image.data], [4, 1, 2, 3, 4]);
  assert.throws(() => decodePng(Buffer.from('not a png')), /PNG/);
});

const solid = (width: number, height: number, value: number): Image => ({
  width,
  height,
  channels: 3,
  data: new Uint8Array(width * height * 3).fill(value),
});

test('rpg-42a.17 pixelDiffRatio counts changed pixels, ignores small noise and masked areas', () => {
  const base = solid(4, 4, 100);
  const changed = solid(4, 4, 100);
  changed.data.set([200, 200, 200], 0);
  changed.data.set([104, 104, 104], 3 * 5);
  assert.equal(pixelDiffRatio(base, base), 0);
  assert.equal(pixelDiffRatio(base, changed), 1 / 16);
  assert.equal(pixelDiffRatio(base, changed, [{ x: 0, y: 0, width: 1, height: 1 }]), 0);
  assert.equal(pixelDiffRatio(base, solid(2, 2, 100)), 1);
});

const element = (overrides: Partial<AuditElement>): AuditElement => ({
  tag: 'p',
  id: '',
  role: '',
  type: '',
  name: '',
  refs: [],
  visible: true,
  ...overrides,
});

const page = (elements: readonly AuditElement[], overrides: Partial<AuditPage> = {}): AuditPage => ({
  lang: 'en',
  title: 'RPG Harness',
  elements,
  ...overrides,
});

const rules = (audited: AuditPage) => auditPage(audited).map(({ rule, impact }) => `${rule}:${impact}`);

test('rpg-42a.17 auditPage passes a labelled, readable page', () => {
  const clean = page([
    element({ tag: 'button', name: 'Send' }),
    element({ tag: 'input', type: 'text', id: 'a', name: 'Your action' }),
    element({ tag: 'section', refs: ['a'] }),
    element({ tag: 'p', text: { color: [27, 29, 33], background: [246, 246, 244], size: 16, bold: false } }),
    element({ tag: 'button', visible: false }),
  ]);
  assert.deepEqual(auditPage(clean), []);
});

test('rpg-42a.17 auditPage reports serious and critical violations like axe-core', () => {
  const broken = page(
    [
      element({ tag: 'button' }),
      element({ tag: 'summary' }),
      element({ tag: 'input', type: 'search' }),
      element({ tag: 'input', type: 'hidden' }),
      element({ tag: 'img' }),
      element({ tag: 'div', id: 'twin' }),
      element({ tag: 'div', id: 'twin', refs: ['missing'] }),
      element({ tag: 'p', text: { color: [150, 150, 150], background: [255, 255, 255], size: 16, bold: false } }),
      element({ tag: 'h1', text: { color: [130, 130, 130], background: [255, 255, 255], size: 32, bold: true } }),
    ],
    { lang: '', title: '' },
  );
  assert.deepEqual(rules(broken), [
    'html-has-lang:serious',
    'document-title:serious',
    'button-name:critical',
    'button-name:critical',
    'label:critical',
    'image-alt:critical',
    'duplicate-id:serious',
    'aria-valid-reference:critical',
    'color-contrast:serious',
  ]);
  assert.ok(auditPage(broken).every(({ impact }) => BLOCKING_IMPACTS.includes(impact)));
});
