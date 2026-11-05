import { inflateSync } from 'node:zlib';

export type Image = { readonly width: number; readonly height: number; readonly channels: number; data: Uint8Array };
export type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
export type Rgb = readonly [number, number, number];
export type AuditText = {
  readonly color: Rgb;
  readonly background: Rgb;
  readonly size: number;
  readonly bold: boolean;
};
export type AuditElement = {
  readonly tag: string;
  readonly id: string;
  readonly role: string;
  readonly type: string;
  readonly name: string;
  readonly refs: readonly string[];
  readonly visible: boolean;
  readonly text?: AuditText;
};
export type AuditPage = { readonly lang: string; readonly title: string; readonly elements: readonly AuditElement[] };
export type Impact = 'minor' | 'moderate' | 'serious' | 'critical';
export type Violation = { readonly rule: string; readonly impact: Impact; readonly target: string };

export const BLOCKING_IMPACTS: readonly Impact[] = ['serious', 'critical'];

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const LENGTH_BYTES = 4;
const TYPE_BYTES = 4;
const CRC_BYTES = 4;
const BIT_DEPTH = 8;
const NOT_INTERLACED = 0;
const CHANNELS_BY_COLOR_TYPE: Readonly<Record<number, number>> = { 2: 3, 6: 4 };
const HEADER = { width: 0, height: 4, bitDepth: 8, colorType: 9, interlace: 12 } as const;
const FILTER = { none: 0, sub: 1, up: 2, average: 3, paeth: 4 } as const;
const BYTE_MASK = 0xff;
const RGB_CHANNELS = 3;

const paeth = (left: number, up: number, upLeft: number) => {
  const estimate = left + up - upLeft;
  const [toLeft, toUp, toUpLeft] = [left, up, upLeft].map((value) => Math.abs(estimate - value));
  if ((toLeft ?? 0) <= (toUp ?? 0) && (toLeft ?? 0) <= (toUpLeft ?? 0)) return left;
  return (toUp ?? 0) <= (toUpLeft ?? 0) ? up : upLeft;
};

const predictor = (filter: number, left: number, up: number, upLeft: number) => {
  if (filter === FILTER.none) return 0;
  if (filter === FILTER.sub) return left;
  if (filter === FILTER.up) return up;
  if (filter === FILTER.average) return Math.floor((left + up) / 2);
  if (filter === FILTER.paeth) return paeth(left, up, upLeft);
  throw new RangeError(`unknown PNG row filter ${filter}`);
};

export const decodePng = (file: Uint8Array): Image => {
  const bytes = Buffer.from(file);
  if (!bytes.subarray(0, SIGNATURE.length).equals(SIGNATURE)) throw new RangeError('not a PNG file');
  let header: Buffer | undefined;
  const parts: Buffer[] = [];
  for (let offset = SIGNATURE.length; offset < bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + LENGTH_BYTES, offset + LENGTH_BYTES + TYPE_BYTES);
    const start = offset + LENGTH_BYTES + TYPE_BYTES;
    if (type === 'IHDR') header = bytes.subarray(start, start + length);
    if (type === 'IDAT') parts.push(bytes.subarray(start, start + length));
    offset = start + length + CRC_BYTES;
  }
  const channels = CHANNELS_BY_COLOR_TYPE[header?.readUInt8(HEADER.colorType) ?? -1];
  if (
    header === undefined ||
    channels === undefined ||
    header.readUInt8(HEADER.bitDepth) !== BIT_DEPTH ||
    header.readUInt8(HEADER.interlace) !== NOT_INTERLACED
  )
    throw new RangeError('only 8-bit RGB or RGBA non-interlaced PNG files are supported');
  const width = header.readUInt32BE(HEADER.width);
  const height = header.readUInt32BE(HEADER.height);
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const data = new Uint8Array(stride * height);
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)] ?? FILTER.none;
    const source = row * (stride + 1) + 1;
    const target = row * stride;
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? (data[target + index - channels] ?? 0) : 0;
      const up = row > 0 ? (data[target + index - stride] ?? 0) : 0;
      const upLeft = row > 0 && index >= channels ? (data[target + index - stride - channels] ?? 0) : 0;
      data[target + index] = ((raw[source + index] ?? 0) + predictor(filter, left, up, upLeft)) & BYTE_MASK;
    }
  }
  return { width, height, channels, data };
};

export const CHANNEL_TOLERANCE = 16;

const masked = (masks: readonly Rect[], x: number, y: number) =>
  masks.some((mask) => x >= mask.x && x < mask.x + mask.width && y >= mask.y && y < mask.y + mask.height);

