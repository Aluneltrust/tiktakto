// ============================================================================
// TIC TAC TOE GAME MANAGER — Server-authoritative
// ============================================================================
// Flow:
//   1. Both players pay deposit → escrow
//   2. Players take turns placing X or O
//   3. Server validates moves, checks win/draw
//   4. Winner gets opponent's deposit minus 3% platform cut
// ============================================================================

import { v4 as uuidv4 } from 'uuid';
import {
  StakeTierDef, getTierByValue, centsToSats, GameEndReason,
  PLATFORM_CUT_PERCENT, BOARD_SIZE, TOTAL_CELLS,
  TURN_TIMEOUT_MS, RECONNECT_GRACE_MS,
} from './Constants';
import { priceService, escrowManager } from '../wallet/BsvService';

// ============================================================================
// TYPES
// ============================================================================

export type GamePhase = 'awaiting_wagers' | 'playing' | 'gameover';
export type PlayerSlot = 'player1' | 'player2';
export type CellValue = '' | 'X' | 'O';

export interface PlayerState {
  socketId: string;
  address: string;
  username: string;
  slot: PlayerSlot;
  wagerPaid: boolean;
  mark: 'X' | 'O';
  connected: boolean;
  disconnectedAt: number | null;
}

export interface MoveResult {
  slot: PlayerSlot;
  row: number;
  col: number;
  mark: 'X' | 'O';
  board: CellValue[];
  gameOver: boolean;
  gameOverResult?: GameOverResult;
  winLine?: number[];  // indices of winning cells
  currentTurn: PlayerSlot;
}

export interface GameState {
  id: string;
  phase: GamePhase;
  tier: StakeTierDef;
  depositSats: number;
  bsvPriceAtStart: number;
  player1: PlayerState;
  player2: PlayerState;
  currentTurn: PlayerSlot;
  board: CellValue[];   // flat array [0..8], row-major
  pot: number;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  endReason: GameEndReason | null;
  winner: PlayerSlot | null;
  turnStartedAt: number;
  moveCount: number;
}

export interface GameOverResult {
  winner: PlayerSlot | null;
  loser: PlayerSlot | null;
  reason: GameEndReason;
  pot: number;
  winnerPayout: number;
  loserPayout: number;
  platformCut: number;
  p1Address: string;
  p2Address: string;
  winLine?: number[];
}

// ============================================================================
// WIN DETECTION
// ============================================================================

const WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // cols
  [0, 4, 8], [2, 4, 6],            // diagonals
];

function checkWin(board: CellValue[]): { winner: 'X' | 'O'; line: number[] } | null {
  for (const line of WIN_LINES) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a] as 'X' | 'O', line };
    }
  }
  return null;
}

function isBoardFull(board: CellValue[]): boolean {
  return board.every(cell => cell !== '');
}

// ============================================================================
// GAME MANAGER
// ============================================================================

export class TicTacToeManager {
  private games = new Map<string, GameState>();
  private playerToGame = new Map<string, string>();
  private turnTimers = new Map<string, NodeJS.Timeout>();
  private disconnectTimers = new Map<string, NodeJS.Timeout>();

  // Callbacks
  onTurnTimeout: ((gameId: string, winner: PlayerSlot, loser: PlayerSlot) => void) | null = null;
  onDisconnectTimeout: ((gameId: string, winner: PlayerSlot, loser: PlayerSlot) => void) | null = null;

  // ==========================================================================
  // CREATE GAME
  // ==========================================================================

  async createGame(
    p1Sid: string, p1Addr: string, p1Name: string,
    p2Sid: string, p2Addr: string, p2Name: string,
    tierValue: number,
  ): Promise<GameState | null> {
    const tier = getTierByValue(tierValue);
    if (!tier) return null;

    const bsvPrice = await priceService.getPrice();
    const depositSats = centsToSats(tier.depositCents, bsvPrice);
    const gameId = uuidv4();

    // Randomly assign X/O
    const p1IsX = Math.random() < 0.5;

    const mkPlayer = (sid: string, addr: string, name: string, slot: PlayerSlot, mark: 'X' | 'O'): PlayerState => ({
      socketId: sid, address: addr, username: name, slot,
      wagerPaid: false, mark,
      connected: true, disconnectedAt: null,
    });

    const game: GameState = {
      id: gameId,
      phase: 'awaiting_wagers',
      tier, depositSats, bsvPriceAtStart: bsvPrice,
      player1: mkPlayer(p1Sid, p1Addr, p1Name, 'player1', p1IsX ? 'X' : 'O'),
      player2: mkPlayer(p2Sid, p2Addr, p2Name, 'player2', p1IsX ? 'O' : 'X'),
      currentTurn: p1IsX ? 'player1' : 'player2', // X always goes first
      board: Array(TOTAL_CELLS).fill(''),
      pot: 0,
      createdAt: Date.now(), startedAt: null, endedAt: null,
      endReason: null, winner: null,
      turnStartedAt: 0, moveCount: 0,
    };

    this.games.set(gameId, game);
    this.playerToGame.set(p1Sid, gameId);
    this.playerToGame.set(p2Sid, gameId);
    return game;
  }

