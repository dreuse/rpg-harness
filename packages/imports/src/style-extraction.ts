import { MAX_STYLE_ITEMS, STYLE_FIELDS, type Style, toStyle } from '../../domain/src/style.ts';
import type { Interpreter } from './interpretation.ts';
import { interpretImported, type UntrustedContent } from './untrusted.ts';

const styleOf = async (clause: UntrustedContent, interpret: Interpreter): Promise<Style | undefined> => {
  try {
    return toStyle(await interpret(interpretImported(clause)));
  } catch {
    return undefined;
  }
};

export const extractStyle = async (
  clauses: readonly UntrustedContent[],
  interpret: Interpreter,
): Promise<Style | undefined> => {
  const styles = (await Promise.all(clauses.map((clause) => styleOf(clause, interpret)))).filter(
    (style) => style !== undefined,
  );
  const merged = Object.fromEntries(
    STYLE_FIELDS.flatMap((field) => {
      const items = [...new Set(styles.flatMap((style) => style[field] ?? []))].slice(0, MAX_STYLE_ITEMS);
      return items.length === 0 ? [] : [[field, items]];
    }),
  );
  return Object.keys(merged).length === 0 ? undefined : merged;
};
