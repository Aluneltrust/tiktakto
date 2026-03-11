let sessionToken = '';

export function setSessionToken(token: string): void {
  sessionToken = token;
}

export function getSessionToken(): string {
  return sessionToken;
}

export { isEmbedded, bridgeGetAddress, bridgeGetBalance, bridgeSignTransaction } from './GameWalletBridge';