  // ==========================================================================
  // WAGER
  // ==========================================================================

  confirmWagerPayment(gameId: string, slot: PlayerSlot, txid: string): {
    success: boolean; bothPaid: boolean;
  } {
    const game = this.games.get(gameId);
    if (!game) return { success: false, bothPaid: false };
    if (game[slot].wagerPaid) return { success: false, bothPaid: false };

    game[slot].wagerPaid = true;
    game.pot += game.depositSats;

    const bothPaid = game.player1.wagerPaid && game.player2.wagerPaid;
    if (bothPaid) {
      game.phase = 'playing';
      game.startedAt = Date.now();
      game.turnStartedAt = Date.now();
      this.startTurnTimer(game);
    }

    return { success: true, bothPaid };
  }

  // ==========================================================================
  // MAKE MOVE — Server-authoritative
  // ==========================================================================

  makeMove(socketId: string, row: number, col: number): MoveResult | { success: false; error: string } {
    const game = this.getGameBySocket(socketId);
    if (!game) return { success: false, error: 'Not in a game' };
    if (game.phase !== 'playing') return { success: false, error: 'Game not active' };

    const slot = this.getSlot(game, socketId);
    if (!slot) return { success: false, error: 'Not a player' };
    if (slot !== game.currentTurn) return { success: false, error: 'Not your turn' };

    // Validate coordinates
    if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) {
      return { success: false, error: 'Invalid cell' };
    }

    const index = row * BOARD_SIZE + col;
    if (game.board[index] !== '') {
      return { success: false, error: 'Cell already taken' };
    }

    this.clearTurnTimer(game.id);

    // Place mark
    const mark = game[slot].mark;
    game.board[index] = mark;
    game.moveCount++;

    // Check for win
    const winResult = checkWin(game.board);
    let gameOver = false;
    let gameOverResult: GameOverResult | undefined;
    let winLine: number[] | undefined;

    if (winResult) {
      gameOver = true;
      winLine = winResult.line;
      gameOverResult = this.endGame(game, slot, 'win');
      gameOverResult.winLine = winLine;
    } else if (isBoardFull(game.board)) {
      gameOver = true;
      gameOverResult = this.endGameDraw(game, 'draw');
    }

    // Next turn
    const opponentSlot = this.opponentSlot(slot);
    if (!gameOver) {
      game.currentTurn = opponentSlot;
      game.turnStartedAt = Date.now();
      this.startTurnTimer(game);
    }

