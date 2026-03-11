// ============================================================================
// useMultiplayer — Socket.IO hook for BSV TikTakTo
// ============================================================================

import { useState, useRef, useCallback, useEffect } from 'react';
import { io, Socket } from 'socket.io-client';
import { BACKEND_URL, STORAGE_KEYS } from '../constants';
import { setSessionToken } from '../services';
import { sfx } from '../services/SoundService';

export type GamePhase = 'lobby' | 'matchmaking' | 'awaiting_wagers' | 'playing' | 'gameover';
export type PlayerSlot = 'player1' | 'player2';
export type CellValue = '' | 'X' | 'O';

export function useMultiplayer() {
  const [gamePhase, setGamePhase] = useState<GamePhase>('lobby');
  const [isConnected, setIsConnected] = useState(false);
  const [gameId, setGameId] = useState('');
  const [mySlot, setMySlot] = useState<PlayerSlot>('player1');
  const [myMark, setMyMark] = useState<'X' | 'O'>('X');
  const [opponentName, setOpponentName] = useState('');
  const [opponentAddress, setOpponentAddress] = useState('');
  const [escrowAddress, setEscrowAddress] = useState('');
  const [depositSats, setDepositSats] = useState(0);
  const [pot, setPot] = useState(0);
  const [myWagerPaid, setMyWagerPaid] = useState(false);
  const [opponentWagerPaid, setOpponentWagerPaid] = useState(false);
  const [board, setBoard] = useState<CellValue[]>(Array(9).fill(''));
  const [currentTurn, setCurrentTurn] = useState<PlayerSlot>('player1');
  const [p1Mark, setP1Mark] = useState<'X' | 'O'>('X');
  const [p2Mark, setP2Mark] = useState<'X' | 'O'>('O');
  const [winner, setWinner] = useState<PlayerSlot | 'draw' | null>(null);
  const [winLine, setWinLine] = useState<number[] | null>(null);
  const [message, setMessage] = useState('');
  const [drawOffered, setDrawOffered] = useState(false);

  // Lobby
  const [lobbyPlayers, setLobbyPlayers] = useState<any[]>([]);
  const [incomingChallenge, setIncomingChallenge] = useState<any>(null);

  const socketRef = useRef<Socket | null>(null);
  const boardRef = useRef<CellValue[]>(Array(9).fill(''));
  const mySlotRef = useRef<PlayerSlot>(mySlot);

  useEffect(() => { mySlotRef.current = mySlot; }, [mySlot]);

  const connect = useCallback(() => {
    if (socketRef.current) return;
    const socket = io(BACKEND_URL, { transports: ['websocket', 'polling'] });

    socket.on('connect', () => setIsConnected(true));
    socket.on('disconnect', () => setIsConnected(false));

    socket.on('session_token', (data: { token: string }) => {
      setSessionToken(data.token);
    });

    socket.on('match_found', (data) => {
      sfx.play('matchFound');
      setGameId(data.gameId);
      setMySlot(data.mySlot);
      setMyMark(data.myMark);
      setOpponentName(data.opponent.username);
      setOpponentAddress(data.opponent.address);
      setEscrowAddress(data.escrowAddress);
      setDepositSats(data.depositSats);
      setCurrentTurn(data.currentTurn);
      setP1Mark(data.p1Mark);
      setP2Mark(data.p2Mark);
      setBoard(Array(9).fill(''));
      setPot(0);
      setMyWagerPaid(false);
      setOpponentWagerPaid(false);
      setWinLine(null);
      setGamePhase('awaiting_wagers');
      setMessage(`Matched with ${data.opponent.username}! Pay deposit to start.`);
      localStorage.setItem(STORAGE_KEYS.GAME_ID, data.gameId);
    });

    socket.on('wager_result', (data) => {
      if (data.success) {
        sfx.play('deposit');
        setMyWagerPaid(true);
        setMessage('Deposit paid! Waiting for opponent...');
      } else {
        sfx.play('invalid');
        setMessage(`Wager failed: ${data.error}`);
      }
    });

    socket.on('opponent_wager_paid', () => setOpponentWagerPaid(true));

    socket.on('game_start', (data) => {
      sfx.play('turn');
      setPot(data.pot);
      setCurrentTurn(data.currentTurn);
      setBoard(data.board || Array(9).fill(''));
      if (data.p1Mark) setP1Mark(data.p1Mark);
      if (data.p2Mark) setP2Mark(data.p2Mark);
      setGamePhase('playing');
      setMessage('Game on! X goes first.');
    });

    socket.on('move_result', (data) => {
      // Figure out which mark was just placed by diffing boards
      const prev = boardRef.current;
      const next: CellValue[] = data.board;
      for (let i = 0; i < 9; i++) {
        if (prev[i] === '' && next[i] !== '') {
          sfx.play(next[i] === 'X' ? 'placeX' : 'placeO');
          break;
        }
      }
      boardRef.current = next;
      setBoard(next);
      setCurrentTurn(data.currentTurn);
      if (data.winLine) setWinLine(data.winLine);
    });

    socket.on('draw_offered', () => {
      sfx.play('drawOffer');
      setDrawOffered(true);
      setMessage('Opponent offers a draw. Accept?');
    });

    socket.on('draw_declined', () => setMessage('Draw offer declined.'));
    socket.on('draw_offer_sent', () => setMessage('Draw offer sent...'));

    socket.on('settling', () => setMessage('Settling accounts...'));

    socket.on('game_over', (data) => {
      setGamePhase('gameover');
      setPot(data.pot);
      if (data.board) setBoard(data.board);
      if (data.winLine) setWinLine(data.winLine);
      const outcome = data.winner === null ? 'draw' : data.winner;
      setWinner(outcome);
      setDrawOffered(false);
      setMessage(data.message);
      localStorage.removeItem(STORAGE_KEYS.GAME_ID);
      // Play result sound after a short delay so win line renders first
      setTimeout(() => {
        if (outcome === 'draw') sfx.play('draw');
        else sfx.play(outcome === mySlotRef.current ? 'win' : 'lose');
      }, 300);
    });

    socket.on('opponent_disconnected', (data) => setMessage(data.message));
    socket.on('opponent_reconnected', () => setMessage('Opponent reconnected!'));

    socket.on('reconnect_result', (data) => {
      if (data.success) {
        const gs = data.gameState;
        setGameId(gs.gameId);
        setMySlot(gs.mySlot);
        setMyMark(gs.myMark);
        setOpponentName(gs.opponent.username);
        setOpponentAddress(gs.opponent.address);
        setBoard(gs.board);
        setCurrentTurn(gs.currentTurn);
        setPot(gs.pot);
        setDepositSats(gs.depositSats);
        if (gs.escrowAddress) setEscrowAddress(gs.escrowAddress);
        setMyWagerPaid(gs.myWagerPaid);
        setOpponentWagerPaid(gs.opponentWagerPaid);
        if (gs.p1Mark) setP1Mark(gs.p1Mark);
        if (gs.p2Mark) setP2Mark(gs.p2Mark);
        setGamePhase(gs.phase === 'gameover' ? 'gameover' : gs.phase);
        setMessage('Reconnected to your game!');
      } else {
        localStorage.removeItem(STORAGE_KEYS.GAME_ID);
      }
    });

    socket.on('matchmaking_started', (data) => {
      setGamePhase('matchmaking');
      setMessage(`Searching for ${data.tier} opponent...`);
    });

    socket.on('matchmaking_cancelled', () => {
      setGamePhase('lobby');
      setMessage('');
    });

    socket.on('lobby_update', (data) => setLobbyPlayers(data.players || []));

    socket.on('challenge_received', (data) => {
      sfx.play('challenge');
      setIncomingChallenge({
        id: data.challengeId, fromUsername: data.fromUsername,
        fromAddress: data.fromAddress, stakeTier: data.stakeTier,
      });
    });

    socket.on('challenge_declined', (data) => {
      setMessage(`${data.byUsername || 'Opponent'} declined your challenge.`);
    });

    socket.on('challenge_expired', () => {
      setIncomingChallenge(null);
      setMessage('Challenge expired.');
    });

    socket.on('game_cancelled', (data) => {
      setGamePhase('lobby');
      setGameId('');
      setMyWagerPaid(false);
      setOpponentWagerPaid(false);
      setMessage(data.reason || 'Game cancelled.');
      localStorage.removeItem(STORAGE_KEYS.GAME_ID);
    });

    socket.on('wager_refunded', (data) => {
      setMessage(`Deposit refunded: ${data.amount} sats. TX: ${data.txid?.slice(0, 12)}...`);
    });

    socket.on('error', (data) => setMessage(data.message || 'Error'));

    socketRef.current = socket;
  }, []);

  const tryReconnect = useCallback(() => {
    const savedGameId = localStorage.getItem(STORAGE_KEYS.GAME_ID);
    const savedAddr = localStorage.getItem(STORAGE_KEYS.WALLET_ADDR);
    if (savedGameId && savedAddr && socketRef.current?.connected) {
      socketRef.current.emit('reconnect_game', { gameId: savedGameId, address: savedAddr });
    }
  }, []);

  useEffect(() => {
    if (!isConnected) return;
    tryReconnect();
  }, [isConnected, tryReconnect]);

  const findMatch = useCallback((address: string, username: string, stakeTier: number) => {
    socketRef.current?.emit('find_match', { address, username, stakeTier });
  }, []);

  const cancelMatchmaking = useCallback(() => {
    socketRef.current?.emit('cancel_matchmaking');
    setGamePhase('lobby');
  }, []);

  const submitWager = useCallback((rawTxHex: string) => {
    socketRef.current?.emit('submit_wager', { rawTxHex });
  }, []);

  const makeMove = useCallback((row: number, col: number) => {
    socketRef.current?.emit('make_move', { row, col });
  }, []);

  const offerDraw = useCallback(() => { socketRef.current?.emit('offer_draw'); }, []);
  const acceptDraw = useCallback(() => { setDrawOffered(false); socketRef.current?.emit('accept_draw'); }, []);
  const declineDraw = useCallback(() => { setDrawOffered(false); socketRef.current?.emit('decline_draw'); }, []);
  const resign = useCallback(() => { sfx.play('resign'); socketRef.current?.emit('resign'); }, []);
  const leaveWager = useCallback(() => { socketRef.current?.emit('leave_wager'); }, []);

  const joinLobby = useCallback((address: string, username: string) => {
    const s = socketRef.current;
    if (!s?.connected) return;
    s.emit('join_lobby', { address, username });
    setTimeout(() => s.emit('get_lobby'), 600);
  }, []);

  const refreshLobby = useCallback(() => { socketRef.current?.emit('get_lobby'); }, []);

  const challengePlayer = useCallback((toAddress: string, stakeTier: number) => {
    socketRef.current?.emit('challenge_player', { toAddress, stakeTier });
  }, []);

  const acceptChallenge = useCallback((challengeId: string) => {
    socketRef.current?.emit('accept_challenge', { challengeId });
    setIncomingChallenge(null);
  }, []);

  const declineChallenge = useCallback((challengeId: string) => {
    socketRef.current?.emit('decline_challenge', { challengeId });
    setIncomingChallenge(null);
  }, []);

  const resetGame = useCallback(() => {
    setGamePhase('lobby');
    setGameId('');
    setPot(0);
    setWinner(null);
    setWinLine(null);
    setMessage('');
    setMyWagerPaid(false);
    setOpponentWagerPaid(false);
    setBoard(Array(9).fill(''));
    boardRef.current = Array(9).fill('');
    setDrawOffered(false);
  }, []);

  return {
    gamePhase, isConnected, gameId, mySlot, myMark, opponentName, opponentAddress,
    escrowAddress, depositSats, pot, myWagerPaid, opponentWagerPaid,
    board, currentTurn, p1Mark, p2Mark,
    winner, winLine, message, drawOffered,
    lobbyPlayers, incomingChallenge,
    connect, findMatch, cancelMatchmaking, submitWager, makeMove,
    offerDraw, acceptDraw, declineDraw, resign, leaveWager,
    joinLobby, refreshLobby, challengePlayer, acceptChallenge, declineChallenge,
    resetGame, setMessage, tryReconnect,
  };
}
