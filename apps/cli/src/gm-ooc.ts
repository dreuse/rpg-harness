import type { CampaignState } from '../../../packages/domain/src/campaign.ts';
import type { OocProposal, OocReply } from '../../../packages/domain/src/ooc.ts';
import type { StoryMemoryEntry } from '../../../packages/domain/src/story-memory.ts';
import {
  MAX_OOC_SUMMARY_LENGTH,
  MAX_TABLE_NOTE_LENGTH,
  oocStateOf,
  type RollCorrector,
} from '../../../packages/engine/src/ooc.ts';
import { campaignConfigOf } from '../../../packages/engine/src/turn.ts';
import {
  applyHouseRule,
  baseEffectiveRules,
  type EffectiveResult,
  type EffectiveRules,
} from '../../../packages/imports/src/house-rules.ts';
import { parseCampaignConfig } from '../../../packages/intent/src/config.ts';
import { D20_LITE_MANIFEST, NATURAL_MAX, NATURAL_MIN } from '../../../packages/rules/src/d20-lite.ts';
import { replayRoll } from '../../../packages/rules/src/dice.ts';
import { DICE_POOL_LITE_MANIFEST } from '../../../packages/rules/src/dice-pool-lite.ts';
import type { CompiledRule } from '../../../packages/rules/src/dsl.ts';
import { isRecord, type RulePackManifest } from '../../../packages/rules/src/rulepack.ts';
import { say } from './messages.ts';

const ROLL_FIX_WORDS =
  /(?:forgot|missed|left out|esqueceu|esqueceste|faltou)\s+(?:my\s+|the\s+|o\s+|meu\s+)?([+-]\s*\d+)\s*(?:for|from|because of|de|por|pelo|pela|do|da)?\s*(.*)$/iu;
const RETCON_WORDS = /\b(?:undo|retcon|take (?:that )?back|rewind|desfaz(?:er)?|voltar|retroceder)\b/iu;
const CANON_WORDS =
  /^(?:(?:actually|na verdade)[\s,]+)?(?:(?:the|o|a)\s+)?(.+?)\s+(?:is|está|esta|é)\s+(alive|dead|vivo|viva|morto|morta)$/iu;
const ALIVE_WORDS = new Set(['alive', 'vivo', 'viva']);
const ALIVE_CLAIM = 'alive';
const ALIVE_VALUE = 'alive';
const DEAD_VALUE = 'dead';
const SPACES = /\s+/gu;
const TRAILING_PUNCTUATION = /[\s.!?]+$/u;
const SIGN = /\s/gu;
const NAME_GROUP = 1;
const STATE_GROUP = 2;
const REASON_GROUP = 2;
const VALUE_GROUP = 1;
const HOUSE_RULE_AUTHOR = 'player';
const HOUSE_RULE_SOURCE = 'house_rule';
const NO_BASE_RULES: readonly CompiledRule[] = [];
const ISSUE_SEPARATOR = '; ';
const ROLL_FIX_MODIFIER_ID = 'table-correction';
const ATTACK_EVENT_PREFIX = 'attack.';

const isAttack = (events: unknown) =>
  Array.isArray(events) &&
  events.some(
    (entry) => isRecord(entry) && typeof entry.event === 'string' && entry.event.startsWith(ATTACK_EVENT_PREFIX),
  );

export const correctD20Roll: RollCorrector = (resolution, { value, reason }) => {
  const { rolls, bonus, target, modifiers, keep, events } = isRecord(resolution)
    ? resolution
    : ({} as Record<string, unknown>);
  const first = Array.isArray(rolls) ? replayRoll(rolls[0]) : undefined;
  if (first?.ok !== true || !Number.isFinite(bonus) || !Number.isFinite(target) || isAttack(events)) return undefined;
  const faces = first.event.draws.flat();
  const face = keep === 'lowest' ? Math.min(...faces) : keep === 'highest' ? Math.max(...faces) : (faces[0] as number);
  const total = Number(bonus) + value;
  const outcome =
    face === NATURAL_MAX
      ? 'check.critical'
      : face === NATURAL_MIN
        ? 'check.fumble'
        : face + total >= Number(target)
          ? 'check.success'
          : 'check.failure';
  return {
    ...(resolution as Record<string, unknown>),
    ok: true,
    events: [{ event: outcome }],
    bonus: total,
    modifiers: [
      ...(Array.isArray(modifiers) ? modifiers : []),
      { id: ROLL_FIX_MODIFIER_ID, reason, effect: { kind: 'flat', value } },
    ],
  };
};

const oneLine = (text: string) => text.replace(SPACES, ' ').trim();

const signedValue = (value: number) => (value > 0 ? `+${value}` : String(value));

const ruleBodyOf = ({ id: _id, source: _source, ...body }: Readonly<Record<string, unknown>>) =>
  oneLine(JSON.stringify(body));

const subjectOf = (proposal: Extract<OocProposal, { kind: 'canon_fix' }>, facts: readonly StoryMemoryEntry[]) => {
  const name = facts.find(({ entityId }) => entityId === proposal.entityId)?.entityName ?? proposal.entityId;
  return oneLine(`${name} (${proposal.claimKind}${proposal.key === undefined ? '' : ` ${proposal.key}`})`);
};

