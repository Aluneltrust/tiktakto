// ============================================================================
// CONSTANTS — BSV TikTakTo
// ============================================================================

export const PLATFORM_CUT_PERCENT = 3;

export interface StakeTierDef {
  tier: number;
  name: string;
  depositCents: number;
}

export const STAKE_TIERS: StakeTierDef[] = [
  { tier: 1,    name: 'Penny',   depositCents: 1    },
  { tier: 25,   name: 'Quarter', depositCents: 25   },
  { tier: 50,   name: 'Half',    depositCents: 50   },
  { tier: 100,  name: 'Dollar',  depositCents: 100  },
  { tier: 500,  name: 'Five',    depositCents: 500  },
  { tier: 1000, name: 'Ten',     depositCents: 1000 },
];

export function getTierByValue(value: number): StakeTierDef | undefined {
  return STAKE_TIERS.find(t => t.tier === value);
}

/** Convert cents to satoshis using current BSV/USD price. */
export function centsToSats(cents: number, bsvUsd: number): number {
  if (bsvUsd <= 0) return 0;
  const dollars = cents / 100;
  return Math.ceil((dollars / bsvUsd) * 1e8);
}

export type GameEndReason =
  | 'win'           // 3 in a row
  | 'draw'          // board full, no winner
  | 'draw_agreement'
  | 'resignation'
  | 'timeout'
  | 'disconnect';

// Board
export const BOARD_SIZE = 3;
export const TOTAL_CELLS = BOARD_SIZE * BOARD_SIZE;

// Turn timer
export const TURN_TIMEOUT_MS = 30_000;
export const RECONNECT_GRACE_MS = 30_000;
