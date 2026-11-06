import type { CampaignState } from '../../../packages/domain/src/campaign.ts';
import type { OocProposal, OocReply } from '../../../packages/domain/src/ooc.ts';
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
const SPACES = /\s+/gu;
const TRAILING_PUNCTUATION = /[\s.!?]+$/u;
const SIGN = /\s/gu;
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

export const summaryOf = (locale: string, proposal: OocProposal): string => {
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

export const fakeOocReply = (text: string, locale: string): OocReply => {
  const line = oneLine(text);
  if (line === '') return { reply: say(locale, 'ooc.empty'), proposals: [] };
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
