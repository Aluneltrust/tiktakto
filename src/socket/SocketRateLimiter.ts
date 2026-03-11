// ============================================================================
// SOCKET RATE LIMITER
// ============================================================================

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

const DEFAULT_LIMITS: Record<string, RateLimitConfig> = {
  find_match:         { maxRequests: 2,  windowMs: 10_000 },
  cancel_matchmaking: { maxRequests: 3,  windowMs: 10_000 },
  make_move:          { maxRequests: 3,  windowMs: 3_000  },
  submit_payment:     { maxRequests: 3,  windowMs: 5_000  },
  forfeit:            { maxRequests: 2,  windowMs: 10_000 },
  reconnect_game:     { maxRequests: 3,  windowMs: 10_000 },
  get_queue_info:     { maxRequests: 5,  windowMs: 10_000 },
  get_leaderboard:    { maxRequests: 3,  windowMs: 10_000 },
  join_lobby:         { maxRequests: 2,  windowMs: 10_000 },
  get_lobby:          { maxRequests: 5,  windowMs: 10_000 },
  challenge_player:   { maxRequests: 3,  windowMs: 15_000 },
  accept_challenge:   { maxRequests: 3,  windowMs: 10_000 },
  decline_challenge:  { maxRequests: 5,  windowMs: 10_000 },
  offer_draw:         { maxRequests: 2,  windowMs: 10_000 },
  accept_draw:        { maxRequests: 2,  windowMs: 10_000 },
  decline_draw:       { maxRequests: 3,  windowMs: 10_000 },
};

export class SocketRateLimiter {
  private limits: Map<string, Map<string, RateLimitEntry>> = new Map();
  private config: Record<string, RateLimitConfig>;

  constructor(overrides?: Record<string, RateLimitConfig>) {
    this.config = { ...DEFAULT_LIMITS, ...overrides };
  }

  check(socketId: string, event: string): boolean {
    const limit = this.config[event];
    if (!limit) return true;
    const now = Date.now();
    if (!this.limits.has(socketId)) this.limits.set(socketId, new Map());
    const socketLimits = this.limits.get(socketId)!;
    const entry = socketLimits.get(event);

    if (!entry || now - entry.windowStart >= limit.windowMs) {
      socketLimits.set(event, { count: 1, windowStart: now });
      return true;
    }
    if (entry.count < limit.maxRequests) { entry.count++; return true; }
    return false;
  }

  cleanup(socketId: string): void { this.limits.delete(socketId); }

  pruneStale(): void {
    const now = Date.now();
    const maxWindow = Math.max(...Object.values(this.config).map(c => c.windowMs));
    for (const [socketId, events] of this.limits) {
      for (const [event, entry] of events) {
        if (now - entry.windowStart > maxWindow * 2) events.delete(event);
      }
      if (events.size === 0) this.limits.delete(socketId);
    }
  }
}

export const socketRateLimiter = new SocketRateLimiter();
setInterval(() => socketRateLimiter.pruneStale(), 60_000);
