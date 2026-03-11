// ============================================================================
// SOCKET HANDLER — BSV TikTakTo
// ============================================================================

import { Server, Socket } from 'socket.io';
import { gameManager, PlayerSlot, GameOverResult } from '../game/TicTacToeManager';
import { matchmakingQueue } from '../game/Matchmaking';
import { getTierByValue } from '../game/Constants';
import { escrowManager, priceService, fetchBalance, verifyAndBroadcastTx, spentTracker } from '../wallet/BsvService';
import * as db from '../DB/Database';
import { socketRateLimiter } from './SocketRateLimiter';
import { sessionManager } from './SessionManager';
import { lobbyManager } from '../game/LobbyManager';

function rateCheck(socket: Socket, event: string): boolean {
  if (!socketRateLimiter.check(socket.id, event)) {
    socket.emit('error', { message: 'Too many requests. Slow down.' });
    return false;
  }
  return true;
}

const pendingRevocations = new Map<string, NodeJS.Timeout>();
const REVOCATION_DELAY_MS = 35_000;

export function setupSocketHandlers(io: Server): void {

  let lobbyBroadcastTimer: NodeJS.Timeout | null = null;
  function broadcastLobby(): void {
    if (lobbyBroadcastTimer) return;
    lobbyBroadcastTimer = setTimeout(() => {
      lobbyBroadcastTimer = null;
      io.emit('lobby_update', {
        players: lobbyManager.getOnlinePlayers(),
        onlineCount: lobbyManager.getOnlineCount(),
      });
    }, 500);
  }

  lobbyManager.onChallengeExpired = (challenge) => {
    io.to(challenge.fromSocketId).emit('challenge_expired', {
      challengeId: challenge.id, toUsername: challenge.toUsername,
    });
    io.to(challenge.toSocketId).emit('challenge_expired', {
      challengeId: challenge.id, fromUsername: challenge.fromUsername,
    });
  };

  gameManager.onTurnTimeout = async (gameId, winnerSlot, loserSlot) => {
    const game = gameManager.getGame(gameId);
    if (!game) return;
    await handleGameEnd(game, gameManager.endGame(game, winnerSlot, 'timeout'));
  };

  gameManager.onDisconnectTimeout = async (gameId, winnerSlot, loserSlot) => {
    const game = gameManager.getGame(gameId);
    if (!game || game.phase === 'gameover') return;
    const result = gameManager.endGame(game, winnerSlot, 'disconnect');
    io.to(game[winnerSlot].socketId).emit('opponent_disconnected', {
      gameOver: true, message: `${game[loserSlot].username} didn't reconnect. You win!`,
    });
    await handleGameEnd(game, result);
  };

  // ==========================================================================
  // CONNECTION
  // ==========================================================================

  io.on('connection', (socket: Socket) => {
    console.log(`${socket.id} connected`);

    // ========================================================================
    // FIND MATCH
    // ========================================================================
    socket.on('find_match', async (data: { address: string; username: string; stakeTier: number }) => {
      if (!rateCheck(socket, 'find_match')) return;
      const { address, username, stakeTier } = data;

      const tier = getTierByValue(stakeTier);
      if (!tier) { socket.emit('error', { message: 'Invalid tier' }); return; }
      if (!username || username.length > 20) { socket.emit('error', { message: 'Bad username' }); return; }
      if (!/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) {
        socket.emit('error', { message: 'Invalid BSV address' }); return;
      }

      const clean = username.replace(/[<>&"']/g, '').trim();
      const sessionToken = sessionManager.create(socket.id, address);
      socket.emit('session_token', { token: sessionToken });

      await db.ensurePlayer(address, clean);

      const result = matchmakingQueue.enqueue({
        socketId: socket.id, address, username: clean, stakeTier, queuedAt: Date.now(),
      });

      if (result.matched && result.opponent) {
        const game = await gameManager.createGame(
          result.opponent.socketId, result.opponent.address, result.opponent.username,
          socket.id, address, clean, stakeTier,
        );
        if (!game) { socket.emit('error', { message: 'Game creation failed' }); return; }

        await db.recordGameStart(game.id, stakeTier, game.player1.address, game.player2.address);

        lobbyManager.setStatus(result.opponent.socketId, 'in_game');
        lobbyManager.setStatus(socket.id, 'in_game');
        broadcastLobby();

        const escrowAddr = escrowManager.getGameAddress(game.id);

        const matchData = (slot: PlayerSlot) => ({
          gameId: game.id, mySlot: slot,
          myMark: game[slot].mark,
          opponent: {
            username: game[gameManager.opponentSlot(slot)].username,
            address: game[gameManager.opponentSlot(slot)].address,
          },
          tier: { name: tier.name, depositCents: tier.depositCents },
          depositSats: game.depositSats,
          escrowAddress: escrowAddr, bsvPrice: game.bsvPriceAtStart,
          currentTurn: game.currentTurn,
          p1Mark: game.player1.mark,
          p2Mark: game.player2.mark,
        });

        io.to(game.player1.socketId).emit('match_found', matchData('player1'));
        io.to(game.player2.socketId).emit('match_found', matchData('player2'));

        console.log(`${game.player1.username} vs ${game.player2.username} @ ${tier.name}`);
      } else {
        lobbyManager.setStatus(socket.id, 'matchmaking');
        broadcastLobby();
        socket.emit('matchmaking_started', { tier: tier.name });
      }
    });

    socket.on('cancel_matchmaking', () => {
      if (!rateCheck(socket, 'cancel_matchmaking')) return;
      matchmakingQueue.remove(socket.id);
      lobbyManager.setStatus(socket.id, 'idle');
      socket.emit('matchmaking_cancelled');
      broadcastLobby();
    });

    // ========================================================================
    // LOBBY
    // ========================================================================

    socket.on('join_lobby', async (data: { address: string; username: string }) => {
      if (!rateCheck(socket, 'join_lobby')) return;
      const { address, username } = data;
      if (!username || username.length > 20) return;
      if (!address || !/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) return;

      const clean = username.replace(/[<>&"']/g, '').trim();
      const sessionToken = sessionManager.create(socket.id, address);
      socket.emit('session_token', { token: sessionToken });

      let stats = { gamesWon: 0, gamesPlayed: 0 };
      try {
        const playerStats = await db.getPlayerStats(address);
        if (playerStats) stats = { gamesWon: playerStats.games_won || 0, gamesPlayed: playerStats.games_played || 0 };
      } catch { /* ignore */ }

      lobbyManager.join(socket.id, address, clean, stats);
      broadcastLobby();
    });

    socket.on('get_lobby', () => {
      if (!rateCheck(socket, 'get_lobby')) return;
      socket.emit('lobby_update', {
        players: lobbyManager.getOnlinePlayers(),
        onlineCount: lobbyManager.getOnlineCount(),
      });
    });

    socket.on('challenge_player', async (data: { toAddress: string; stakeTier: number }) => {
      if (!rateCheck(socket, 'challenge_player')) return;
      const tier = getTierByValue(data.stakeTier);
      if (!tier) { socket.emit('error', { message: 'Invalid tier' }); return; }

      const result = lobbyManager.createChallenge(socket.id, data.toAddress, data.stakeTier);
      if (!result.success) { socket.emit('challenge_error', { error: result.error }); return; }

      const challenge = result.challenge!;
      socket.emit('challenge_sent', {
        challengeId: challenge.id, toUsername: challenge.toUsername,
        stakeTier: data.stakeTier, tierName: tier.name,
      });
      io.to(challenge.toSocketId).emit('challenge_received', {
        challengeId: challenge.id, fromUsername: challenge.fromUsername,
        fromAddress: challenge.fromAddress, stakeTier: data.stakeTier, tierName: tier.name,
      });
    });

    socket.on('accept_challenge', async (data: { challengeId: string }) => {
      if (!rateCheck(socket, 'accept_challenge')) return;
      const result = lobbyManager.acceptChallenge(data.challengeId, socket.id);
      if (!result.success) { socket.emit('challenge_error', { error: result.error }); return; }

      const challenge = result.challenge!;
      const tier = getTierByValue(challenge.stakeTier);
      if (!tier) { socket.emit('error', { message: 'Invalid tier' }); return; }

      const fromToken = sessionManager.create(challenge.fromSocketId, challenge.fromAddress);
      const toToken = sessionManager.create(challenge.toSocketId, challenge.toAddress);
      io.to(challenge.fromSocketId).emit('session_token', { token: fromToken });
      io.to(challenge.toSocketId).emit('session_token', { token: toToken });

      await db.ensurePlayer(challenge.fromAddress, challenge.fromUsername);
      await db.ensurePlayer(challenge.toAddress, challenge.toUsername);

      const game = await gameManager.createGame(
        challenge.fromSocketId, challenge.fromAddress, challenge.fromUsername,
        challenge.toSocketId, challenge.toAddress, challenge.toUsername,
        challenge.stakeTier,
      );
      if (!game) { socket.emit('error', { message: 'Game creation failed' }); return; }

      await db.recordGameStart(game.id, challenge.stakeTier, game.player1.address, game.player2.address);

      lobbyManager.setStatus(challenge.fromSocketId, 'in_game');
      lobbyManager.setStatus(challenge.toSocketId, 'in_game');
      broadcastLobby();

      const escrowAddr = escrowManager.getGameAddress(game.id);

      const matchData = (slot: PlayerSlot) => ({
        gameId: game.id, mySlot: slot,
        myMark: game[slot].mark,
        opponent: {
          username: game[gameManager.opponentSlot(slot)].username,
          address: game[gameManager.opponentSlot(slot)].address,
        },
        tier: { name: tier.name, depositCents: tier.depositCents },
        depositSats: game.depositSats,
        escrowAddress: escrowAddr, bsvPrice: game.bsvPriceAtStart,
        currentTurn: game.currentTurn,
        p1Mark: game.player1.mark,
        p2Mark: game.player2.mark,
      });

      io.to(game.player1.socketId).emit('match_found', matchData('player1'));
      io.to(game.player2.socketId).emit('match_found', matchData('player2'));

      console.log(`Challenge: ${game.player1.username} vs ${game.player2.username} @ ${tier.name}`);
    });

    socket.on('decline_challenge', (data: { challengeId: string }) => {
      if (!rateCheck(socket, 'decline_challenge')) return;
      const result = lobbyManager.declineChallenge(data.challengeId, socket.id);
      if (!result.success) return;
      io.to(result.challenge!.fromSocketId).emit('challenge_declined', {
        challengeId: result.challenge!.id, byUsername: result.challenge!.toUsername,
      });
    });

    // ========================================================================
    // WAGER
    // ========================================================================
    socket.on('submit_wager', async (data: { rawTxHex: string }) => {
      if (!rateCheck(socket, 'submit_payment')) return;

      const game = gameManager.getGameBySocket(socket.id);
      if (!game || game.phase !== 'awaiting_wagers') {
        socket.emit('error', { message: 'No game awaiting wager' }); return;
      }

      const slot = gameManager.getSlot(game, socket.id);
      if (!slot) { socket.emit('error', { message: 'Not a player' }); return; }
      if (game[slot].wagerPaid) { socket.emit('error', { message: 'Wager already paid' }); return; }

      const escrowAddr = escrowManager.getGameAddress(game.id);
      const result = await verifyAndBroadcastTx(
        data.rawTxHex, escrowAddr, game.depositSats, game.id, game[slot].address,
      );

      if (!result.verified) {
        socket.emit('wager_result', { success: false, error: result.error });
        return;
      }

      const confirm = gameManager.confirmWagerPayment(game.id, slot, result.txid);
      socket.emit('wager_result', { success: true, txid: result.txid });

      const oppSlot = gameManager.opponentSlot(slot);
      io.to(game[oppSlot].socketId).emit('opponent_wager_paid', { slot });

      if (confirm.bothPaid) {
        const startData = {
          currentTurn: game.currentTurn,
          pot: game.pot,
          depositSats: game.depositSats,
          board: [...game.board],
          p1Mark: game.player1.mark,
          p2Mark: game.player2.mark,
        };
        io.to(game.player1.socketId).emit('game_start', startData);
        io.to(game.player2.socketId).emit('game_start', startData);
        console.log(`Game ${game.id.slice(0, 8)} started — pot: ${game.pot} sats`);
      }
    });

    // ========================================================================
    // MAKE MOVE — Server-authoritative
    // ========================================================================
    socket.on('make_move', (data: { row: number; col: number }) => {
      if (!rateCheck(socket, 'make_move')) return;

      const result = gameManager.makeMove(socket.id, data.row, data.col);

      if ('error' in result) {
        socket.emit('move_error', { error: result.error });
        return;
      }

      const game = gameManager.getGameBySocket(socket.id);

      const moveData = {
        slot: result.slot,
        row: result.row,
        col: result.col,
        mark: result.mark,
        board: result.board,
        currentTurn: result.currentTurn,
        gameOver: result.gameOver,
        winLine: result.winLine || null,
      };

      if (game) {
        io.to(game.player1.socketId).emit('move_result', moveData);
        io.to(game.player2.socketId).emit('move_result', moveData);
      }

      if (result.gameOver && result.gameOverResult && game) {
        handleGameEnd(game, result.gameOverResult);
      }
    });

    // ========================================================================
    // DRAW / RESIGN
    // ========================================================================
    socket.on('offer_draw', () => {
      if (!rateCheck(socket, 'offer_draw')) return;
      const result = gameManager.offerDraw(socket.id);
      if (!result.success) { socket.emit('error', { message: result.error }); return; }
      io.to(result.opponentSocketId!).emit('draw_offered');
      socket.emit('draw_offer_sent');
    });

    socket.on('accept_draw', async () => {
      if (!rateCheck(socket, 'accept_draw')) return;
      const result = gameManager.acceptDraw(socket.id);
      if (!result.success) { socket.emit('error', { message: result.error }); return; }
      const game = gameManager.getGameBySocket(socket.id);
      if (game) await handleGameEnd(game, result.result!);
    });

    socket.on('decline_draw', () => {
      if (!rateCheck(socket, 'decline_draw')) return;
      const game = gameManager.getGameBySocket(socket.id);
      if (!game) return;
      const slot = gameManager.getSlot(game, socket.id);
      if (!slot) return;
      const opp = gameManager.opponentSlot(slot);
      io.to(game[opp].socketId).emit('draw_declined');
    });

    socket.on('leave_wager', () => {
      if (!rateCheck(socket, 'leave_wager')) return;
      const result = gameManager.leaveWager(socket.id);
      if (!result) return;
      socket.emit('game_cancelled', { reason: 'You left the match.' });
      io.to(result.opponentSocketId).emit('game_cancelled', {
        reason: `${result.leaverUsername} left before paying.`,
      });
      lobbyManager.setStatus(socket.id, 'idle');
      lobbyManager.setStatus(result.opponentSocketId, 'idle');
      spentTracker.releaseGame(result.gameId);
      broadcastLobby();
    });

    socket.on('resign', async () => {
      if (!rateCheck(socket, 'forfeit')) return;
      const result = gameManager.resign(socket.id);
      if (!result) return;
      const game = gameManager.getGame(result.gameId);
      if (game) await handleGameEnd(game, result.result);
    });

    // ========================================================================
    // RECONNECT
    // ========================================================================
    socket.on('reconnect_game', (data: { gameId: string; address: string }) => {
      if (!rateCheck(socket, 'reconnect_game')) return;
      const result = gameManager.handleReconnect(socket.id, data.gameId, data.address);
      if (!result.success) {
        socket.emit('reconnect_result', { success: false, error: result.error });
        return;
      }

      const game = result.game!;
      const slot = result.slot!;

      const revocationKey = `${game.id}:${slot}`;
      const pendingTimer = pendingRevocations.get(revocationKey);
      if (pendingTimer) { clearTimeout(pendingTimer); pendingRevocations.delete(revocationKey); }

      const sessionToken = sessionManager.create(socket.id, data.address);
      socket.emit('session_token', { token: sessionToken });

      socket.emit('reconnect_result', {
        success: true,
        gameState: gameManager.getClientState(game, slot),
      });

      const opp = gameManager.opponentSlot(slot);
      io.to(game[opp].socketId).emit('opponent_reconnected');
    });

    // ========================================================================
    // DISCONNECT
    // ========================================================================
    socket.on('disconnect', async () => {
      console.log(`${socket.id} disconnected`);
      socketRateLimiter.cleanup(socket.id);
      matchmakingQueue.remove(socket.id);
      lobbyManager.leave(socket.id);
      broadcastLobby();

      const gameResult = gameManager.handleDisconnect(socket.id);

      if (gameResult) {
        const game = gameManager.getGame(gameResult.gameId);

        if (gameResult.immediateResult && !gameResult.graceStarted) {
          spentTracker.releaseGame(gameResult.gameId);
          sessionManager.revokeBySocket(socket.id);
          const opp = gameManager.opponentSlot(gameResult.slot);

          if (game) {
            lobbyManager.setStatus(game[opp].socketId, 'idle');
            broadcastLobby();

            io.to(game[opp].socketId).emit('game_cancelled', {
              reason: 'Opponent left before paying deposit.',
              refund: gameResult.wagerRefund ? gameResult.wagerRefund.amount : 0,
            });

            if (gameResult.wagerRefund) {
              try {
                const refundResult = await escrowManager.settle(
                  gameResult.gameId, gameResult.wagerRefund.address, gameResult.wagerRefund.amount, 0
                );
                if (refundResult.success) {
                  io.to(game[opp].socketId).emit('wager_refunded', {
                    amount: gameResult.wagerRefund.amount, txid: refundResult.txid,
                  });
                }
              } catch (err) {
                console.error('Refund exception:', err);
              }
            }
          }
          return;
        }

        if (gameResult.graceStarted && game) {
          const revocationKey = `${gameResult.gameId}:${gameResult.slot}`;
          const timer = setTimeout(() => {
            sessionManager.revokeBySocket(socket.id);
            pendingRevocations.delete(revocationKey);
          }, REVOCATION_DELAY_MS);
          pendingRevocations.set(revocationKey, timer);

          const opp = gameManager.opponentSlot(gameResult.slot);
          io.to(game[opp].socketId).emit('opponent_disconnected', {
            gameOver: false,
            message: `${game[gameResult.slot].username} disconnected. 30s to reconnect...`,
            graceMs: 30_000,
          });
        } else {
          sessionManager.revokeBySocket(socket.id);
        }
      } else {
        sessionManager.revokeBySocket(socket.id);
      }
    });

    // ========================================================================
    // INFO
    // ========================================================================
    socket.on('get_queue_info', () => {
      if (!rateCheck(socket, 'get_queue_info')) return;
      socket.emit('queue_info', {
        queues: matchmakingQueue.getQueueSizes(),
        activeGames: gameManager.getActiveCount(),
      });
    });

    socket.on('get_leaderboard', async () => {
      if (!rateCheck(socket, 'get_leaderboard')) return;
      try { socket.emit('leaderboard', await db.getLeaderboard()); }
      catch { socket.emit('error', { message: 'Leaderboard failed' }); }
    });
  });

  // ==========================================================================
  // GAME END HANDLER
  // ==========================================================================

  async function handleGameEnd(game: any, result: GameOverResult) {
    const p1 = game.player1;
    const p2 = game.player2;

    io.to(p1.socketId).emit('settling', { message: 'Settling accounts...' });
    io.to(p2.socketId).emit('settling', { message: 'Settling accounts...' });

    let settleTxid = '';

    if (result.winner) {
      const winnerAddr = result.winner === 'player1' ? result.p1Address : result.p2Address;
      if (result.pot > 0 && (result.winnerPayout > 546 || result.platformCut > 546)) {
        const tx = await escrowManager.settle(game.id, winnerAddr, result.winnerPayout, result.platformCut);
        if (tx.success) {
          settleTxid = tx.txid || '';
          console.log(`Settled: ${result.winnerPayout} -> winner, ${result.platformCut} -> platform`);
        } else {
          console.error(`Settlement failed: ${tx.error}`);
        }
      }
    } else {
      if (result.pot > 0 && result.winnerPayout > 546) {
        const tx = await escrowManager.settle(
          game.id, result.p1Address, result.winnerPayout,
          result.platformCut, result.p2Address, result.loserPayout,
        );
        if (tx.success) settleTxid = tx.txid || '';
      }
    }

    const base = {
      winner: result.winner, reason: result.reason, pot: result.pot,
      settleTxid, board: [...game.board], winLine: result.winLine || null,
    };

    if (result.winner) {
      const winnerSocket = result.winner === 'player1' ? p1.socketId : p2.socketId;
      const loserSocket = result.winner === 'player1' ? p2.socketId : p1.socketId;
      const loserName = result.winner === 'player1' ? p2.username : p1.username;

      io.to(winnerSocket).emit('game_over', {
        ...base, payout: result.winnerPayout,
        message: result.reason === 'resignation'
          ? `${loserName} forfeited! You win!`
          : result.reason === 'disconnect'
          ? `${loserName} disconnected! You win!`
          : result.reason === 'timeout'
          ? `${loserName} ran out of time! You win!`
          : 'You win!',
      });
      io.to(loserSocket).emit('game_over', {
        ...base, payout: 0,
        message: result.reason === 'win' ? 'You lost!'
               : result.reason === 'resignation' ? 'You surrendered.'
               : result.reason === 'disconnect' ? 'You disconnected and lost.'
               : result.reason === 'timeout' ? 'You ran out of time!'
               : 'You lost.',
      });
    } else {
      io.to(p1.socketId).emit('game_over', { ...base, payout: result.winnerPayout, message: 'Draw!' });
      io.to(p2.socketId).emit('game_over', { ...base, payout: result.loserPayout, message: 'Draw!' });
    }

    try {
      await db.recordGameEnd(
        game.id,
        result.winner ? (result.winner === 'player1' ? result.p1Address : result.p2Address) : null,
        result.reason, result.pot, result.winnerPayout, result.platformCut, settleTxid,
        game.moveCount,
      );
    } catch (err) { console.error('DB record failed:', err); }

    spentTracker.releaseGame(game.id);

    lobbyManager.setStatus(p1.socketId, 'idle');
    lobbyManager.setStatus(p2.socketId, 'idle');
    broadcastLobby();

    setTimeout(() => gameManager.removeGame(game.id), 60_000);
  }
}
