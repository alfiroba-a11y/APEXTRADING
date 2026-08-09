const express = require('express');
const http = require('http');
const path = require('path');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');

const { User, Trade } = require('./models');
const { signUserToken, requireUser, requireAdmin } = require('./auth');
const priceEngine = require('./priceEngine');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));

// -------------------------------------------------------------
// AUTH: real accounts, demo money only
// -------------------------------------------------------------

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password || password.length < 8) {
      return res.status(400).json({ success: false, message: 'Email and an 8+ character password are required.' });
    }
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(400).json({ success: false, message: 'An account with that email already exists.' });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({ email: email.toLowerCase(), passwordHash });
    const token = signUserToken(user);
    res.json({ success: true, token, user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Registration failed.', error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const user = await User.findOne({ email: (email || '').toLowerCase() });
    if (!user) return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    if (user.isFrozen) return res.status(403).json({ success: false, message: 'This account has been suspended.' });

    const ok = await bcrypt.compare(password || '', user.passwordHash);
    if (!ok) return res.status(401).json({ success: false, message: 'Invalid email or password.' });

    const token = signUserToken(user);
    res.json({ success: true, token, user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Login failed.', error: err.message });
  }
});

app.get('/api/user/me', requireUser, async (req, res) => {
  const user = await User.findById(req.userId);
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  res.json({ success: true, user: publicUser(user) });
});

function publicUser(user) {
  return { id: user._id, email: user.email, demoBalance: user.demoBalance };
}

// -------------------------------------------------------------
// MARKET DATA
// -------------------------------------------------------------

app.get('/api/market/symbols', (req, res) => {
  res.json({ success: true, symbols: priceEngine.listSymbols() });
});

// -------------------------------------------------------------
// TRADING (demo balance only — fully server-authoritative)
// -------------------------------------------------------------

const PAYOUT_PCT = 0.95;
const MIN_STAKE = 1;
const ALLOWED_DURATIONS = [5, 10, 15, 30, 60];

app.post('/api/trade/open', requireUser, async (req, res) => {
  try {
    const { symbol, direction, stake, durationSec } = req.body || {};
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    if (user.isFrozen) return res.status(403).json({ success: false, message: 'This account has been suspended.' });

    const price = priceEngine.getPrice(symbol);
    if (price === null) return res.status(400).json({ success: false, message: 'Unknown symbol.' });
    if (!['HIGHER', 'LOWER'].includes(direction)) return res.status(400).json({ success: false, message: 'Invalid direction.' });

    const stakeNum = Number(stake);
    if (!Number.isFinite(stakeNum) || stakeNum < MIN_STAKE) {
      return res.status(400).json({ success: false, message: `Minimum stake is $${MIN_STAKE}.` });
    }
    if (stakeNum > user.demoBalance) {
      return res.status(400).json({ success: false, message: 'Insufficient demo balance.' });
    }
    const duration = ALLOWED_DURATIONS.includes(Number(durationSec)) ? Number(durationSec) : 5;

    user.demoBalance -= stakeNum;
    await user.save();

    const trade = await Trade.create({
      userId: user._id,
      symbol,
      direction,
      stake: stakeNum,
      payoutPct: PAYOUT_PCT,
      entryPrice: price,
      durationSec: duration,
      resolvesAt: new Date(Date.now() + duration * 1000)
    });

    io.to(user._id.toString()).emit('BALANCE_UPDATE', { demoBalance: user.demoBalance });
    res.json({ success: true, trade, demoBalance: user.demoBalance });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Could not open trade.', error: err.message });
  }
});

app.get('/api/trade/open', requireUser, async (req, res) => {
  const trades = await Trade.find({ userId: req.userId, status: 'OPEN' }).sort({ openedAt: -1 });
  res.json({ success: true, trades });
});

app.get('/api/trade/history', requireUser, async (req, res) => {
  const trades = await Trade.find({ userId: req.userId, status: { $ne: 'OPEN' } }).sort({ openedAt: -1 }).limit(100);
  res.json({ success: true, trades });
});

// -------------------------------------------------------------
// TRADE RESOLUTION — the only place a trade's result is decided.
// Result = real entry price vs real price at expiry. Nothing here reads an
// admin flag, a "forced outcome," or anything set by a human. This loop is
// what the old code's `adminWinRateOverride` used to short-circuit.
// -------------------------------------------------------------

async function resolveDueTrades() {
  const due = await Trade.find({ status: 'OPEN', resolvesAt: { $lte: new Date() } });
  for (const trade of due) {
    const closePrice = priceEngine.getPrice(trade.symbol);
    const won = trade.direction === 'HIGHER' ? closePrice >= trade.entryPrice : closePrice <= trade.entryPrice;

    trade.closePrice = closePrice;
    trade.status = won ? 'WON' : 'LOST';
    trade.pnl = won ? parseFloat((trade.stake * trade.payoutPct).toFixed(2)) : -trade.stake;
    await trade.save();

    if (won) {
      const user = await User.findById(trade.userId);
      if (user) {
        user.demoBalance += trade.stake + trade.pnl;
        await user.save();
        io.to(user._id.toString()).emit('BALANCE_UPDATE', { demoBalance: user.demoBalance });
      }
    }
    io.to(trade.userId.toString()).emit('TRADE_RESOLVED', trade);
  }
}

// -------------------------------------------------------------
// ADMIN — view + account maintenance only. No outcome control.
// -------------------------------------------------------------

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const users = await User.find().select('-passwordHash').sort({ createdAt: -1 });
  res.json({ success: true, users });
});

app.get('/api/admin/trades', requireAdmin, async (req, res) => {
  const trades = await Trade.find().sort({ openedAt: -1 }).limit(200);
  res.json({ success: true, trades });
});

// The only balance-related admin action is resetting a demo account back to
// the starting demo balance — useful for support ("my demo ran out"), and
// explicitly NOT a way to set an arbitrary number or pick a winner.
app.post('/api/admin/user/reset-demo-balance', requireAdmin, async (req, res) => {
  const { userId } = req.body || {};
  const user = await User.findByIdAndUpdate(userId, { demoBalance: 10000 }, { new: true }).select('-passwordHash');
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  io.to(user._id.toString()).emit('BALANCE_UPDATE', { demoBalance: user.demoBalance });
  res.json({ success: true, user });
});

app.post('/api/admin/user/set-frozen', requireAdmin, async (req, res) => {
  const { userId, isFrozen } = req.body || {};
  const user = await User.findByIdAndUpdate(userId, { isFrozen: !!isFrozen }, { new: true }).select('-passwordHash');
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  res.json({ success: true, user });
});

// -------------------------------------------------------------
// REALTIME PRICE BROADCAST + TRADE RESOLUTION LOOP
// -------------------------------------------------------------

io.on('connection', (socket) => {
  socket.on('SUBSCRIBE_USER', (userId) => {
    if (userId) socket.join(userId);
  });
  socket.emit('SYMBOLS', priceEngine.listSymbols());
});

setInterval(() => {
  const updates = priceEngine.tickAll();
  io.emit('PRICE_TICK', updates);
  resolveDueTrades().catch(err => console.error('Trade resolution error:', err.message));
}, 1000);

// Fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

const PORT = process.env.PORT || 10000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/smarttrading_demo';

mongoose.connect(MONGO_URI)
  .then(() => console.log('Connected to MongoDB.'))
  .catch((e) => console.log('MongoDB connection failed — set MONGO_URI. Details:', e.message));

server.listen(PORT, () => console.log(`Smarttrading DEMO server running on port ${PORT} (paper trading only — no real money)`));
