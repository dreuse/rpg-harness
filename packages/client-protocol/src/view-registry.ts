import {
  deepFreeze,
  type ProtocolErrorCode,
  type Result,
  VIEW_COMPONENT_KINDS,
  type ViewComponent,
  type ViewComponentKind,
  type ViewDescriptor,
  type ViewValue,
} from './protocol.ts';

export const VIEW_IDS = ['sheet', 'inventory', 'quest', 'encounter', 'clock', 'map', 'investigation'] as const;
export type ViewId = (typeof VIEW_IDS)[number];
export const SHEET_VIEW: ViewId = 'sheet';

export const VIEW_REGISTRY: Readonly<Record<ViewId, readonly ViewComponentKind[]>> = {
  sheet: ['field', 'group', 'progress', 'roll', 'relationship'],
  inventory: ['inventory', 'field', 'group'],
  quest: ['quest', 'journal', 'progress', 'group'],
  encounter: ['encounter', 'roll', 'progress', 'clock', 'group'],
  clock: ['clock', 'progress'],
  map: ['map', 'group', 'field'],
  investigation: ['investigation', 'journal', 'relationship', 'clock', 'group'],
};

const DESCRIPTOR_KEYS = ['campaignId', 'viewId', 'components'];
const COMPONENT_KEYS = ['kind', 'id', 'label', 'value', 'group', 'editable', 'explanation'];

export const failure = (code: ProtocolErrorCode, message: string): Result<never> => ({
  ok: false,
  error: { code, message },
});

const isViewId = (value: unknown): value is ViewId => VIEW_IDS.some((known) => known === value);
const isViewValue = (value: unknown): value is ViewValue =>
  value === null || typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value);
const isKind = (value: unknown): value is ViewComponentKind => VIEW_COMPONENT_KINDS.some((known) => known === value);

type Plain = { readonly values: Record<string, unknown> };

export const readPlain = (input: unknown, allowed: readonly string[], what: string): Result<Plain> => {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return failure('MalformedCommand', `${what} must be a plain object`);
    }
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) return failure('MalformedCommand', `${what} must be plain data`);
    const values: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== 'string' || !allowed.includes(key)) {
        return failure('UnexpectedField', `${what} does not accept ${String(key)}`);
      }
      const property = Object.getOwnPropertyDescriptor(input, key);
      if (property === undefined || !('value' in property)) {
        return failure('MalformedCommand', `${what}.${key} must be plain data`);
      }
      values[key] = property.value;
    }
    return { ok: true, value: { values } };
  } catch {
    return failure('MalformedCommand', `${what} is unreadable`);
  }
};

export const readList = (input: unknown): readonly unknown[] | undefined => {
  try {
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) return undefined;
    const items: unknown[] = [];
    for (let index = 0; index < input.length; index += 1) {
      const property = Object.getOwnPropertyDescriptor(input, index);
      if (property === undefined || !('value' in property)) return undefined;
      items.push(property.value);
    }
    return items;
  } catch {
    return undefined;
  }
};

const sheetDetails = (values: Record<string, unknown>): Result<Partial<ViewComponent>> => {
  const { group, editable, explanation } = values;
  if (group !== undefined && (typeof group !== 'string' || group.length === 0))
    return failure('MalformedCommand', 'component.group must be a non-empty text');
  if (editable !== undefined && typeof editable !== 'boolean')
    return failure('MalformedCommand', 'component.editable must be a flag');
  if (explanation !== undefined && typeof explanation !== 'string')
    return failure('MalformedCommand', 'component.explanation must be text');
  return {
    ok: true,
    value: {
      ...(group === undefined ? {} : { group }),
      ...(editable === undefined ? {} : { editable }),
      ...(explanation === undefined ? {} : { explanation }),
    },
  };
};

const parseComponent = (input: unknown, viewId: ViewId): Result<ViewComponent> => {
  const plain = readPlain(input, COMPONENT_KEYS, 'component');
  if (!plain.ok) return plain;
  const { values } = plain.value;
  const { kind, id, label, value } = values;
  if (!isKind(kind)) return failure('Rejected', `unknown component kind ${String(kind)}`);
  if (!VIEW_REGISTRY[viewId].includes(kind)) return failure('Rejected', `${viewId} does not allow ${kind}`);
  if (typeof id !== 'string' || id.length === 0)
    return failure('MalformedCommand', 'component.id is missing or invalid');
  if (typeof label !== 'string') return failure('MalformedCommand', 'component.label is missing or invalid');
  if (Object.hasOwn(values, 'value') && !isViewValue(value))
    return failure('MalformedCommand', 'component.value must be plain text, number or flag');
  const details = sheetDetails(values);
  if (!details.ok) return details;
  const shown = Object.hasOwn(values, 'value') ? { value: value as ViewValue } : {};
  return { ok: true, value: { kind, id, label, ...shown, ...details.value } };
};

export const parseViewDescriptor = (input: unknown): Result<ViewDescriptor> => {
  const plain = readPlain(input, DESCRIPTOR_KEYS, 'view descriptor');
  if (!plain.ok) return plain;
  const { campaignId, viewId, components } = plain.value.values;
  if (typeof campaignId !== 'string' || campaignId.length === 0)
    return failure('MalformedCommand', 'view descriptor needs a campaignId');
  if (!isViewId(viewId)) return failure('Rejected', `unknown view ${String(viewId)}`);
  const items = readList(components);
  if (items === undefined) return failure('MalformedCommand', 'components must be a plain array');
  const parsed: ViewComponent[] = [];
  for (const item of items) {
    const component = parseComponent(item, viewId);
    if (!component.ok) return component;
    if (parsed.some((seen) => seen.id === component.value.id)) {
      return failure('Rejected', `duplicate component id ${component.value.id}`);
    }
    parsed.push(component.value);
  }
  return { ok: true, value: deepFreeze({ campaignId, viewId, components: parsed }) };
};
