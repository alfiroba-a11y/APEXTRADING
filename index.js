/**
 * Synthetic price engine.
 *
 * Every symbol follows an independent mean-reverting random walk on the
 * server. There is deliberately no "bias" or "admin override" input to this
 * module — the whole point of the earlier version's admin panel was that it
 * could secretly tilt these numbers against users. Trade results are always
 * computed by comparing the real entryPrice to the real price at expiry, both
 * read from here.
 */

const SYMBOLS = {
  'Vol 50 (1s)':        { price: 680.12,   vol: 0.35, category: 'SYNTHETIC' },
  'Vol 75 (1s)':        { price: 3410.85,  vol: 0.6,  category: 'SYNTHETIC' },
  'Vol 100 (1s)':       { price: 12540.90, vol: 1.1,  category: 'SYNTHETIC' },
  'BTC/USD':            { price: 65048.26, vol: 0.05, category: 'CRYPTO' },
  'ETH/USD':            { price: 3450.50,  vol: 0.06, category: 'CRYPTO' },
  'EUR/USD':            { price: 1.08500,  vol: 0.0004, category: 'FOREX' },
  'GBP/USD':            { price: 1.29200,  vol: 0.0004, category: 'FOREX' },
  'Gold (XAU/USD)':     { price: 2380.40,  vol: 0.03, category: 'COMMODITY' }
};

// Internal mutable state
const state = {};
for (const [symbol, cfg] of Object.entries(SYMBOLS)) {
  state[symbol] = {
    price: cfg.price,
    base: cfg.price,
    vol: cfg.vol,
    category: cfg.category,
    digitHistory: new Array(10).fill(0)
  };
}

function stepPrice(s) {
  // Mean-reverting random walk: pulls gently back toward `base` so prices
  // don't drift to absurd values over a long-running demo session, but the
  // step itself is symmetric random noise - nobody's thumb is on the scale.
  const meanReversion = (s.base - s.price) * 0.001;
  const noise = (Math.random() - 0.5) * s.vol * (s.price * 0.001 + 1);
  s.price = Math.max(0.0001, s.price + meanReversion + noise);
  return s.price;
}

function tickAll() {
  const updates = {};
  for (const [symbol, s] of Object.entries(state)) {
    const price = stepPrice(s);
    const decimals = price < 10 ? 5 : 2;
    const rounded = parseFloat(price.toFixed(decimals));
    s.price = rounded;

    const lastDigit = parseInt(rounded.toFixed(decimals).replace('.', '').slice(-1), 10);
    s.digitHistory[lastDigit]++;

    updates[symbol] = { price: rounded, category: s.category, lastDigit };
  }
  return updates;
}

function getPrice(symbol) {
  const s = state[symbol];
  return s ? s.price : null;
}

function getDigitStats(symbol) {
  const s = state[symbol];
  if (!s) return null;
  const total = s.digitHistory.reduce((a, b) => a + b, 0) || 1;
  return s.digitHistory.map(count => parseFloat(((count / total) * 100).toFixed(1)));
}

function listSymbols() {
  return Object.entries(state).map(([symbol, s]) => ({
    symbol,
    price: s.price,
    category: s.category
  }));
}

module.exports = { tickAll, getPrice, getDigitStats, listSymbols, SYMBOLS };
