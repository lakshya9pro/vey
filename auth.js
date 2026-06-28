const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_file_server_key_102938';
const ADMIN_PASSWORD_HASH = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin', 10);

const authenticateToken = (req, res, next) => {
  // Allow connections from the Android app without auth for sync, transfer, and status
  const url = req.originalUrl || req.url;
  if (url.startsWith('/api/files') || url.startsWith('/api/device_status_update') || url.startsWith('/api/transfer')) {
    return next();
  }

  const authHeader = req.headers['authorization'] || req.headers['x-access-token'];
  let token = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (authHeader) {
    token = authHeader;
  } else if (req.cookies && req.cookies.token) {
    token = req.cookies.token;
  } else if (req.query && req.query.token) {
    token = req.query.token; // Useful for download streams / image tags
  }

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    const verified = jwt.verify(token, JWT_SECRET);
    req.user = verified;
    next();
  } catch (err) {
    res.status(403).json({ error: 'Invalid token.' });
  }
};

const login = (password) => {
  // Compare provided password with our admin password
  const isMatch = bcrypt.compareSync(password, ADMIN_PASSWORD_HASH);
  if (isMatch) {
    // Generate JWT token valid for 7 days
    const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
    return token;
  }
  return null;
};

module.exports = {
  authenticateToken,
  login
};