export const pixelDiffRatio = (expected: Image, actual: Image, masks: readonly Rect[] = []) => {
  if (expected.width !== actual.width || expected.height !== actual.height) return 1;
  let compared = 0;
  let changed = 0;
  for (let y = 0; y < expected.height; y += 1)
    for (let x = 0; x < expected.width; x += 1) {
      if (masked(masks, x, y)) continue;
      compared += 1;
      const pixel = y * expected.width + x;
      for (let channel = 0; channel < RGB_CHANNELS; channel += 1) {
        const before = expected.data[pixel * expected.channels + channel] ?? 0;
        const after = actual.data[pixel * actual.channels + channel] ?? 0;
        if (Math.abs(before - after) > CHANNEL_TOLERANCE) {
          changed += 1;
          break;
        }
      }
    }
  return compared === 0 ? 0 : changed / compared;
};

const CHANNEL_MAX = 255;
const LINEAR_THRESHOLD = 0.03928;
const LINEAR_SLOPE = 12.92;
const GAMMA_OFFSET = 0.055;
const GAMMA_SCALE = 1.055;
const GAMMA = 2.4;
const LUMINANCE_WEIGHTS = [0.2126, 0.7152, 0.0722];
const CONTRAST_OFFSET = 0.05;
const NORMAL_TEXT_CONTRAST = 4.5;
const LARGE_TEXT_CONTRAST = 3;
const LARGE_TEXT_PX = 24;
const LARGE_BOLD_TEXT_PX = 18.66;
const BUTTON_TAGS = ['button', 'summary'];
const BUTTON_ROLE = 'button';
const FIELD_TAGS = ['input', 'select', 'textarea'];
const UNLABELLED_INPUT_TYPES = ['hidden', 'submit', 'button', 'reset'];
const IMAGE_TAG = 'img';

const luminance = (rgb: Rgb) =>
  rgb
    .map((value) => value / CHANNEL_MAX)
    .map((channel) =>
      channel <= LINEAR_THRESHOLD ? channel / LINEAR_SLOPE : ((channel + GAMMA_OFFSET) / GAMMA_SCALE) ** GAMMA,
    )
    .reduce((sum, channel, index) => sum + channel * (LUMINANCE_WEIGHTS[index] ?? 0), 0);

export const contrastRatio = (foreground: Rgb, background: Rgb) => {
  const [high = 0, low = 0] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (high + CONTRAST_OFFSET) / (low + CONTRAST_OFFSET);
};

const required = ({ size, bold }: AuditText) =>
  size >= LARGE_TEXT_PX || (bold && size >= LARGE_BOLD_TEXT_PX) ? LARGE_TEXT_CONTRAST : NORMAL_TEXT_CONTRAST;

const targetOf = ({ tag, id }: AuditElement) => (id === '' ? tag : `${tag}#${id}`);

const elementRules: readonly ((element: AuditElement) => Omit<Violation, 'target'> | undefined)[] = [
  ({ tag, role, name }) =>
    (BUTTON_TAGS.includes(tag) || role === BUTTON_ROLE) && name === ''
      ? { rule: 'button-name', impact: 'critical' }
      : undefined,
  ({ tag, type, name }) =>
    FIELD_TAGS.includes(tag) && !UNLABELLED_INPUT_TYPES.includes(type) && name === ''
      ? { rule: 'label', impact: 'critical' }
      : undefined,
  ({ tag, name }) => (tag === IMAGE_TAG && name === '' ? { rule: 'image-alt', impact: 'critical' } : undefined),
];

export const auditPage = ({ lang, title, elements }: AuditPage): Violation[] => {
  const ids = elements.map(({ id }) => id).filter((id) => id !== '');
  const page: Violation[] = [
    ...(lang === '' ? [{ rule: 'html-has-lang', impact: 'serious', target: 'html' } as const] : []),
    ...(title === '' ? [{ rule: 'document-title', impact: 'serious', target: 'title' } as const] : []),
  ];
  const visible = elements.filter((element) => element.visible);
  return [
    ...page,
    ...visible.flatMap((element) =>
      elementRules.flatMap((rule) => {
        const found = rule(element);
        return found === undefined ? [] : [{ ...found, target: targetOf(element) }];
      }),
    ),
    ...[...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))].map(
      (id) => ({ rule: 'duplicate-id', impact: 'serious', target: `#${id}` }) as const,
    ),
    ...elements.flatMap((element) =>
      element.refs
        .filter((ref) => !ids.includes(ref))
        .map(
          (ref) =>
            ({ rule: 'aria-valid-reference', impact: 'critical', target: `${targetOf(element)} -> #${ref}` }) as const,
        ),
    ),
    ...visible.flatMap(({ text, ...element }) =>
      text !== undefined && contrastRatio(text.color, text.background) < required(text)
        ? [{ rule: 'color-contrast', impact: 'serious', target: targetOf({ ...element }) } as const]
        : [],
    ),
  ];
};
