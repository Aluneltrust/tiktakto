// ============================================================================
// BSV SERVICE — Price, balance checks, TX verification, per-game escrow
// ============================================================================

import { PrivateKey, P2PKH, Transaction, Script } from '@bsv/sdk';
import { createHmac } from 'crypto';

const BSV_NETWORK = (process.env.BSV_NETWORK || 'main') === 'main' ? 'mainnet' : 'testnet';
const WOC = `https://api.whatsonchain.com/v1/bsv/${BSV_NETWORK === 'mainnet' ? 'main' : 'test'}`;
const DUST_LIMIT = 546;

const txHexServerCache = new Map<string, string>();

async function fetchTxHexWithRetry(txid: string, maxRetries = 3): Promise<string | null> {
  const cached = txHexServerCache.get(txid);
  if (cached) return cached;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1500 * attempt));
      const res = await fetch(`${WOC}/tx/${txid}/hex`);
      if (res.status === 429) continue;
      if (!res.ok) continue;
      const hex = await res.text();
      txHexServerCache.set(txid, hex);
      return hex;
    } catch { /* retry */ }
  }
  return null;
}

// ============================================================================
// PRICE SERVICE
// ============================================================================

class PriceService {
  private cachedPrice = 0;
  private lastFetch = 0;
  private readonly CACHE_MS = 60_000;

  async getPrice(): Promise<number> {
    if (this.cachedPrice > 0 && Date.now() - this.lastFetch < this.CACHE_MS) {
      return this.cachedPrice;
    }
    try {
      const res = await fetch('https://api.whatsonchain.com/v1/bsv/main/exchangerate');
      const data = await res.json() as any;
      this.cachedPrice = data.rate || data.price || 50;
      this.lastFetch = Date.now();
    } catch {
      if (this.cachedPrice === 0) this.cachedPrice = 50;
    }
    return this.cachedPrice;
  }
}

// ============================================================================
// BALANCE & UTXO HELPERS
// ============================================================================

export async function fetchBalance(address: string): Promise<number> {
  try {
    const res = await fetch(`${WOC}/address/${address}/balance`);
    if (!res.ok) return 0;
    const data = await res.json() as any;
    return (data.confirmed || 0) + (data.unconfirmed || 0);
  } catch { return 0; }
}

async function fetchUTXOs(address: string): Promise<{ txid: string; vout: number; satoshis: number }[]> {
  try {
    const res = await fetch(`${WOC}/address/${address}/unspent`);
    if (!res.ok) return [];
    const data = await res.json() as any;
    return (data || []).map((u: any) => ({
      txid: u.tx_hash,
      vout: u.tx_pos,
      satoshis: u.value,
    }));
  } catch { return []; }
}

// ============================================================================
// LOCAL TX VERIFICATION + SERVER-SIDE BROADCAST
// ============================================================================

class SpentUTXOTracker {
  private claimed = new Map<string, string>();
  private readonly EXPIRY_MS = 10 * 60 * 1000;
  private expiry = new Map<string, number>();

  claim(txid: string, vout: number, gameId: string): boolean {
    const key = `${txid}:${vout}`;
    this.pruneExpired();
    const existingGame = this.claimed.get(key);
    if (existingGame && existingGame !== gameId) return false;
    this.claimed.set(key, gameId);
    this.expiry.set(key, Date.now() + this.EXPIRY_MS);
    return true;
  }

  release(txid: string, vout: number): void {
    const key = `${txid}:${vout}`;
    this.claimed.delete(key);
    this.expiry.delete(key);
  }

  releaseGame(gameId: string): void {
    for (const [key, gid] of this.claimed) {
      if (gid === gameId) {
        this.claimed.delete(key);
        this.expiry.delete(key);
      }
    }
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, exp] of this.expiry) {
      if (now > exp) {
        this.claimed.delete(key);
        this.expiry.delete(key);
      }
    }
  }
}

export const spentTracker = new SpentUTXOTracker();

const usedTxids = new Set<string>();
const txidTimestamps = new Map<string, number>();
function recordTxid(txid: string): void {
  usedTxids.add(txid);
  txidTimestamps.set(txid, Date.now());
  if (txidTimestamps.size % 100 === 0) {
    const cutoff = Date.now() - 3600_000;
    for (const [id, ts] of txidTimestamps) {
      if (ts < cutoff) { usedTxids.delete(id); txidTimestamps.delete(id); }
    }
  }
}

export interface LocalVerifyResult {
  verified: boolean;
  txid: string;
  amount: number;
  error?: string;
}

