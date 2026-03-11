// ============================================================================
// DATABASE — PostgreSQL
// ============================================================================

import { Pool } from 'pg';

let pool: Pool;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
      max: 10,
    });
  }
  return pool;
}

// Use ttt_ prefix to avoid conflicts with other games sharing the same DB
const GAMES_TABLE = 'ttt_games';
const PLAYERS_TABLE = 'ttt_players';

export async function initDatabase(): Promise<void> {
  const db = getPool();

  await db.query(`
    CREATE TABLE IF NOT EXISTS ${PLAYERS_TABLE} (
      address       TEXT PRIMARY KEY,
      username      TEXT NOT NULL DEFAULT 'Anonymous',
      games_played  INTEGER NOT NULL DEFAULT 0,
      games_won     INTEGER NOT NULL DEFAULT 0,
      games_drawn   INTEGER NOT NULL DEFAULT 0,
      total_winnings BIGINT NOT NULL DEFAULT 0,
      total_wagered  BIGINT NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ${GAMES_TABLE} (
      id              TEXT PRIMARY KEY,
      stake_tier      INTEGER NOT NULL DEFAULT 0,
      p1_address      TEXT NOT NULL DEFAULT '',
      p2_address      TEXT NOT NULL DEFAULT '',
      winner_address  TEXT,
      end_reason      TEXT,
      pot             BIGINT NOT NULL DEFAULT 0,
      winner_payout   BIGINT NOT NULL DEFAULT 0,
      platform_cut    BIGINT NOT NULL DEFAULT 0,
      settle_txid     TEXT,
      move_count      INTEGER DEFAULT 0,
      started_at      TIMESTAMPTZ DEFAULT NOW(),
      ended_at        TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_ttt_games_p1 ON ${GAMES_TABLE}(p1_address);
    CREATE INDEX IF NOT EXISTS idx_ttt_games_p2 ON ${GAMES_TABLE}(p2_address);
    CREATE INDEX IF NOT EXISTS idx_ttt_players_wins ON ${PLAYERS_TABLE}(games_won DESC);
  `);

  console.log('Database initialized (PostgreSQL)');
}

export async function ensurePlayer(address: string, username: string): Promise<void> {
  await getPool().query(
    `INSERT INTO ${PLAYERS_TABLE} (address, username) VALUES ($1, $2)
     ON CONFLICT (address) DO UPDATE SET username = EXCLUDED.username, updated_at = NOW()`,
    [address, username]
  );
}

export async function getPlayerStats(address: string): Promise<any | null> {
  const result = await getPool().query(
    `SELECT p.*,
     (SELECT json_agg(row_to_json(g) ORDER BY g.ended_at DESC)
      FROM (SELECT id, stake_tier, winner_address, pot, winner_payout, end_reason, ended_at
            FROM ${GAMES_TABLE} WHERE (p1_address=$1 OR p2_address=$1) AND ended_at IS NOT NULL
            ORDER BY ended_at DESC LIMIT 10) g) as recent_games
     FROM ${PLAYERS_TABLE} p WHERE p.address=$1`,
    [address]
  );
  return result.rows[0] || null;
}

export async function recordGameStart(
  gameId: string, stakeTier: number, p1Addr: string, p2Addr: string,
): Promise<void> {
  await getPool().query(
    `INSERT INTO ${GAMES_TABLE} (id, stake_tier, p1_address, p2_address, started_at) VALUES ($1,$2,$3,$4,NOW())`,
    [gameId, stakeTier, p1Addr, p2Addr]
  );
}

export async function recordGameEnd(
  gameId: string,
  winnerAddress: string | null,
  endReason: string,
  pot: number,
  winnerPayout: number,
  platformCut: number,
  settleTxid: string,
  moveCount: number,
): Promise<void> {
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE ${GAMES_TABLE} SET
        winner_address=$2, end_reason=$3, pot=$4,
        winner_payout=$5, platform_cut=$6, settle_txid=$7,
        move_count=$8, ended_at=NOW()
       WHERE id=$1`,
      [gameId, winnerAddress, endReason, pot, winnerPayout, platformCut, settleTxid, moveCount]
    );

    const g = (await client.query(`SELECT * FROM ${GAMES_TABLE} WHERE id=$1`, [gameId])).rows[0];
    if (g) {
      await client.query(
        `UPDATE ${PLAYERS_TABLE} SET games_played=games_played+1, updated_at=NOW() WHERE address=$1`,
        [g.p1_address]
      );
      await client.query(
        `UPDATE ${PLAYERS_TABLE} SET games_played=games_played+1, updated_at=NOW() WHERE address=$1`,
        [g.p2_address]
      );

      if (winnerAddress) {
        await client.query(
          `UPDATE ${PLAYERS_TABLE} SET games_won=games_won+1, total_winnings=total_winnings+$2, updated_at=NOW() WHERE address=$1`,
          [winnerAddress, winnerPayout]
        );
      } else {
        await client.query(
          `UPDATE ${PLAYERS_TABLE} SET games_drawn=games_drawn+1, updated_at=NOW() WHERE address=$1`,
          [g.p1_address]
        );
        await client.query(
          `UPDATE ${PLAYERS_TABLE} SET games_drawn=games_drawn+1, updated_at=NOW() WHERE address=$1`,
          [g.p2_address]
        );
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getLeaderboard(limit = 20): Promise<any[]> {
  const result = await getPool().query(
    `SELECT address, username, games_played, games_won, games_drawn, total_winnings,
     CASE WHEN games_played>0 THEN ROUND(games_won::numeric/games_played*100,1) ELSE 0 END as win_rate
     FROM ${PLAYERS_TABLE} WHERE games_played>=1
     ORDER BY games_won DESC, win_rate DESC LIMIT $1`,
    [limit]
  );
  return result.rows;
}
