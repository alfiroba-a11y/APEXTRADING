const mongoose = require('mongoose');

/**
 * User
 * IMPORTANT: This platform is a paper-trading demo. There is no `liveBalance`,
 * no real money field, and no admin-forced outcome field on purpose. If you
 * are adapting this for a real product, real balances must come from a
 * licensed payment processor's ledger, never from a field a client (or an
 * admin panel) can edit directly.
 */
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  demoBalance: { type: Number, default: 10000 },
  isFrozen: { type: Boolean, default: false }, // account-level suspension only (e.g. abuse), not a trade-rigging tool
  createdAt: { type: Date, default: Date.now }
});

/**
 * Trade
 * Outcome is ALWAYS computed from entryPrice vs closePrice, which come from
 * the server-side price engine (server/priceEngine.js). There is no
 * "forceOutcome" field anywhere in this schema, and nothing in the resolver
 * reads a value that an admin or client could set to predetermine a result.
 */
const tradeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  symbol: { type: String, required: true },
  direction: { type: String, enum: ['HIGHER', 'LOWER'], required: true },
  stake: { type: Number, required: true },
  payoutPct: { type: Number, required: true }, // e.g. 0.95 = 95% payout on win
  entryPrice: { type: Number, required: true },
  closePrice: { type: Number, default: null },
  durationSec: { type: Number, required: true },
  openedAt: { type: Date, default: Date.now },
  resolvesAt: { type: Date, required: true },
  status: { type: String, enum: ['OPEN', 'WON', 'LOST'], default: 'OPEN', index: true },
  pnl: { type: Number, default: 0 }
});

const User = mongoose.model('User', userSchema);
const Trade = mongoose.model('Trade', tradeSchema);

module.exports = { User, Trade };