export async function verifyAndBroadcastTx(
  rawTxHex: string,
  expectedTo: string,
  expectedMin: number,
  gameId: string,
  payerAddress: string,
): Promise<LocalVerifyResult> {
  if (!rawTxHex || typeof rawTxHex !== 'string') {
    return { verified: false, txid: '', amount: 0, error: 'No TX hex provided' };
  }
  if (!/^[0-9a-fA-F]+$/.test(rawTxHex)) {
    return { verified: false, txid: '', amount: 0, error: 'Invalid hex' };
  }
  if (rawTxHex.length < 100 || rawTxHex.length > 200_000) {
    return { verified: false, txid: '', amount: 0, error: 'TX hex size out of range' };
  }

  let tx: Transaction;
  try {
    tx = Transaction.fromHex(rawTxHex);
  } catch (err: any) {
    return { verified: false, txid: '', amount: 0, error: `Failed to parse TX: ${err.message}` };
  }

  const txid = tx.id('hex') as string;
  if (usedTxids.has(txid)) {
    return { verified: false, txid, amount: 0, error: 'TXID already used (replay rejected)' };
  }

  let paymentAmount = 0;
  for (const output of tx.outputs) {
    try {
      const lockHex = output.lockingScript.toHex();
      const expectedLock = new P2PKH().lock(expectedTo).toHex();
      if (lockHex === expectedLock) {
        paymentAmount += output.satoshis || 0;
      }
    } catch { /* non-P2PKH output, skip */ }
  }

  if (paymentAmount < expectedMin) {
    return {
      verified: false, txid, amount: paymentAmount,
      error: `Insufficient payment: expected ${expectedMin} sats, found ${paymentAmount}`,
    };
  }

  const inputOutpoints: { txid: string; vout: number }[] = [];
  for (const input of tx.inputs) {
    let srcTxid: string;
    let srcVout: number;
    if (input.sourceTransaction) {
      srcTxid = input.sourceTransaction.id('hex') as string;
      srcVout = input.sourceOutputIndex;
    } else if (input.sourceTXID) {
      srcTxid = input.sourceTXID;
      srcVout = input.sourceOutputIndex;
    } else {
      return { verified: false, txid, amount: 0, error: 'TX input missing source reference' };
    }
    if (!spentTracker.claim(srcTxid, srcVout, gameId)) {
      return {
        verified: false, txid, amount: 0,
        error: `UTXO ${srcTxid.slice(0, 12)}:${srcVout} already claimed by another game`,
      };
    }
    inputOutpoints.push({ txid: srcTxid, vout: srcVout });
  }

  try {
    const verified = await tx.verify();
    if (verified !== true) {
      for (const op of inputOutpoints) spentTracker.release(op.txid, op.vout);
      return { verified: false, txid, amount: 0, error: 'TX signature verification failed' };
    }
  } catch (sigErr: any) {
    console.warn(`Signature verify() warning: ${sigErr.message}`);
  }

  const broadcastResult = await broadcastRawTx(rawTxHex);
  if (!broadcastResult.success) {
    for (const op of inputOutpoints) spentTracker.release(op.txid, op.vout);
    return {
      verified: false, txid, amount: paymentAmount,
      error: `Broadcast failed: ${broadcastResult.error}`,
    };
  }

  recordTxid(broadcastResult.txid || txid);
  console.log(`TX verified & broadcast: ${(broadcastResult.txid || txid).slice(0, 16)}... | ${paymentAmount} sats`);

  return { verified: true, txid: broadcastResult.txid || txid, amount: paymentAmount };
}

