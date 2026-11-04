import type {
  CharacterProfile,
  ProfileTrait,
  ProfileTraitValue,
  ProfileVisibility,
  RulePackLink,
} from '../../domain/src/character.ts';
import type { EntityId } from '../../domain/src/entity.ts';
import { canonicalFacts, type Fact, PLAYER_VIEWER } from '../../memory/src/knowledge.ts';
import { type BuildResult, buildCharacter, type CreationRules } from '../../rules/src/character-builder.ts';
import type { SheetProvenance, SheetSchema } from '../../rules/src/sheet-schema.ts';

export const NARRATIVE_ROLES = ['minor', 'recurring', 'major'] as const;
export const FULL_SHEET_ROLES: readonly NarrativeRole[] = ['recurring', 'major'];

export type NarrativeRole = (typeof NARRATIVE_ROLES)[number];
export type SparseNpcSheet = {
  readonly detail: 'sparse';
  readonly npcId: EntityId;
  readonly role: NarrativeRole;
  readonly name: string;
  readonly motivations: readonly string[];
  readonly background: string;
  readonly traits: readonly ProfileTrait[];
  readonly rulepack: RulePackLink;
};
export type FullNpcSheet = {
  readonly detail: 'full';
  readonly npcId: EntityId;
  readonly role: NarrativeRole;
  readonly profile: CharacterProfile;
  readonly rulepack: SheetProvenance;
};
export type NpcSheet = SparseNpcSheet | FullNpcSheet;
export type NpcExpansion = { readonly rules: CreationRules; readonly values: Record<string, ProfileTraitValue> };
export type NpcRoleResult =
  | { status: 'sparse'; sheet: SparseNpcSheet }
  | { status: 'expanded'; sheet: FullNpcSheet }
  | Exclude<BuildResult, { status: 'created' }>;
export type NpcPreviewTrait = { id: string; label?: string; value: ProfileTraitValue };
export type NpcPreview = {
  readonly npcId: EntityId;
  readonly name: string;
  readonly traits: readonly NpcPreviewTrait[];
  readonly facts: readonly string[];
};

const PLAYER_VISIBLE_FIELD = 'public';
const GM_ONLY_PROFILE: ProfileVisibility = 'gm';
const HIDDEN_NAME = '';
const RULEPACK_MISMATCH = {
  path: 'rulepack',
  code: 'invalid',
  message: 'must match the sheet schema rulepack',
} as const;

const sameRulepack = (link: RulePackLink, provenance: SheetProvenance) =>
  link.id === provenance.id && link.edition === provenance.edition && link.revision === provenance.revision;

const expand = (sheet: SparseNpcSheet, role: NarrativeRole, { rules, values }: NpcExpansion): NpcRoleResult => {
  if (!sameRulepack(sheet.rulepack, rules.schema.rulepack)) return { status: 'rejected', issues: [RULEPACK_MISMATCH] };
  const built = buildCharacter({
    rules,
    backstory: sheet.background,
    proposal: {
      name: sheet.name,
      values: { ...Object.fromEntries(sheet.traits.map(({ id, value }) => [id, value])), ...values },
      equipment: [],
    },
  });
  if (built.status !== 'created') return built;
  const { profile, provenance } = built.character;
  return {
    status: 'expanded',
    sheet: {
      detail: 'full',
      npcId: sheet.npcId,
      role,
      profile: { ...profile, motivations: [...sheet.motivations] },
      rulepack: provenance.rulepack,
    },
  };
};

export const assignNpcRole = (sheet: NpcSheet, role: NarrativeRole, expansion: NpcExpansion): NpcRoleResult => {
  if (sheet.detail === 'full') return { status: 'expanded', sheet: { ...sheet, role } };
  if (!FULL_SHEET_ROLES.includes(role)) return { status: 'sparse', sheet: { ...sheet, role } };
  return expand(sheet, role, expansion);
};

const nameOf = (sheet: NpcSheet) => (sheet.detail === 'full' ? sheet.profile.identity.name : sheet.name);
const traitsOf = (sheet: NpcSheet) => (sheet.detail === 'full' ? sheet.profile.traits : sheet.traits);
const rulepackOf = (sheet: NpcSheet) => (sheet.detail === 'full' ? sheet.profile.rulepack : sheet.rulepack);

export const npcPreview = (
  sheet: NpcSheet,
  schema: SheetSchema,
  facts: readonly Fact[],
  visibility: ProfileVisibility,
): NpcPreview => {
  if (visibility === GM_ONLY_PROFILE) return { npcId: sheet.npcId, name: HIDDEN_NAME, traits: [], facts: [] };
  const matches = sameRulepack(rulepackOf(sheet), schema.rulepack);
  const values = new Map(matches ? traitsOf(sheet).map(({ id, value }) => [id, value]) : []);
  return {
    npcId: sheet.npcId,
    name: nameOf(sheet),
    traits: schema.fields
      .filter((field) => field.visibility === PLAYER_VISIBLE_FIELD && !field.derived && values.has(field.id))
      .map((field) => ({
        id: field.id,
        ...(field.label === undefined ? {} : { label: field.label }),
        value: values.get(field.id) as ProfileTraitValue,
      })),
    facts: canonicalFacts(facts, PLAYER_VIEWER)
      .filter(({ subjectId }) => subjectId === sheet.npcId)
      .map(({ statement }) => statement),
  };
};
