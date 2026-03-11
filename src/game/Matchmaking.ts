// ============================================================================
// MATCHMAKING QUEUE — Groups players by tier
// ============================================================================

export interface QueueEntry {
  socketId: string;
  address: string;
  username: string;
  stakeTier: number;
  queuedAt: number;
}

export class MatchmakingQueue {
  private queues = new Map<number, QueueEntry[]>();

  enqueue(entry: QueueEntry): { matched: boolean; opponent?: QueueEntry } {
    this.remove(entry.socketId);

    const queue = this.queues.get(entry.stakeTier) || [];
    this.queues.set(entry.stakeTier, queue);

    if (queue.length > 0) {
      const opponent = queue.shift()!;
      if (opponent.socketId === entry.socketId || opponent.address === entry.address) {
        queue.unshift(opponent);
        queue.push(entry);
        return { matched: false };
      }
      if (queue.length === 0) this.queues.delete(entry.stakeTier);
      return { matched: true, opponent };
    }

    queue.push(entry);
    return { matched: false };
  }

  remove(socketId: string): boolean {
    let removed = false;
    for (const [tier, queue] of this.queues) {
      const idx = queue.findIndex(e => e.socketId === socketId);
      if (idx !== -1) { queue.splice(idx, 1); removed = true; }
      if (queue.length === 0) this.queues.delete(tier);
    }
    return removed;
  }

  getQueueSizes(): Record<number, number> {
    const sizes: Record<number, number> = {};
    for (const [tier, queue] of this.queues) sizes[tier] = queue.length;
    return sizes;
  }

  getTotalWaiting(): number {
    let t = 0;
    for (const q of this.queues.values()) t += q.length;
    return t;
  }
}

export const matchmakingQueue = new MatchmakingQueue();