async function broadcastRawTx(rawTxHex: string): Promise<{ success: boolean; txid?: string; error?: string }> {
  const taalKey = process.env.TAAL_API_KEY || '';

  if (taalKey) {
    try {
      const txBytes = Buffer.from(rawTxHex, 'hex');
      const r = await fetch('https://arc.taal.com/v1/tx', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Authorization': `Bearer ${taalKey}`,
        },
        body: txBytes,
      });
      const result = await r.json() as any;
      if (result.txid) return { success: true, txid: result.txid };
      if (r.status === 200 || result.txStatus === 'SEEN_ON_NETWORK') {
        if (result.txid) return { success: true, txid: result.txid };
      }
    } catch (taalErr: any) {
      console.warn('TAAL broadcast error:', taalErr.message);
    }
  }

  try {
    const r = await fetch(`${WOC}/tx/raw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txhex: rawTxHex }),
    });
    const text = await r.text();
    if (r.ok) {
      const txid = text.replace(/"/g, '').trim();
      return { success: true, txid };
    }
    return { success: false, error: text || 'WoC broadcast failed' };
  } catch (wocErr: any) {
    return { success: false, error: `WoC: ${wocErr.message}` };
  }
}

// ============================================================================
// PER-GAME ESCROW MANAGER
// ============================================================================

class EscrowManager {
  private masterSeed: string = '';
  private initialized = false;

  init(): boolean {
    this.masterSeed = process.env.ESCROW_MASTER_SEED || process.env.ESCROW_WIF || '';
    if (!this.masterSeed) {
      console.error('ESCROW_MASTER_SEED not set in .env');
      return false;
    }
    this.initialized = true;
    console.log('Escrow manager initialized (per-game HD derivation)');
    return true;
  }

  deriveGameKey(gameId: string): PrivateKey {
    if (!this.initialized) throw new Error('EscrowManager not initialized');
    const hmac = createHmac('sha256', this.masterSeed);
    hmac.update(gameId);
    const keyHex = hmac.digest('hex');
    return PrivateKey.fromString(keyHex, 16);
  }

  getGameAddress(gameId: string): string {
    const pk = this.deriveGameKey(gameId);
    return pk.toPublicKey().toAddress(BSV_NETWORK);
  }

  async settle(
    gameId: string,
    winnerAddress: string,
    winnerPayout: number,
    platformCut: number,
    secondAddress?: string,
    secondPayout?: number,
  ): Promise<{ success: boolean; txid?: string; error?: string }> {
    if (!this.initialized) return { success: false, error: 'EscrowManager not initialized' };

    const finalWallet = process.env.FINAL_WALLET_ADDRESS || '';
    if (!finalWallet) return { success: false, error: 'FINAL_WALLET_ADDRESS not set' };

    const pk = this.deriveGameKey(gameId);
    const escrowAddr = pk.toPublicKey().toAddress(BSV_NETWORK);

    console.log(`Settling game ${gameId.slice(0, 8)}... escrow: ${escrowAddr}`);

    try {
      const utxos = await fetchUTXOs(escrowAddr);
      if (utxos.length === 0) return { success: false, error: `No UTXOs at game escrow ${escrowAddr}` };

      const available = utxos.reduce((s, u) => s + u.satoshis, 0);
      const estimatedSize = utxos.length * 150 + 4 * 34 + 10;
      const feeEstimate = Math.max(Math.ceil(estimatedSize * 0.15), 500);

      const distributable = available - feeEstimate;
      if (distributable < DUST_LIMIT) {
        return { success: false, error: `Escrow too low after fee: ${available} - ${feeEstimate} = ${distributable}` };
      }

      const totalExpected = winnerPayout + platformCut + (secondPayout || 0);
      const winnerShare = totalExpected > 0 ? winnerPayout / totalExpected : 0.5;
      const adjWinner = Math.floor(distributable * winnerShare);
      let adjSecond = 0;
      if (secondAddress && secondPayout) {
        const secondShare = totalExpected > 0 ? secondPayout / totalExpected : 0;
        adjSecond = Math.floor(distributable * secondShare);
      }
      const adjPlatform = distributable - adjWinner - adjSecond;

      const tx = new Transaction();
      for (const u of utxos) {
        const rawHex = await fetchTxHexWithRetry(u.txid);
        if (!rawHex) return { success: false, error: `Failed to fetch source TX ${u.txid}` };
        tx.addInput({
          sourceTransaction: Transaction.fromHex(rawHex),
          sourceOutputIndex: u.vout,
          unlockingScriptTemplate: new P2PKH().unlock(pk),
          sequence: 0xffffffff,
        });
      }

      if (adjWinner > DUST_LIMIT) {
        tx.addOutput({ lockingScript: new P2PKH().lock(winnerAddress), satoshis: adjWinner });
      }
      if (secondAddress && adjSecond > DUST_LIMIT) {
        tx.addOutput({ lockingScript: new P2PKH().lock(secondAddress), satoshis: adjSecond });
      }
      if (adjPlatform > DUST_LIMIT) {
        tx.addOutput({ lockingScript: new P2PKH().lock(finalWallet), satoshis: adjPlatform });
      }

      // OP_RETURN game record
      const opReturnData = JSON.stringify({
        p: 'TIKTAKTO', a: 'SETTLE', g: gameId.slice(0, 8),
        e: escrowAddr.slice(0, 8), w: winnerAddress.slice(0, 8),
        wp: adjWinner, pc: adjPlatform, fee: feeEstimate,
      });
      tx.addOutput({ lockingScript: opReturn(opReturnData), satoshis: 0 });

      const totalOut = (adjWinner > DUST_LIMIT ? adjWinner : 0)
        + (adjSecond > DUST_LIMIT ? adjSecond : 0)
        + (adjPlatform > DUST_LIMIT ? adjPlatform : 0);
      const change = available - totalOut - feeEstimate;
      if (change > DUST_LIMIT) {
        tx.addOutput({ lockingScript: new P2PKH().lock(escrowAddr), satoshis: change });
      }

      await tx.sign();

      const result = await broadcastRawTx(tx.toHex());
      if (result.success) {
        console.log(`Settlement: ${adjWinner} -> winner, ${adjPlatform} -> platform (${result.txid})`);
        return { success: true, txid: result.txid };
      }

      return { success: false, error: result.error || 'Settlement broadcast failed' };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }
}

function opReturn(data: string): Script {
  const hex = Array.from(new TextEncoder().encode(data))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return Script.fromASM(`OP_FALSE OP_RETURN ${hex}`);
}

// ============================================================================
// EXPORTS
// ============================================================================

export const priceService = new PriceService();
export const escrowManager = new EscrowManager();
