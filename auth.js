const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME_IN_PRODUCTION_this_is_a_demo_secret';

// Admin credentials come from environment variables so they aren't hardcoded
// in source. Sensible demo fallbacks are provided ONLY so this runs
// out-of-the-box; set ADMIN_USER / ADMIN_PASS before deploying anywhere real.
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'change-this-password';

function signUserToken(user) {
  return jwt.sign({ uid: user._id.toString(), email: user.email }, JWT_SECRET, { expiresIn: '7d' });
}

function requireUser(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, message: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.uid;
    next();
  } catch (e) {
    return res.status(401).json({ success: false, message: 'Invalid or expired session' });
  }
}

// Admin panel is view + basic account maintenance ONLY (see server/index.js).
// It intentionally has no capability to set a trade outcome.
function requireAdmin(req, res, next) {
  const { adminuser, adminpass } = req.headers;
  if (adminuser === ADMIN_USER && adminpass === ADMIN_PASS) return next();
  return res.status(403).json({ success: false, message: 'Unauthorized' });
}

module.exports = { signUserToken, requireUser, requireAdmin, ADMIN_USER, ADMIN_PASS };
