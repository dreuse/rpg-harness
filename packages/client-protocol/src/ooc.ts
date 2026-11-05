const SLASH_PREFIX = /^\/gm(?:\s+([\s\S]*))?$/i;
const PARENTHESES = /^\(\(([\s\S]*)\)\)$/;
const TEXT_GROUP = 1;

export const parseOocInput = (input: string): string | undefined => {
  const trimmed = input.trim();
  const found = SLASH_PREFIX.exec(trimmed) ?? PARENTHESES.exec(trimmed);
  return found === null ? undefined : (found[TEXT_GROUP] ?? '').trim();
};
