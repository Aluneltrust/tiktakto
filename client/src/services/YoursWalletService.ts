// ============================================================================
// YOURS WALLET SERVICE — Browser extension wallet integration
// ============================================================================

interface YoursProvider {
  isReady: boolean;
  connect(): Promise<string | undefined>;
  disconnect(): Promise<void>;
  getAddresses(): Promise<{ bsvAddress?: string; identityAddress?: string } | undefined>;
  getBalance(): Promise<{ satoshis?: number; bsv?: number } | undefined>;
  sendBsv(params: { address: string; satoshis: number; data?: string[] }[]): Promise<{ txid: string; rawtx: string } | undefined>;
}

declare global {
  interface Window {
    yours?: YoursProvider;
  }
}

export class YoursWalletService {
  private provider: YoursProvider | null = null;
  private address = '';

  isExtensionAvailable(): boolean {
    return typeof window !== 'undefined' && !!window.yours?.isReady;
  }

  async connect(): Promise<{ address: string }> {
    if (!this.isExtensionAvailable()) {
      throw new Error('Yours Wallet extension not detected. Please install it first.');
    }

    this.provider = window.yours!;
    const identityAddress = await this.provider.connect();
    if (!identityAddress) {
      throw new Error('Connection rejected by user');
    }

    const addresses = await this.provider.getAddresses();
    if (!addresses?.bsvAddress) {
      throw new Error('Could not retrieve BSV address');
    }

    this.address = addresses.bsvAddress;
    return { address: this.address };
  }

  async disconnect(): Promise<void> {
    if (this.provider) {
      await this.provider.disconnect();
    }
    this.provider = null;
    this.address = '';
  }

  isConnected(): boolean {
    return this.provider !== null && this.address !== '';
  }

  getAddress(): string {
    if (!this.address) throw new Error('Yours Wallet not connected');
    return this.address;
  }

  async getBalance(): Promise<number> {
    if (!this.provider) throw new Error('Yours Wallet not connected');
    const balance = await this.provider.getBalance();
    return balance?.satoshis ?? 0;
  }

  async sendBsv(toAddress: string, satoshis: number, memo?: string): Promise<{ txid: string; rawtx: string }> {
    if (!this.provider) throw new Error('Yours Wallet not connected');

    const params: { address: string; satoshis: number; data?: string[] }[] = [
      { address: toAddress, satoshis },
    ];

    if (memo) {
      params[0].data = [memo];
    }

    const result = await this.provider.sendBsv(params);
    if (!result) {
      throw new Error('Transaction rejected by user');
    }
    return result;
  }
}

export const yoursWalletService = new YoursWalletService();
