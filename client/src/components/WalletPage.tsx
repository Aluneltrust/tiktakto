// ============================================================================
// WALLET PAGE — Balance, Send, Receive, History for TikTakTo
// ============================================================================

import { useState, useEffect, useCallback } from 'react';
import { PrivateKey } from '@bsv/sdk';
import { BSV_NETWORK } from '../constants';
import { decryptStoredWif } from '../services/pinCrypto';
import { BsvWalletService } from '../services/BsvWalletService';
import '../styles/WalletStyles.css';

const wocNet = BSV_NETWORK === 'main' ? 'main' : 'test';
const wocBase = `https://api.whatsonchain.com/v1/bsv/${wocNet}`;
const networkLabel = BSV_NETWORK === 'main' ? 'mainnet' : 'testnet';

interface WalletPageProps {
  onBack: () => void;
  walletAddress: string;
  balance: number;
  bsvPrice: number;
  walletSource: 'local' | 'yours' | 'embedded';
  onRefreshBalance: () => void;
}

interface HistoryTx {
  txid: string;
  time: number;
  balanceChange: number;
}

export default function WalletPage({
  onBack,
  walletAddress,
  balance,
  bsvPrice,
  walletSource,
  onRefreshBalance,
}: WalletPageProps) {
  const isYours = walletSource === 'yours';
  const tabs = isYours
    ? (['receive', 'history'] as const)
    : (['receive', 'send', 'history'] as const);

  type TabKey = (typeof tabs)[number];

  const [activeTab, setActiveTab] = useState<TabKey>('receive');
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState<'info' | 'success' | 'error'>('info');
  const [showQr, setShowQr] = useState(false);

  // Send state
  const [sendAddress, setSendAddress] = useState('');
  const [sendAmount, setSendAmount] = useState('');
  const [sendPin, setSendPin] = useState('');
  const [showPinInput, setShowPinInput] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [sendPreview, setSendPreview] = useState(false);

  // History state
  const [history, setHistory] = useState<HistoryTx[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Export state
  const [exportPin, setExportPin] = useState('');
  const [showExportPin, setShowExportPin] = useState(false);

  const showMsg = (msg: string, type: 'info' | 'success' | 'error') => {
    setMessage(msg);
    setMessageType(type);
    setTimeout(() => setMessage(''), 5000);
  };

  const copyAddress = () => {
    navigator.clipboard.writeText(walletAddress);
    showMsg('Address copied to clipboard', 'success');
  };

  const bsvAmount = (balance / 1e8).toFixed(8);
  const usdAmount = ((balance / 1e8) * bsvPrice).toFixed(2);

  // ---- History ----
  const fetchHistory = useCallback(async () => {
    if (!walletAddress) return;
    setHistoryLoading(true);
    try {
      const res = await fetch(`${wocBase}/address/${walletAddress}/history`);
      if (!res.ok) throw new Error('Failed to fetch history');
      const data: { tx_hash: string; height: number }[] = await res.json();
      const recent = data.slice(0, 20);

      const txDetails: HistoryTx[] = [];
      for (const item of recent) {
        try {
          const txRes = await fetch(`${wocBase}/tx/hash/${item.tx_hash}`);
          if (!txRes.ok) continue;
          const tx = await txRes.json();

          let incoming = 0;
          let outgoing = 0;
          for (const vout of tx.vout || []) {
            const addr = vout?.scriptPubKey?.addresses?.[0];
            if (addr === walletAddress) incoming += Math.round((vout.value || 0) * 1e8);
          }
          for (const vin of tx.vin || []) {
            const addr = vin?.prevout?.scriptPubKey?.addresses?.[0];
            if (addr === walletAddress) outgoing += Math.round((vin?.prevout?.value || 0) * 1e8);
          }

          txDetails.push({
            txid: item.tx_hash,
            time: tx.time || tx.blocktime || 0,
            balanceChange: incoming - outgoing,
          });
        } catch {
          // skip failed tx lookups
        }
      }

      setHistory(txDetails);
    } catch {
      showMsg('Failed to load history', 'error');
    }
    setHistoryLoading(false);
  }, [walletAddress]);

  useEffect(() => {
    if (activeTab === 'history' && history.length === 0) {
      fetchHistory();
    }
  }, [activeTab, fetchHistory, history.length]);

  // ---- Send ----
  const sendAmountNum = parseInt(sendAmount) || 0;
  const sendUsd = ((sendAmountNum / 1e8) * bsvPrice).toFixed(4);

  const handleSendClick = () => {
    if (!sendAddress || !sendAmount) {
      showMsg('Enter address and amount', 'error');
      return;
    }
    if (sendAmountNum < 546) {
      showMsg('Minimum 546 sats', 'error');
      return;
    }
    if (sendAmountNum > balance) {
      showMsg('Insufficient balance', 'error');
      return;
    }
    setSendPreview(true);
  };

  const handleConfirmSend = () => {
    setShowPinInput(true);
  };

  const handleSendWithPin = async () => {
    if (!sendPin || sendPin.length < 4) {
      showMsg('Enter your PIN (4+ digits)', 'error');
      return;
    }
    setIsSending(true);
    try {
      const wif = await decryptStoredWif(sendPin);
      const svc = new BsvWalletService();
      svc.connect(wif);
      const result = await svc.sendGamePayment(sendAddress, sendAmountNum, 'wallet', 'send');
      if (result.success && result.rawTxHex) {
        // Broadcast via WoC
        const broadcastRes = await fetch(`${wocBase}/tx/raw`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ txhex: result.rawTxHex }),
        });
        if (broadcastRes.ok) {
          showMsg('Transaction sent successfully', 'success');
          setSendAddress('');
          setSendAmount('');
          setSendPin('');
          setShowPinInput(false);
          setSendPreview(false);
          setTimeout(onRefreshBalance, 2000);
        } else {
          const errText = await broadcastRes.text();
          showMsg(`Broadcast failed: ${errText}`, 'error');
        }
      } else {
        showMsg(`Send failed: ${result.error}`, 'error');
      }
    } catch (err: any) {
      showMsg(err.message || 'Send failed', 'error');
    }
    setIsSending(false);
  };

  // ---- Export WIF ----
  const handleExportWif = async () => {
    if (!exportPin || exportPin.length < 4) {
      showMsg('Enter your PIN to export', 'error');
      return;
    }
    try {
      const wif = await decryptStoredWif(exportPin);
      // Show in a prompt for user to copy
      const confirmed = window.confirm(
        'Your WIF private key will be shown.\nNEVER share it with anyone.\n\nClick OK to reveal.',
      );
      if (confirmed) {
        window.prompt('Your WIF private key (copy it now):', wif);
      }
      setExportPin('');
      setShowExportPin(false);
    } catch (err: any) {
      showMsg(err.message || 'Wrong PIN', 'error');
    }
  };

  const formatTime = (ts: number) => {
    if (!ts) return 'Pending';
    return new Date(ts * 1000).toLocaleString();
  };

  return (
    <div className="wallet-page">
      <div className="wallet-container">
        {/* Header */}
        <div className="wallet-header">
          <button className="wallet-back-btn" onClick={onBack}>
            <span className="back-arrow">&larr;</span> Back
          </button>
          <h1 className="wallet-title">Wallet</h1>
          <div className="wallet-source-badge">
            {walletSource === 'yours' ? 'Yours' : walletSource === 'embedded' ? 'Embedded' : 'Local'}
          </div>
        </div>

        {/* Balance card */}
        <div className="wallet-balance-card">
          <div className="balance-top-row">
            <span className="balance-label">Total Balance</span>
            <button className="refresh-btn" onClick={onRefreshBalance} title="Refresh balance">
              &#x21bb;
            </button>
          </div>
          <div className="balance-sats">{balance.toLocaleString()} <span className="balance-unit">sats</span></div>
          <div className="balance-secondary">
            <span className="balance-bsv">{bsvAmount} BSV</span>
            <span className="balance-divider">|</span>
            <span className="balance-usd">${usdAmount} USD</span>
          </div>
        </div>

        {/* Message toast */}
        {message && (
          <div className={`wallet-msg wallet-msg-${messageType}`}>{message}</div>
        )}

        {/* Tabs */}
        <div className="wallet-tabs">
          {tabs.map((tab) => (
            <button
              key={tab}
              className={`wallet-tab ${activeTab === tab ? 'wallet-tab-active' : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="wallet-tab-content">
          {/* ---- RECEIVE ---- */}
          {activeTab === 'receive' && (
            <div className="wallet-section fade-in">
              <div className="receive-label">Your BSV Address</div>
              <div className="receive-address-box" onClick={copyAddress}>
                <span className="receive-address-text">{walletAddress}</span>
                <span className="receive-copy-icon">COPY</span>
              </div>
              <p className="receive-hint">Click to copy. Send BSV to this address to fund your wallet.</p>

              <button className="wallet-toggle-btn" onClick={() => setShowQr(!showQr)}>
                {showQr ? 'Hide QR Code' : 'Show QR Code'}
              </button>
              {showQr && (
                <div className="qr-section fade-in">
                  <img
                    src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${walletAddress}&bgcolor=12121a&color=e8e8f0`}
                    alt="Wallet QR Code"
                    className="qr-image"
                  />
                </div>
              )}

              {!isYours && (
                <div className="export-section">
                  {!showExportPin ? (
                    <button
                      className="wallet-action-btn wallet-action-secondary"
                      onClick={() => setShowExportPin(true)}
                    >
                      Export Private Key (WIF)
                    </button>
                  ) : (
                    <div className="export-pin-row">
                      <input
                        className="wallet-input wallet-input-sm"
                        type="password"
                        placeholder="Enter PIN"
                        value={exportPin}
                        onChange={(e) => setExportPin(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleExportWif()}
                      />
                      <button className="wallet-action-btn wallet-action-accent" onClick={handleExportWif}>
                        Reveal
                      </button>
                      <button
                        className="wallet-action-btn wallet-action-ghost"
                        onClick={() => { setShowExportPin(false); setExportPin(''); }}
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                  <p className="export-warning">Never share your private key. Store it securely.</p>
                </div>
              )}
            </div>
          )}

          {/* ---- SEND ---- */}
          {activeTab === 'send' && !isYours && (
            <div className="wallet-section fade-in">
              {!sendPreview ? (
                <>
                  <div className="form-group">
                    <label className="form-label">Recipient Address</label>
                    <input
                      className="wallet-input"
                      type="text"
                      placeholder="1ABC... or 3XYZ..."
                      value={sendAddress}
                      onChange={(e) => setSendAddress(e.target.value)}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Amount (satoshis)</label>
                    <input
                      className="wallet-input"
                      type="number"
                      placeholder="10000"
                      value={sendAmount}
                      onChange={(e) => setSendAmount(e.target.value)}
                      min="546"
                    />
                    <div className="amount-helpers">
                      {[
                        { label: '10k', value: 10000 },
                        { label: '100k', value: 100000 },
                        { label: '500k', value: 500000 },
                        { label: 'Max', value: Math.max(0, balance - 400) },
                      ].map((h) => (
                        <button
                          key={h.label}
                          className="helper-btn"
                          onClick={() => setSendAmount(String(h.value))}
                        >
                          {h.label}
                        </button>
                      ))}
                    </div>
                    {sendAmountNum > 0 && (
                      <div className="send-usd-preview">~${sendUsd} USD</div>
                    )}
                  </div>
                  <button
                    className="wallet-action-btn wallet-action-primary"
                    onClick={handleSendClick}
                    disabled={!sendAddress || sendAmountNum < 546}
                  >
                    Preview Send
                  </button>
                </>
              ) : !showPinInput ? (
                <div className="send-preview-card">
                  <h3 className="preview-title">Confirm Transaction</h3>
                  <div className="preview-row">
                    <span className="preview-label">To</span>
                    <span className="preview-value preview-addr">{sendAddress.slice(0, 12)}...{sendAddress.slice(-8)}</span>
                  </div>
                  <div className="preview-row">
                    <span className="preview-label">Amount</span>
                    <span className="preview-value">{sendAmountNum.toLocaleString()} sats</span>
                  </div>
                  <div className="preview-row">
                    <span className="preview-label">USD</span>
                    <span className="preview-value">~${sendUsd}</span>
                  </div>
                  <div className="preview-actions">
                    <button className="wallet-action-btn wallet-action-primary" onClick={handleConfirmSend}>
                      Confirm
                    </button>
                    <button
                      className="wallet-action-btn wallet-action-ghost"
                      onClick={() => setSendPreview(false)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="send-pin-section">
                  <h3 className="preview-title">Enter PIN to Sign</h3>
                  <input
                    className="wallet-input"
                    type="password"
                    placeholder="Your PIN"
                    value={sendPin}
                    onChange={(e) => setSendPin(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSendWithPin()}
                    autoFocus
                  />
                  <div className="preview-actions">
                    <button
                      className="wallet-action-btn wallet-action-primary"
                      onClick={handleSendWithPin}
                      disabled={isSending}
                    >
                      {isSending ? 'Sending...' : 'Send BSV'}
                    </button>
                    <button
                      className="wallet-action-btn wallet-action-ghost"
                      onClick={() => {
                        setShowPinInput(false);
                        setSendPreview(false);
                        setSendPin('');
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ---- HISTORY ---- */}
          {activeTab === 'history' && (
            <div className="wallet-section fade-in">
              {historyLoading ? (
                <div className="history-loading">
                  <div className="wallet-spinner" />
                  <span>Loading transactions...</span>
                </div>
              ) : history.length > 0 ? (
                <div className="history-list">
                  {history.map((tx) => (
                    <a
                      key={tx.txid}
                      className="history-item"
                      href={`https://whatsonchain.com/tx/${tx.txid}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <div className="history-left">
                        <span className={`history-direction ${tx.balanceChange >= 0 ? 'history-in' : 'history-out'}`}>
                          {tx.balanceChange >= 0 ? 'IN' : 'OUT'}
                        </span>
                        <span className="history-txid">{tx.txid.slice(0, 10)}...{tx.txid.slice(-6)}</span>
                      </div>
                      <div className="history-right">
                        <span className={`history-amount ${tx.balanceChange >= 0 ? 'history-positive' : 'history-negative'}`}>
                          {tx.balanceChange >= 0 ? '+' : ''}{tx.balanceChange.toLocaleString()} sats
                        </span>
                        <span className="history-time">{formatTime(tx.time)}</span>
                      </div>
                    </a>
                  ))}
                </div>
              ) : (
                <div className="history-empty">
                  <p>No transactions found</p>
                  <a
                    href={`https://whatsonchain.com/address/${walletAddress}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="history-link"
                  >
                    View on WhatsOnChain
                  </a>
                </div>
              )}
              <button className="wallet-action-btn wallet-action-ghost history-refresh" onClick={fetchHistory}>
                Refresh History
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="wallet-footer">
          <span className={`network-badge ${BSV_NETWORK === 'main' ? 'network-main' : 'network-test'}`}>
            {BSV_NETWORK === 'main' ? 'Mainnet' : 'Testnet'}
          </span>
          <span className="wallet-footer-price">BSV: ${bsvPrice.toFixed(2)}</span>
        </div>
      </div>
    </div>
  );
}
