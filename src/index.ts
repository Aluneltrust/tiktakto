// ============================================================================
// BSV TIKTAKTO SERVER — Entry Point
// ============================================================================

import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server } from 'socket.io';
import { initDatabase } from './DB/Database';
import { escrowManager, priceService } from './wallet/BsvService';
import apiRouter from './API/Api';
import { setupSocketHandlers } from './socket/SocketHandler';

const PORT = parseInt(process.env.PORT || '3003');
const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:5173').split(',').map(s => s.trim());

const app = express();
app.use(cors({ origin: CORS_ORIGINS, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(apiRouter);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CORS_ORIGINS, methods: ['GET', 'POST'], credentials: true },
  pingInterval: 25_000,
  pingTimeout: 60_000,
});

async function start() {
  const escrowOk = escrowManager.init();

  try { await initDatabase(); }
  catch (err) { console.error('DB init failed:', err); }

  const bsvPrice = await priceService.getPrice();
  setupSocketHandlers(io);

  server.listen(PORT, '0.0.0.0', () => {
    console.log('============================================');
    console.log('  BSV TIKTAKTO SERVER');
    console.log('============================================');
    console.log(`  Port:     ${PORT}`);
    console.log(`  CORS:     ${CORS_ORIGINS.join(', ')}`);
    console.log(`  Network:  ${process.env.BSV_NETWORK || 'main'}`);
    console.log(`  Escrow:   ${escrowOk ? 'HD per-game' : 'NOT SET'}`);
    console.log(`  Final:    ${process.env.FINAL_WALLET_ADDRESS || 'NOT SET'}`);
    console.log(`  BSV:      $${bsvPrice.toFixed(2)}`);
    console.log(`  DB:       ${process.env.DATABASE_URL ? 'PostgreSQL' : 'NOT SET'}`);
    console.log('============================================');
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
