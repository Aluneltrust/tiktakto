// ============================================================================
// BSV Price Service — Fetches BSV/USD from WhatsOnChain
// ============================================================================

let cachedPrice = 0;
let lastFetch = 0;
const CACHE_MS = 60_000;

export async function fetchBsvPrice(): Promise<number> {
  if (cachedPrice > 0 && Date.now() - lastFetch < CACHE_MS) {
    return cachedPrice;
  }
  try {
    const res = await fetch('https://api.whatsonchain.com/v1/bsv/main/exchangerate');
    const data = await res.json() as any;
    cachedPrice = data.rate || data.price || 50;
    lastFetch = Date.now();
  } catch {
    if (cachedPrice === 0) cachedPrice = 50;
  }
  return cachedPrice;
}
