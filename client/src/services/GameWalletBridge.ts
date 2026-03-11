// ============================================================================
// GAME WALLET BRIDGE — Communicates with AlunelGames parent wallet
// ============================================================================
// When this game is embedded in an iframe inside AlunelGames, this bridge
// replaces local key management. All signing happens in the parent app.
// ============================================================================

let requestId = 0;

// Allowed parent origins — add deployed AlunelGames URL when ready
const ALLOWED_PARENT_ORIGINS = new Set([
  'http://localhost:5180',
  'https://alunelgames.com',
  'https://www.alunelgames.com',
]);

function getParentOrigin(): string {
  try {
    // In same-origin localhost dev, we can read the parent origin directly
    if (window.parent !== window && window.parent.location.origin) {
      return window.parent.location.origin;
    }
  } catch {
    // Cross-origin — can't read parent location, fall back to referrer
  }
  if (document.referrer) {
    try {
      return new URL(document.referrer).origin;
    } catch { /* invalid referrer */ }
  }
  return '*';
}

interface WalletResponse {
  type: 'WALLET_RESPONSE';
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

function sendRequest(action: string, payload?: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = `wallet_${++requestId}_${Date.now()}`;
    let settled = false;

    const handler = (event: MessageEvent) => {
      // Validate origin
      if (!ALLOWED_PARENT_ORIGINS.has(event.origin)) return;

      const data = event.data as WalletResponse;
      if (data?.type !== 'WALLET_RESPONSE' || data.id !== id) return;
      if (settled) return;
      settled = true;

      window.removeEventListener('message', handler);
      clearTimeout(timeoutId);

      if (data.success) resolve(data.data);
      else reject(new Error(data.error || 'Wallet request failed'));
    };

    window.addEventListener('message', handler);

    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', handler);
      reject(new Error('Wallet request timed out'));
    }, 60000);

    const targetOrigin = getParentOrigin();
    window.parent.postMessage({ type: 'WALLET_REQUEST', id, action, payload }, targetOrigin);
  });
}

export function isEmbedded(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

export async function bridgeGetAddress(): Promise<string> {
  return sendRequest('getAddress') as Promise<string>;
}

export async function bridgeGetBalance(): Promise<number> {
  return sendRequest('getBalance') as Promise<number>;
}

export async function bridgeGetPublicKey(): Promise<string> {
  return sendRequest('getPublicKey') as Promise<string>;
}

export async function bridgeSignTransaction(
  toAddress: string,
  amount: number,
  memo?: string,
): Promise<{ success: boolean; rawTxHex?: string; txid?: string; amount?: number; error?: string }> {
  const result = await sendRequest('signTransaction', { toAddress, amount, memo });
  return result as { success: boolean; rawTxHex?: string; txid?: string; amount?: number; error?: string };
}