export const summaryOf = (locale: string, proposal: OocProposal, facts: readonly StoryMemoryEntry[] = []): string => {
  if (proposal.kind === 'canon_fix')
    return say(locale, 'ooc.summary.canonFix', {
      subject: subjectOf(proposal, facts),
      value: oneLine(proposal.value),
    });
  if (proposal.kind === 'roll_fix')
    return say(locale, 'ooc.summary.rollFix', {
      value: signedValue(proposal.value),
      reason: oneLine(proposal.reason),
    });
  if (proposal.kind === 'table_note') return say(locale, 'ooc.summary.note', { note: oneLine(proposal.note) });
  if (proposal.kind === 'house_rule')
    return say(locale, 'ooc.summary.houseRule', {
      id: oneLine(String(proposal.rule.id)),
      rule: ruleBodyOf(proposal.rule),
    });
  return say(locale, 'ooc.summary.retcon');
};

const canonFixOf = (
  line: string,
  locale: string,
  facts: readonly StoryMemoryEntry[],
): { reply: OocReply['reply']; proposal: OocProposal } | undefined => {
  const found = CANON_WORDS.exec(line.replace(TRAILING_PUNCTUATION, ''));
  const name = found?.[NAME_GROUP]?.toLowerCase();
  const state = found?.[STATE_GROUP]?.toLowerCase();
  const fact = facts.find(({ kind, entityName }) => kind === ALIVE_CLAIM && entityName.toLowerCase() === name);
  if (fact === undefined || state === undefined) return undefined;
  const proposal: OocProposal = {
    kind: 'canon_fix',
    summary: '',
    entityId: fact.entityId,
    claimKind: ALIVE_CLAIM,
    value: ALIVE_WORDS.has(state) ? ALIVE_VALUE : DEAD_VALUE,
  };
  const summary = summaryOf(locale, proposal, facts);
  const params = { subject: subjectOf(proposal, facts), value: proposal.value };
  return { reply: say(locale, 'ooc.reply.canonFix', params), proposal: { ...proposal, summary } };
};

export const fakeOocReply = (text: string, locale: string, facts: readonly StoryMemoryEntry[] = []): OocReply => {
  const line = oneLine(text);
  if (line === '') return { reply: say(locale, 'ooc.empty'), proposals: [] };
  const canon = canonFixOf(line, locale, facts);
  if (canon !== undefined) return { reply: canon.reply, proposals: [canon.proposal] };
  const fix = ROLL_FIX_WORDS.exec(line);
  if (fix !== null) {
    const value = Number((fix[VALUE_GROUP] as string).replace(SIGN, ''));
    const reason = (fix[REASON_GROUP] ?? '').replace(TRAILING_PUNCTUATION, '').trim() || say(locale, 'ooc.fixReason');
    const params = { value: signedValue(value), reason };
    const proposal: OocProposal = {
      kind: 'roll_fix',
      summary: say(locale, 'ooc.summary.rollFix', params),
      reason,
      value,
    };
    return { reply: say(locale, 'ooc.reply.rollFix', params), proposals: [proposal] };
  }
  if (RETCON_WORDS.test(line))
    return {
      reply: say(locale, 'ooc.reply.retcon'),
      proposals: [{ kind: 'retcon_last_turn', summary: say(locale, 'ooc.summary.retcon') }],
    };
  const summary = say(locale, 'ooc.summary.note', { note: line });
  if (line.length > MAX_TABLE_NOTE_LENGTH || summary.length > MAX_OOC_SUMMARY_LENGTH)
    return { reply: say(locale, 'ooc.tooLong', { max: MAX_TABLE_NOTE_LENGTH }), proposals: [] };
  return { reply: say(locale, 'ooc.reply.note'), proposals: [{ kind: 'table_note', summary, note: line }] };
};

const PACKS: readonly RulePackManifest[] = [D20_LITE_MANIFEST, DICE_POOL_LITE_MANIFEST];

const effectiveRulesOf = (state: CampaignState): EffectiveResult | undefined => {
  const saved = parseCampaignConfig(campaignConfigOf(state.events));
  const ref = saved.ok ? saved.config.rulepack : null;
  const pack = PACKS.find(
    ({ id, edition, revision }) => id === ref?.id && edition === ref.edition && revision === ref.revision,
  );
  if (pack === undefined) return undefined;
  return baseEffectiveRules(pack, NO_BASE_RULES);
};

const resultFailure = (result: Extract<EffectiveResult, { ok: false }>) => {
  const { error } = result;
  const issues = 'issues' in error ? error.issues : [];
  return new Error(issues.map(({ message }) => message).join(ISSUE_SEPARATOR) || String(error.code));
};

export const houseRuleOf = (state: CampaignState, proposal: Readonly<Record<string, unknown>>, locale: string) => {
  const rule = isRecord(proposal.rule) ? proposal.rule : {};
  const input = {
    id: rule.id,
    source: { kind: HOUSE_RULE_SOURCE, author: HOUSE_RULE_AUTHOR, note: oneLine(String(proposal.summary ?? '')) },
    rule: rule.rule,
  };
  let effective: EffectiveResult | undefined = effectiveRulesOf(state);
  if (effective === undefined) throw new Error(say(locale, 'ooc.noRulebook'));
  for (const earlier of [...oocStateOf(state.changes).houseRules, input]) {
    if (!effective.ok) break;
    effective = applyHouseRule(effective.effective as EffectiveRules, earlier);
  }
  if (!effective.ok) throw resultFailure(effective);
  return input;
};
