import type { CampaignIntent, Client, IntentField, Provenance } from './intent.ts';
import type { CapabilityReport } from './registry.ts';

export const CONFLICT_CODES = ['rulepack_unsupported', 'requires_dice', 'client_unsupported'] as const;
export const CONFLICT_SEVERITIES = ['conflict', 'info'] as const;
export const UI_CAPABILITIES = ['voice', 'audio', 'diceVisualization'] as const;

export type ConflictCode = (typeof CONFLICT_CODES)[number];
export type ConflictSeverity = (typeof CONFLICT_SEVERITIES)[number];
export type UiCapability = (typeof UI_CAPABILITIES)[number];
export type ConflictEntry = { field: IntentField; value: unknown; provenance: Provenance };
export type IntentConflict = {
  code: ConflictCode;
  severity: ConflictSeverity;
  entries: ConflictEntry[];
  explanation: string;
};

export const CLIENT_CAPABILITIES: Record<Client, readonly UiCapability[]> = {
  cli: [],
  tui: ['diceVisualization'],
  desktop: ['voice', 'audio', 'diceVisualization'],
};

const MECHANICAL_FIELDS = ['dice', 'attributes', 'combat'] as const;
const UI_REQUIREMENTS: [IntentField, UiCapability][] = [
  ['voiceInput', 'voice'],
  ['voiceOutput', 'voice'],
  ['ambience', 'audio'],
  ['diceVisualization', 'diceVisualization'],
];

const entry = (intent: CampaignIntent, field: IntentField): ConflictEntry => ({ field, ...intent[field] });

const explain = (
  intent: CampaignIntent,
  code: ConflictCode,
  fields: IntentField[],
  explanation: string,
): IntentConflict => {
  const entries = fields.map((field) => entry(intent, field));
  const severity = entries[0]?.provenance === 'explicit' ? 'conflict' : 'info';
  return { code, severity, entries, explanation };
};

export const detectConflicts = (
  intent: CampaignIntent,
  rules: CapabilityReport,
  ui: readonly UiCapability[] = CLIENT_CAPABILITIES[intent.client.value],
): IntentConflict[] => {
  const ruleset = intent.ruleset.value?.id ?? 'the active rule pack';
  const client = intent.client.value;
  const diceActive = intent.dice.value !== 'off' && rules.advertised.includes('dice');
  return [
    ...MECHANICAL_FIELDS.filter((field) => intent[field].value === 'on' && !rules.advertised.includes(field)).map(
      (field) =>
        explain(intent, 'rulepack_unsupported', [field], `${field} is on, but ${ruleset} does not support ${field}.`),
    ),
    ...(intent.diceVisualization.value && !diceActive
      ? [
          explain(
            intent,
            'requires_dice',
            ['diceVisualization', 'dice'],
            'diceVisualization is on, but this campaign does not use dice.',
          ),
        ]
      : []),
    ...UI_REQUIREMENTS.filter(([field, capability]) => intent[field].value === true && !ui.includes(capability)).map(
      ([field, capability]) =>
        explain(
          intent,
          'client_unsupported',
          [field, 'client'],
          `${field} is on, but the ${client} client has no ${capability} support.`,
        ),
    ),
  ];
};