    return {
      slot,
      row, col, mark,
      board: [...game.board],
      gameOver,
      gameOverResult,
      winLine,
      currentTurn: game.currentTurn,
    };
  }

  // ==========================================================================
  // GAME END
  // ==========================================================================

  endGame(game: GameState, winner: PlayerSlot, reason: GameEndReason): GameOverResult {
    game.phase = 'gameover';
    game.endedAt = Date.now();
    game.endReason = reason;
    game.winner = winner;
    this.clearTurnTimer(game.id);
    this.clearDisconnectTimer(game.id, 'player1');
    this.clearDisconnectTimer(game.id, 'player2');

    const loser = this.opponentSlot(winner);

    const loserDeposit = game.depositSats;
    const depositPlatformCut = Math.ceil(loserDeposit * PLATFORM_CUT_PERCENT / 100);
    const depositToWinner = loserDeposit - depositPlatformCut;

    const winnerPayout = game.depositSats + depositToWinner;
    const totalPlatformCut = depositPlatformCut;

    return {
      winner, loser, reason,
      pot: game.pot,
      winnerPayout, loserPayout: 0, platformCut: totalPlatformCut,
      p1Address: game.player1.address,
      p2Address: game.player2.address,
    };
  }

  endGameDraw(game: GameState, reason: GameEndReason): GameOverResult {
    game.phase = 'gameover';
    game.endedAt = Date.now();
    game.endReason = reason;
    game.winner = null;
    this.clearTurnTimer(game.id);
    this.clearDisconnectTimer(game.id, 'player1');
    this.clearDisconnectTimer(game.id, 'player2');

    const depositReturn = Math.floor(game.depositSats * (1 - PLATFORM_CUT_PERCENT / 100));
    const platformCut = (game.depositSats - depositReturn) * 2;

    return {
      winner: null, loser: null, reason,
      pot: game.pot,
      winnerPayout: depositReturn, loserPayout: depositReturn, platformCut,
      p1Address: game.player1.address,
      p2Address: game.player2.address,
    };
  }

  // ==========================================================================
  // DRAW / RESIGN
  // ==========================================================================

  offerDraw(socketId: string): { success: boolean; opponentSocketId?: string; error?: string } {
    const game = this.getGameBySocket(socketId);
    if (!game || game.phase !== 'playing') return { success: false, error: 'Game not active' };
    const slot = this.getSlot(game, socketId);
    if (!slot) return { success: false, error: 'Not a player' };
    const oppSlot = this.opponentSlot(slot);
    return { success: true, opponentSocketId: game[oppSlot].socketId };
  }

  acceptDraw(socketId: string): { success: boolean; result?: GameOverResult; error?: string } {
    const game = this.getGameBySocket(socketId);
    if (!game || game.phase !== 'playing') return { success: false, error: 'Game not active' };
    return { success: true, result: this.endGameDraw(game, 'draw_agreement') };
  }

  leaveWager(socketId: string): { gameId: string; opponentSocketId: string; leaverUsername: string } | null {
    const game = this.getGameBySocket(socketId);
    if (!game || game.phase !== 'awaiting_wagers') return null;
    const slot = this.getSlot(game, socketId);
    if (!slot) return null;
    if (game[slot].wagerPaid) return null;
    const oppSlot = this.opponentSlot(slot);
    const opponentSocketId = game[oppSlot].socketId;
    const leaverUsername = game[slot].username;
    this.removeGame(game.id);
    return { gameId: game.id, opponentSocketId, leaverUsername };
  }

  resign(socketId: string): { gameId: string; result: GameOverResult } | null {
    const game = this.getGameBySocket(socketId);
    if (!game || game.phase === 'gameover') return null;
    const slot = this.getSlot(game, socketId);
    if (!slot) return null;
    const winner = this.opponentSlot(slot);
    return { gameId: game.id, result: this.endGame(game, winner, 'resignation') };
  }

  // ==========================================================================
  // DISCONNECT / RECONNECT
  // ==========================================================================

  handleDisconnect(socketId: string): {
    gameId: string; slot: PlayerSlot;
    graceStarted: boolean; immediateResult: GameOverResult | null;
    wagerRefund?: { address: string; amount: number };
  } | null {
    const game = this.getGameBySocket(socketId);
    if (!game || game.phase === 'gameover') return null;
    const slot = this.getSlot(game, socketId);
    if (!slot) return null;

    game[slot].connected = false;
    game[slot].disconnectedAt = Date.now();
    const opponent = this.opponentSlot(slot);
    this.clearTurnTimer(game.id);

    if (game.phase === 'awaiting_wagers' && !game[slot].wagerPaid && !game[opponent].wagerPaid) {
      game.phase = 'gameover';
      game.endedAt = Date.now();
      game.endReason = 'disconnect';

      return {
        gameId: game.id, slot, graceStarted: false,
        immediateResult: {
          winner: null, loser: null, reason: 'disconnect',
          pot: 0, winnerPayout: 0, loserPayout: 0, platformCut: 0,
          p1Address: game.player1.address, p2Address: game.player2.address,
        },
      };
    }

    const timerKey = `${game.id}:${slot}`;
    this.clearDisconnectTimer(game.id, slot);

    const timer = setTimeout(() => {
      const g = this.games.get(game.id);
      if (!g || g.phase === 'gameover') return;
      if (!g[slot].connected) {
        this.onDisconnectTimeout?.(game.id, opponent, slot);
      }
    }, RECONNECT_GRACE_MS);

    this.disconnectTimers.set(timerKey, timer);
    return { gameId: game.id, slot, graceStarted: true, immediateResult: null };
  }

  handleReconnect(socketId: string, gameId: string, address: string): {
    success: boolean; game?: GameState; slot?: PlayerSlot; error?: string;
  } {
    const game = this.games.get(gameId);
    if (!game) return { success: false, error: 'Game not found' };
    if (game.phase === 'gameover') return { success: false, error: 'Game ended' };

    let slot: PlayerSlot | null = null;
    if (game.player1.address === address) slot = 'player1';
    else if (game.player2.address === address) slot = 'player2';
    if (!slot) return { success: false, error: 'Not in this game' };

    this.clearDisconnectTimer(gameId, slot);
    game[slot].connected = true;
    game[slot].disconnectedAt = null;
    game[slot].socketId = socketId;
    this.playerToGame.set(socketId, gameId);

    if (game.phase === 'playing') {
      const elapsed = Date.now() - game.turnStartedAt;
      const remaining = Math.max(1000, TURN_TIMEOUT_MS - elapsed);
      this.clearTurnTimer(game.id);
      const timer = setTimeout(() => {
        if (game.phase !== 'playing') return;
        const loser = game.currentTurn;
        const winner = this.opponentSlot(loser);
        this.onTurnTimeout?.(game.id, winner, loser);
      }, remaining);
      this.turnTimers.set(game.id, timer);
    }

    return { success: true, game, slot };
  }

  // ==========================================================================
  // CLIENT STATE
  // ==========================================================================

  getClientState(game: GameState, forSlot: PlayerSlot): object {
    const opp = this.opponentSlot(forSlot);
    return {
      gameId: game.id,
      phase: game.phase,
      mySlot: forSlot,
      myMark: game[forSlot].mark,
      opponent: { username: game[opp].username, address: game[opp].address },
      board: [...game.board],
      currentTurn: game.currentTurn,
      pot: game.pot,
      depositSats: game.depositSats,
      myWagerPaid: game[forSlot].wagerPaid,
      opponentWagerPaid: game[opp].wagerPaid,
      moveCount: game.moveCount,
      escrowAddress: escrowManager.getGameAddress(game.id),
      p1Mark: game.player1.mark,
      p2Mark: game.player2.mark,
    };
  }

  // ==========================================================================
  // TIMERS
  // ==========================================================================

  private startTurnTimer(game: GameState): void {
    this.clearTurnTimer(game.id);
    const timer = setTimeout(() => {
      if (game.phase !== 'playing') return;
      const loser = game.currentTurn;
      const winner = this.opponentSlot(loser);
      this.onTurnTimeout?.(game.id, winner, loser);
    }, TURN_TIMEOUT_MS);
    this.turnTimers.set(game.id, timer);
  }

  private clearTurnTimer(id: string): void {
    const t = this.turnTimers.get(id);
    if (t) { clearTimeout(t); this.turnTimers.delete(id); }
  }

  private clearDisconnectTimer(gameId: string, slot: PlayerSlot): void {
    const key = `${gameId}:${slot}`;
    const t = this.disconnectTimers.get(key);
    if (t) { clearTimeout(t); this.disconnectTimers.delete(key); }
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  getGame(id: string) { return this.games.get(id); }
  getGameBySocket(sid: string) {
    const id = this.playerToGame.get(sid);
    return id ? this.games.get(id) : undefined;
  }
  getSlot(g: GameState, sid: string): PlayerSlot | null {
    if (g.player1.socketId === sid) return 'player1';
    if (g.player2.socketId === sid) return 'player2';
    return null;
  }
  opponentSlot(s: PlayerSlot): PlayerSlot { return s === 'player1' ? 'player2' : 'player1'; }
  removeGame(id: string) {
    const g = this.games.get(id);
    if (!g) return;
    if (this.playerToGame.get(g.player1.socketId) === id) this.playerToGame.delete(g.player1.socketId);
    if (this.playerToGame.get(g.player2.socketId) === id) this.playerToGame.delete(g.player2.socketId);
    this.clearTurnTimer(id);
    this.clearDisconnectTimer(id, 'player1');
    this.clearDisconnectTimer(id, 'player2');
    this.games.delete(id);
  }
  getActiveCount() { return this.games.size; }
}

export const gameManager = new TicTacToeManager();
