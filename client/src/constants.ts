// ============================================================================
// FRONTEND CONSTANTS — BSV TikTakTo
// ============================================================================

export const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3003';
export const BSV_NETWORK = import.meta.env.VITE_BSV_NETWORK || 'main';

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

export const PLATFORM_CUT_PERCENT = 3;

export const STORAGE_KEYS = {
  USERNAME: 'tiktakto_username',
  WALLET_ENC: 'tiktakto_wallet_enc',
  WALLET_ADDR: 'tiktakto_wallet_addr',
  GAME_ID: 'tiktakto_game_id',
};
