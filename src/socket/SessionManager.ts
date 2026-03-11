// ============================================================================
// SESSION TOKEN MANAGER
// ============================================================================

import crypto from 'crypto';

interface Session {
  socketId: string;
  address: string;
  createdAt: number;
}

const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

class SessionManager {
  private sessions: Map<string, Session> = new Map();

  create(socketId: string, address: string): string {
    this.revokeBySocket(socketId);
    const token = crypto.randomBytes(24).toString('hex');
    this.sessions.set(token, { socketId, address, createdAt: Date.now() });
    return token;
  }

  validate(token: string): Session | null {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (Date.now() - session.createdAt > TOKEN_TTL_MS) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  isValid(token: string): boolean {
    return this.validate(token) !== null;
  }

  revokeBySocket(socketId: string): void {
    for (const [token, session] of this.sessions) {
      if (session.socketId === socketId) this.sessions.delete(token);
    }
  }

  prune(): void {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (now - session.createdAt > TOKEN_TTL_MS) this.sessions.delete(token);
    }
  }

  get activeCount(): number { return this.sessions.size; }
}

export const sessionManager = new SessionManager();
setInterval(() => sessionManager.prune(), 5 * 60 * 1000);
