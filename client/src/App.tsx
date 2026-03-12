// ============================================================================
// BSV TikTakTo — Main App
// ============================================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import { PrivateKey } from '@bsv/sdk';
import { useMultiplayer } from './hooks/useMultiplayer';
import { bsvWalletService } from './services/BsvWalletService';
import { yoursWalletService } from './services/YoursWalletService';
import { fetchBsvPrice } from './services/BsvPriceService';
import {
  hasStoredWallet, getAddressHint, encryptAndStoreWif,
  decryptStoredWif, deleteStoredWallet,
} from './services/pinCrypto';
import { isEmbedded, bridgeGetAddress, bridgeGetBalance, bridgeSignTransaction } from './services';
import { STAKE_TIERS, STORAGE_KEYS, BSV_NETWORK } from './constants';
import { sfx } from './services/SoundService';
import WalletPage from './components/WalletPage';
import './App.css';
import './styles/WalletStyles.css';

type WalletSource = 'local' | 'yours' | 'embedded';
const networkLabel = BSV_NETWORK === 'main' ? 'mainnet' : 'testnet';

function App() {
  const [walletReady, setWalletReady] = useState(false);
  const [walletSource, setWalletSource] = useState<WalletSource>('local');
  const [address, setAddress] = useState('');
  const [balance, setBalance] = useState(0);
  const [bsvPrice, setBsvPrice] = useState(0);
  const [username, setUsername] = useState(() => localStorage.getItem(STORAGE_KEYS.USERNAME) || '');
  const [embeddedMode] = useState(() => isEmbedded());
  const [yoursAvailable, setYoursAvailable] = useState(false);
  const [loginMode, setLoginMode] = useState<'none' | 'create' | 'unlock' | 'import'>('none');
  const [pin, setPin] = useState('');
  const [importWif, setImportWif] = useState('');
  const [loginError, setLoginError] = useState('');
  const [selectedTier, setSelectedTier] = useState(1);
  const [payingDeposit, setPayingDeposit] = useState(false);
  const [showWallet, setShowWallet] = useState(false);
  const refreshBalanceRef = useRef<() => void>(() => {});

  const mp = useMultiplayer({ onBalanceChange: () => refreshBalanceRef.current() });

  useEffect(() => { mp.connect(); sfx.preloadAll(); }, [mp.connect]);

  useEffect(() => {
    if (embeddedMode) {
      (async () => {
        try {
          const addr = await bridgeGetAddress();
          const bal = await bridgeGetBalance();
          const savedName = localStorage.getItem(STORAGE_KEYS.USERNAME) || 'Player';
          setUsername(savedName);
          setAddress(addr);
          setBalance(bal);
          setWalletSource('embedded');
          setWalletReady(true);
        } catch (e) {
          console.error('Bridge wallet init failed:', e);
          if (hasStoredWallet()) setLoginMode('unlock');
          else setLoginMode('create');
        }
      })();
      return;
    }
    if (hasStoredWallet()) setLoginMode('unlock');
    else setLoginMode('create');
  }, []);

  // Detect Yours Wallet extension
  useEffect(() => {
    const check = () => setYoursAvailable(yoursWalletService.isExtensionAvailable());
    check();
    const timer = setTimeout(check, 1000);
    return () => clearTimeout(timer);
  }, []);

  const refreshBalance = useCallback(async () => {
    if (walletSource === 'embedded') {
      try { setBalance(await bridgeGetBalance()); } catch { /* ignore */ }
      return;
    }
    if (walletSource === 'yours') {
      try { setBalance(await yoursWalletService.getBalance()); } catch { /* ignore */ }
      return;
    }
    if (!address) return;
    try {
      const res = await fetch(`https://api.whatsonchain.com/v1/bsv/${BSV_NETWORK === 'main' ? 'main' : 'test'}/address/${address}/balance`);
      if (res.ok) {
        const data = await res.json();
        setBalance((data.confirmed || 0) + (data.unconfirmed || 0));
      }
    } catch { /* ignore */ }
  }, [address, walletSource]);

  useEffect(() => { refreshBalanceRef.current = refreshBalance; }, [refreshBalance]);

  useEffect(() => {
    if (!walletReady) return;
    refreshBalance();
    const iv = setInterval(refreshBalance, 15_000);
    return () => clearInterval(iv);
  }, [walletReady, refreshBalance]);

  useEffect(() => {
    fetchBsvPrice().then(setBsvPrice);
    const iv = setInterval(() => fetchBsvPrice().then(setBsvPrice), 60_000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    const body = document.body;
    body.classList.remove('bg-login', 'bg-lobby', 'bg-battle');
    if (!walletReady) {
      body.classList.add('bg-login');
    } else if (mp.gamePhase === 'playing' || mp.gamePhase === 'gameover') {
      body.classList.add('bg-battle');
    } else {
      body.classList.add('bg-lobby');
    }
  }, [walletReady, mp.gamePhase]);

  useEffect(() => {
    if (walletReady && mp.isConnected && username && mp.gamePhase === 'lobby') {
      mp.joinLobby(address, username);
    }
  }, [walletReady, mp.isConnected, username, address, mp.gamePhase, mp.joinLobby]);

  const initWallet = (wif: string) => {
    const pk = PrivateKey.fromWif(wif);
    const addr = pk.toPublicKey().toAddress(networkLabel).toString();
    bsvWalletService.connect(wif);
    setAddress(addr);
    setWalletReady(true);
    sfx.play('walletUnlock');
  };

  const handleCreate = async () => {
    if (pin.length < 4) { setLoginError('PIN must be at least 4 digits'); return; }
    if (!username.trim()) { setLoginError('Enter a username'); return; }
    const pk = PrivateKey.fromRandom();
    const wif = pk.toWif();
    const addr = pk.toPublicKey().toAddress(networkLabel).toString();
    await encryptAndStoreWif(wif, pin, addr);
    localStorage.setItem(STORAGE_KEYS.USERNAME, username.trim());
    initWallet(wif);
  };

  const handleUnlock = async () => {
    try {
      const wif = await decryptStoredWif(pin);
      if (!username.trim()) { setLoginError('Enter a username'); return; }
      localStorage.setItem(STORAGE_KEYS.USERNAME, username.trim());
      initWallet(wif);
    } catch (err: any) {
      setLoginError(err.message);
    }
  };

  const handleImport = async () => {
    if (pin.length < 4) { setLoginError('PIN must be at least 4 digits'); return; }
    if (!username.trim()) { setLoginError('Enter a username'); return; }
    try {
      const pk = PrivateKey.fromWif(importWif.trim());
      const addr = pk.toPublicKey().toAddress(networkLabel).toString();
      await encryptAndStoreWif(importWif.trim(), pin, addr);
      localStorage.setItem(STORAGE_KEYS.USERNAME, username.trim());
      initWallet(importWif.trim());
    } catch {
      setLoginError('Invalid WIF key');
    }
  };

  const handleConnectYours = async () => {
    if (!username.trim()) { setLoginError('Enter a username first'); return; }
    try {
      const { address: addr } = await yoursWalletService.connect();
      localStorage.setItem(STORAGE_KEYS.USERNAME, username.trim());
      setAddress(addr);
      setWalletSource('yours');
      setWalletReady(true);
      sfx.play('walletUnlock');
    } catch (err: any) {
      setLoginError(err.message);
    }
  };

  const handleDeleteWallet = () => {
    if (walletSource === 'yours') {
      yoursWalletService.disconnect();
    }
    deleteStoredWallet();
    setWalletReady(false);
    setWalletSource('local');
    setAddress('');
    setLoginMode('create');
  };

  const handleFindMatch = () => {
    mp.findMatch(address, username, selectedTier);
  };

  const handlePayDeposit = async () => {
    setPayingDeposit(true);
    mp.setMessage('Building transaction...');
    try {
      let result: { success: boolean; rawTxHex?: string; error?: string };

      if (walletSource === 'embedded') {
        result = await bridgeSignTransaction(
          mp.escrowAddress, mp.depositSats,
          JSON.stringify({ app: 'TIKTAKTO', action: 'DEPOSIT', game: mp.gameId.substring(0, 8) }),
        );
      } else if (walletSource === 'yours') {
        const memo = JSON.stringify({ app: 'TIKTAKTO', action: 'DEPOSIT', game: mp.gameId.substring(0, 8) });
        const txResult = await yoursWalletService.sendBsv(mp.escrowAddress, mp.depositSats, memo);
        result = { success: true, rawTxHex: txResult.rawtx };
      } else {
        result = await bsvWalletService.sendGamePayment(
          mp.escrowAddress, mp.depositSats, mp.gameId, 'deposit',
        );
      }

      if (result.success && result.rawTxHex) {
        mp.submitWager(result.rawTxHex);
      } else {
        mp.setMessage(`Payment failed: ${result.error}`);
      }
    } catch (err: any) {
      mp.setMessage(`Payment error: ${err.message}`);
    }
    setPayingDeposit(false);
  };

  const handleCellClick = (index: number) => {
    if (mp.gamePhase !== 'playing') return;
    if (mp.currentTurn !== mp.mySlot) return;
    if (mp.board[index] !== '') return;
    const row = Math.floor(index / 3);
    const col = index % 3;
    mp.makeMove(row, col);
  };

  const isMyTurn = mp.currentTurn === mp.mySlot;
  const currentMark = mp.currentTurn === 'player1' ? mp.p1Mark : mp.p2Mark;

  // ========================================================================
  // LOGIN SCREEN
  // ========================================================================
  if (!walletReady) {
    return (
      <div className="app">
        <div className="login-screen">
          {/* Animated board logo */}
          <div className="logo-board">
            <div className="logo-cell"><span className="logo-x">X</span></div>
            <div className="logo-cell logo-cell-empty" />
            <div className="logo-cell"><span className="logo-o">O</span></div>
            <div className="logo-cell"><span className="logo-o">O</span></div>
            <div className="logo-cell"><span className="logo-x">X</span></div>
            <div className="logo-cell logo-cell-empty" />
            <div className="logo-cell logo-cell-empty" />
            <div className="logo-cell"><span className="logo-o">O</span></div>
            <div className="logo-cell"><span className="logo-x">X</span></div>
          </div>

          <h1 className="login-title">TikTakTo</h1>
          <p className="login-sub">Wager. Play. Win.</p>

          <div className="login-card">
            {loginMode === 'unlock' && (
              <>
                <div className="login-hint">
                  <div className="hint-dot" />
                  <span>{getAddressHint()?.slice(0, 14)}...</span>
                </div>
                <input className="login-input" placeholder="Username" value={username}
                  onChange={e => { setUsername(e.target.value); setLoginError(''); }} />
                <input className="login-input" type="password" placeholder="PIN"
                  value={pin} onChange={e => { setPin(e.target.value); setLoginError(''); }}
                  onKeyDown={e => e.key === 'Enter' && handleUnlock()} />
                <button className="btn btn-neon" onClick={handleUnlock}>Unlock</button>
                {yoursAvailable && (
                  <button className="btn btn-yours" onClick={handleConnectYours}>Connect Yours Wallet</button>
                )}
                <div className="login-links">
                  <button className="link-btn" onClick={() => setLoginMode('import')}>Import key</button>
                  <button className="link-btn link-danger" onClick={handleDeleteWallet}>Delete wallet</button>
                </div>
              </>
            )}

            {loginMode === 'create' && (
              <>
                <p className="login-label">New player? Create a wallet.</p>
                <input className="login-input" placeholder="Username" value={username}
                  onChange={e => { setUsername(e.target.value); setLoginError(''); }} />
                <input className="login-input" type="password" placeholder="Set PIN (4+ digits)"
                  value={pin} onChange={e => { setPin(e.target.value); setLoginError(''); }}
                  onKeyDown={e => e.key === 'Enter' && handleCreate()} />
                <button className="btn btn-neon" onClick={handleCreate}>Create Wallet</button>
                {yoursAvailable && (
                  <button className="btn btn-yours" onClick={handleConnectYours}>Connect Yours Wallet</button>
                )}
                <div className="login-links">
                  <button className="link-btn" onClick={() => setLoginMode('import')}>Import existing key</button>
                </div>
              </>
            )}

            {loginMode === 'import' && (
              <>
                <p className="login-label">Import your WIF private key</p>
                <input className="login-input" placeholder="Username" value={username}
                  onChange={e => { setUsername(e.target.value); setLoginError(''); }} />
                <input className="login-input mono" placeholder="WIF Private Key" value={importWif}
                  onChange={e => { setImportWif(e.target.value); setLoginError(''); }} />
                <input className="login-input" type="password" placeholder="Set PIN (4+ digits)"
                  value={pin} onChange={e => { setPin(e.target.value); setLoginError(''); }}
                  onKeyDown={e => e.key === 'Enter' && handleImport()} />
                <button className="btn btn-neon" onClick={handleImport}>Import & Encrypt</button>
                {yoursAvailable && (
                  <button className="btn btn-yours" onClick={handleConnectYours}>Connect Yours Wallet</button>
                )}
                <div className="login-links">
                  <button className="link-btn" onClick={() => setLoginMode(hasStoredWallet() ? 'unlock' : 'create')}>Back</button>
                </div>
              </>
            )}

            {loginError && <div className="error-msg">{loginError}</div>}
          </div>

          <p className="login-footer">Powered by Bitcoin SV</p>
        </div>
      </div>
    );
  }

  // ========================================================================
  // MAIN GAME UI
  // ========================================================================
  if (showWallet) {
    return (
      <div className="app">
        <WalletPage
          onBack={() => { setShowWallet(false); refreshBalance(); }}
          walletAddress={address}
          balance={balance}
          bsvPrice={bsvPrice}
          walletSource={walletSource}
          onRefreshBalance={refreshBalance}
        />
      </div>
    );
  }

  return (
    <div className="app">
      {/* Top bar */}
      <header className="topbar">
        <div className="topbar-left">
          <span className="topbar-logo">TTT</span>
          <span className="topbar-user">{username}</span>
          {walletSource === 'yours' && <span className="topbar-badge">Yours</span>}
        </div>
        <div className="topbar-right">
          <button className="topbar-wallet-btn" onClick={() => setShowWallet(true)}>Wallet</button>
          <div className="topbar-stat">
            <span className="stat-label">Balance</span>
            <span className="stat-value">{balance.toLocaleString()} sats</span>
          </div>
          <div className="topbar-stat">
            <span className="stat-label">BSV</span>
            <span className="stat-value">${bsvPrice.toFixed(2)}</span>
          </div>
          <div className={`status-dot ${mp.isConnected ? 'online' : 'offline'}`} />
        </div>
      </header>

      {/* Message toast */}
      {mp.message && (
        <div className="toast">
          <span>{mp.message}</span>
        </div>
      )}

      <main className="main">
        {/* LOBBY */}
        {mp.gamePhase === 'lobby' && (
          <div className="panel fade-in">
            <h2 className="panel-title">Play</h2>
            <p className="panel-sub">Select a wager tier and find an opponent</p>

            <div className="tier-grid">
              {STAKE_TIERS.map(t => (
                <button key={t.tier}
                  className={`tier-chip ${selectedTier === t.tier ? 'active' : ''}`}
                  onClick={() => setSelectedTier(t.tier)}>
                  <span className="tier-name">{t.name}</span>
                  <span className="tier-cost">{t.depositCents >= 100 ? `$${(t.depositCents / 100).toFixed(0)}` : `${t.depositCents}c`}</span>
                </button>
              ))}
            </div>

            <button className="btn btn-primary btn-lg" onClick={handleFindMatch}>
              Find Match
            </button>

            {mp.lobbyPlayers.length > 0 && (
              <div className="lobby-section">
                <h3 className="lobby-heading">
                  Online <span className="badge">{mp.lobbyPlayers.length}</span>
                </h3>
                <div className="lobby-list">
                  {mp.lobbyPlayers.map(p => (
                    <div key={p.address} className="lobby-row">
                      <div className="lobby-player">
                        <div className={`status-dot-sm ${p.status === 'idle' ? 'online' : 'busy'}`} />
                        <span className="lobby-name">{p.username}</span>
                        <span className="lobby-wins">{p.gamesWon}W</span>
                      </div>
                      {p.address !== address && p.status === 'idle' && (
                        <button className="btn btn-ghost btn-sm"
                          onClick={() => mp.challengePlayer(p.address, selectedTier)}>
                          Challenge
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {mp.incomingChallenge && (
              <div className="challenge-banner fade-in">
                <div className="challenge-text">
                  <strong>{mp.incomingChallenge.fromUsername}</strong> challenges you!
                </div>
                <div className="challenge-actions">
                  <button className="btn btn-primary btn-sm" onClick={() => mp.acceptChallenge(mp.incomingChallenge.id)}>Accept</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => mp.declineChallenge(mp.incomingChallenge.id)}>Decline</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* MATCHMAKING */}
        {mp.gamePhase === 'matchmaking' && (
          <div className="panel fade-in center-content">
            <div className="spinner" />
            <p className="searching-text">Searching for opponent...</p>
            <button className="btn btn-ghost" onClick={mp.cancelMatchmaking}>Cancel</button>
          </div>
        )}

        {/* AWAITING WAGERS */}
        {mp.gamePhase === 'awaiting_wagers' && (
          <div className="panel fade-in center-content">
            <div className="vs-badge">VS</div>
            <h2 className="opponent-name">{mp.opponentName}</h2>
            <div className="deposit-amount">{mp.depositSats.toLocaleString()} sats</div>

            <div className="wager-status">
              <div className={`wager-pill ${mp.myWagerPaid ? 'paid' : ''}`}>
                You: {mp.myWagerPaid ? 'Paid' : 'Pending'}
              </div>
              <div className={`wager-pill ${mp.opponentWagerPaid ? 'paid' : ''}`}>
                Them: {mp.opponentWagerPaid ? 'Paid' : 'Pending'}
              </div>
            </div>

            {!mp.myWagerPaid && (
              <button className="btn btn-primary btn-lg" onClick={handlePayDeposit} disabled={payingDeposit}>
                {payingDeposit ? 'Sending...' : 'Pay Deposit'}
              </button>
            )}
            {mp.myWagerPaid && !mp.opponentWagerPaid && (
              <div className="waiting-dots">Waiting for opponent<span className="dots" /></div>
            )}
            <button className="btn btn-ghost" onClick={mp.leaveWager}>Leave Match</button>
          </div>
        )}

        {/* PLAYING / GAMEOVER */}
        {(mp.gamePhase === 'playing' || mp.gamePhase === 'gameover') && (
          <div className="panel fade-in">
            {/* Game header */}
            <div className="game-header">
              <div className="player-info left">
                <span className={`mark mark-${mp.myMark.toLowerCase()}`}>{mp.myMark}</span>
                <span className="player-label">You</span>
              </div>
              <div className="game-pot">
                <span className="pot-label">Pot</span>
                <span className="pot-value">{mp.pot.toLocaleString()}</span>
                <span className="pot-unit">sats</span>
              </div>
              <div className="player-info right">
                <span className={`mark mark-${(mp.myMark === 'X' ? 'o' : 'x')}`}>{mp.myMark === 'X' ? 'O' : 'X'}</span>
                <span className="player-label">{mp.opponentName}</span>
              </div>
            </div>

            {/* Turn indicator — always rendered to prevent layout shift */}
            <div className={`turn-indicator ${mp.gamePhase === 'gameover' ? 'their-turn' : isMyTurn ? 'my-turn' : 'their-turn'}`}
              style={mp.gamePhase === 'gameover' ? { visibility: 'hidden' } : undefined}>
              {isMyTurn ? 'Your turn' : `${mp.opponentName}'s turn`}
            </div>

            {/* Board */}
            <div className="board-container">
              <div className="board">
                {mp.board.map((cell, i) => {
                  const canClick = mp.gamePhase === 'playing' && isMyTurn && cell === '';
                  const isWin = mp.winLine?.includes(i);
                  return (
                    <button key={i}
                      className={`cell ${cell ? `cell-${cell.toLowerCase()}` : ''} ${isWin ? 'cell-win' : ''} ${canClick ? 'cell-clickable' : ''}`}
                      onClick={() => handleCellClick(i)}
                      disabled={!canClick}>
                      {cell && <span className="cell-mark">{cell}</span>}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Game over result */}
            {mp.gamePhase === 'gameover' && (
              <div className="gameover-banner fade-in">
                <div className={`gameover-result ${mp.winner === mp.mySlot ? 'win' : mp.winner === 'draw' ? 'draw' : 'loss'}`}>
                  {mp.winner === mp.mySlot ? 'You Win!' : mp.winner === 'draw' ? 'Draw!' : 'You Lost'}
                </div>
                <button className="btn btn-primary btn-lg" onClick={mp.resetGame}>Back to Lobby</button>
              </div>
            )}

            {/* In-game controls */}
            {mp.gamePhase === 'playing' && (
              <div className="game-controls">
                {mp.drawOffered ? (
                  <>
                    <button className="btn btn-primary btn-sm" onClick={mp.acceptDraw}>Accept Draw</button>
                    <button className="btn btn-ghost btn-sm" onClick={mp.declineDraw}>Decline</button>
                  </>
                ) : (
                  <>
                    <button className="btn btn-ghost btn-sm" onClick={mp.offerDraw}>Offer Draw</button>
                    <button className="btn btn-danger btn-sm" onClick={mp.resign}>Resign</button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
