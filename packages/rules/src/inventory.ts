import type { ResolutionError } from './resolve.ts';
import type { TraitSheet } from './traits.ts';

export const EQUIPPED_PREFIX = 'equipped:';

export type ModifierSource = { id: string; modifiers: Readonly<Record<string, number>> };
export type SheetResult = { ok: true; sheet: TraitSheet } | { ok: false; error: ResolutionError };

type MarkerKind = 'tag' | 'condition';

const equippedId = (itemId: string) =>
  typeof itemId === 'string' && itemId.length > 0 ? `${EQUIPPED_PREFIX}${itemId}` : '';

const hasMarker = (sheet: TraitSheet, id: string, kind: MarkerKind) =>
  sheet.traits.some((trait) => trait.id === id && trait.kind === kind);

export const rejectPrecondition = (path: string, message: string): SheetResult => ({
  ok: false,
  error: { code: 'PreconditionFailed', issues: [{ path, message }] },
});

const isValidId = (id: unknown): id is string => typeof id === 'string' && id.length > 0;

const addMarker = (sheet: TraitSheet, id: string, kind: MarkerKind): SheetResult =>
  !isValidId(id)
    ? rejectPrecondition('id', 'must be a non-empty string')
    : sheet.traits.some((trait) => trait.id === id)
      ? rejectPrecondition(id, 'is already present')
      : { ok: true, sheet: { ...sheet, traits: [...sheet.traits, { id, kind }] } };

const removeMarker = (sheet: TraitSheet, id: string, kind: MarkerKind): SheetResult =>
  hasMarker(sheet, id, kind)
    ? { ok: true, sheet: { ...sheet, traits: sheet.traits.filter((trait) => trait.id !== id) } }
    : rejectPrecondition(id, `must be an active ${kind}`);

export const equip = (sheet: TraitSheet, itemId: string) => addMarker(sheet, equippedId(itemId), 'tag');
export const unequip = (sheet: TraitSheet, itemId: string) => removeMarker(sheet, equippedId(itemId), 'tag');
export const applyEffect = (sheet: TraitSheet, effectId: string) => addMarker(sheet, effectId, 'condition');
export const endEffect = (sheet: TraitSheet, effectId: string) => removeMarker(sheet, effectId, 'condition');

export const activeModifiers = (
  sheet: TraitSheet,
  items: readonly ModifierSource[],
  effects: readonly ModifierSource[],
): Record<string, number> => {
  const active = [
    ...items.filter((item) => hasMarker(sheet, equippedId(item.id), 'tag')),
    ...effects.filter((effect) => hasMarker(sheet, effect.id, 'condition')),
  ];
  const totals = new Map<string, number>();
  for (const source of active)
    for (const [key, value] of Object.entries(source.modifiers)) totals.set(key, (totals.get(key) ?? 0) + value);
  return Object.fromEntries(totals);
};
