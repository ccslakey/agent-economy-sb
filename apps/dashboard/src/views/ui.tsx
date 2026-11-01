import type { ReactNode } from 'react';

// Small shared pieces: number formatting and the status chip.

export const fmt = (n: number): string => n.toLocaleString('en-US');
export const money = (n: number): string => `$${n.toFixed(2)}`;
/** A signed change, with an explicit plus so gains and losses read at a glance. */
export const delta = (n: number): string => (n > 0 ? `+${fmt(n)}` : fmt(n));

export type ChipKind = 'ok' | 'bad' | 'warn' | 'neutral';

export function Chip({ kind, children }: { kind: ChipKind; children: ReactNode }) {
  return <span className={`chip chip-${kind}`}>{children}</span>;
}

export const standingChip = (kind: 'solvent' | 'bankrupt'): ChipKind =>
  kind === 'solvent' ? 'ok' : 'bad';

const CONTRACT_CHIPS: Record<string, ChipKind> = {
  completed: 'ok',
  defaulted: 'bad',
  active: 'neutral',
  proposed: 'warn',
};
export const contractChip = (status: string): ChipKind => CONTRACT_CHIPS[status] ?? 'neutral';

const RUN_CHIPS: Record<string, ChipKind> = { running: 'ok', paused: 'warn', ended: 'neutral' };
export const runChip = (status: string): ChipKind => RUN_CHIPS[status] ?? 'neutral';
