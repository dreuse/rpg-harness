import { type GenrePackIssue, isPlainRecord, readStringList, unknownFields } from './genrepack.ts';

const STORY_FIELDS = ['tone', 'openingScenes', 'conflicts'] as const;

export type StoryKit = { readonly [field in (typeof STORY_FIELDS)[number]]: readonly string[] };
export type StoryKitResult = { ok: true; kit: StoryKit } | { ok: false; issues: GenrePackIssue[] };

export const loadStoryKit = (input: unknown): StoryKitResult => {
  if (!isPlainRecord(input)) return { ok: false, issues: [{ path: '', message: 'must be an object' }] };
  const issues = unknownFields(input, STORY_FIELDS, '');
  const kit = Object.fromEntries(
    STORY_FIELDS.map((field) => [field, Object.freeze(readStringList(input[field], field, issues))]),
  ) as StoryKit;
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, kit: Object.freeze(kit) };
};
