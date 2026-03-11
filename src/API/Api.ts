// ============================================================================
// REST API ROUTES — BSV TikTakTo
// ============================================================================

import { Router, Request, Response, NextFunction } from 'express';
import { gameManager } from '../game/TicTacToeManager';
import { matchmakingQueue } from '../game/Matchmaking';
import { STAKE_TIERS } from '../game/Constants';
import { escrowManager, priceService, fetchBalance } from '../wallet/BsvService';
import * as db from '../DB/Database';
import { sessionManager } from '../socket/SessionManager';
import { lobbyManager } from '../game/LobbyManager';

const router = Router();

function requireSession(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers['x-session-token'] as string || '';
  if (!sessionManager.isValid(token)) {
    res.status(401).json({ error: 'Unauthorized' }); return;
  }
  next();
}

function isValidBsvAddress(address: string): boolean { return /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address); }

router.get('/health', (_req, res) => {
  res.json({
    status: 'ok', uptime: process.uptime(),
    activeGames: gameManager.getActiveCount(),
    playersWaiting: matchmakingQueue.getTotalWaiting(),
    playersOnline: lobbyManager.getOnlineCount(),
  });
});

router.get('/api/tiers', (_req, res) => res.json(STAKE_TIERS));

router.get('/api/queue', (_req, res) => {
  res.json({ queues: matchmakingQueue.getQueueSizes(), activeGames: gameManager.getActiveCount() });
});

router.get('/api/price', async (_req, res) => {
  res.json({ bsvUsd: await priceService.getPrice() });
});

router.get('/api/leaderboard', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    res.json(await db.getLeaderboard(limit));
  } catch { res.status(500).json({ error: 'Leaderboard failed' }); }
});

router.get('/api/player/:address', async (req, res) => {
  if (!isValidBsvAddress(req.params.address)) { res.status(400).json({ error: 'Invalid address' }); return; }
  try {
    const stats = await db.getPlayerStats(req.params.address);
    if (!stats) { res.status(404).json({ error: 'Player not found' }); return; }
    res.json(stats);
  } catch { res.status(500).json({ error: 'Stats failed' }); }
});

router.get('/api/balance/:address', async (req, res) => {
  if (!isValidBsvAddress(req.params.address)) { res.status(400).json({ error: 'Invalid address' }); return; }
  res.json({ address: req.params.address, balance: await fetchBalance(req.params.address) });
});

router.get('/api/escrow/:gameId', requireSession, async (req, res) => {
  try {
    const addr = escrowManager.getGameAddress(req.params.gameId);
    const balance = await fetchBalance(addr);
    res.json({ gameId: req.params.gameId, address: addr, balance });
  } catch { res.json({ error: 'Escrow not available' }); }
});

// WoC Proxy
const WOC_BASE = 'https://api.whatsonchain.com/v1/bsv/main';
let lastWocRequest = 0;
const WOC_MIN_INTERVAL = 350;

async function wocFetch(url: string, options?: RequestInit): Promise<globalThis.Response> {
  const wait = WOC_MIN_INTERVAL - (Date.now() - lastWocRequest);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastWocRequest = Date.now();
  return fetch(url, options);
}

router.get('/api/woc/tx/:txid/hex', requireSession, async (req, res) => {
  if (!/^[0-9a-fA-F]{64}$/.test(req.params.txid)) { res.status(400).send('Invalid TXID'); return; }
  try {
    const r = await wocFetch(`${WOC_BASE}/tx/${req.params.txid}/hex`);
    if (!r.ok) { res.status(r.status).send('TX not found'); return; }
    res.send(await r.text());
  } catch { res.status(500).send('Proxy error'); }
});

router.get('/api/woc/address/:address/unspent', requireSession, async (req, res) => {
  if (!isValidBsvAddress(req.params.address)) { res.status(400).json({ error: 'Invalid address' }); return; }
  try {
    const r = await wocFetch(`${WOC_BASE}/address/${req.params.address}/unspent`);
    if (!r.ok) { res.status(r.status).json([]); return; }
    res.json(await r.json());
  } catch { res.status(500).json([]); }
});

router.post('/api/woc/tx/raw', requireSession, async (req, res) => {
  if (!req.body?.txhex || typeof req.body.txhex !== 'string') { res.status(400).send('Missing txhex'); return; }
  if (!/^[0-9a-fA-F]+$/.test(req.body.txhex) || req.body.txhex.length > 200_000) {
    res.status(400).send('Invalid TX hex'); return;
  }
  try {
    const r = await wocFetch(`${WOC_BASE}/tx/raw`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txhex: req.body.txhex }),
    });
    const text = await r.text();
    if (!r.ok) { res.status(r.status).send(text); return; }
    res.send(text);
  } catch { res.status(500).send('Broadcast error'); }
});

export default router;
