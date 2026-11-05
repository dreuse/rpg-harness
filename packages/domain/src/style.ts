export const STYLE_FIELDS = ['tone', 'voice', 'vocabulary', 'pacing', 'sceneStructure', 'keepOutOfProse'] as const;
export const INVALID_STYLE =
  'must list tone, voice, vocabulary, pacing, sceneStructure or keepOutOfProse as short text';
export const MAX_STYLE_ITEMS = 8;
export const MAX_STYLE_ITEM_LENGTH = 200;

export type StyleField = (typeof STYLE_FIELDS)[number];
export type Style = { readonly [Field in StyleField]?: readonly string[] };

const isStyleField = (key: string): key is StyleField => STYLE_FIELDS.some((field) => field === key);
const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '' && value.length <= MAX_STYLE_ITEM_LENGTH;
const isTextList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.length <= MAX_STYLE_ITEMS && value.every(isText);

export const toStyle = (value: unknown): Style | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.every(([key, list]) => isStyleField(key) && isTextList(list))) return undefined;
  return Object.fromEntries(entries.map(([key, list]) => [key, [...(list as readonly string[])]]));
};
