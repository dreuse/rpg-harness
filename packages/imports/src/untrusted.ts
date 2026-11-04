import type { Provenance } from './provenance.ts';

export type UntrustedContent = {
  readonly kind: 'untrusted_content';
  readonly text: string;
  readonly provenance: Provenance;
};

export type ImportedData = {
  readonly kind: 'data';
  readonly text: string;
  readonly provenance: Provenance;
  readonly toolCalls: readonly [];
  readonly permissions: readonly [];
};

export const wrapUntrusted = (text: string, provenance: Provenance): UntrustedContent => ({
  kind: 'untrusted_content',
  text,
  provenance,
});

export const interpretImported = ({ text, provenance }: UntrustedContent): ImportedData => ({
  kind: 'data',
  text,
  provenance,
  toolCalls: [],
  permissions: [],
});
