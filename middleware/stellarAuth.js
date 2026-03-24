const jwt = require('jsonwebtoken');
const StellarAuthService = require('../services/stellarAuthService');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const stellarService = new StellarAuthService();

// Store active sessions (in production, use Redis)
const activeSessions = new Map();

/**
 * Generate JWT token for Stellar authentication
 * @param {string} publicKey - Stellar public key
 * @param {string} tier - User tier
 * @returns {string} JWT token
 */
const generateStellarToken = (publicKey, tier = 'bronze') => {
  const token = jwt.sign(
    { 
      publicKey: publicKey.toLowerCase(),
      tier,
      type: 'stellar',
      iat: Math.floor(Date.now() / 1000),
      sessionId: generateSessionId()
    },
    JWT_SECRET,
    { expiresIn: '24h' }
  );

  // Store session
  activeSessions.set(publicKey.toLowerCase(), {
    token,
    tier,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    sessionId: jwt.decode(token).sessionId
  });

  return token;
};

/**
 * Generate unique session ID
 */
const generateSessionId = () => {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
};

/**
 * Verify Stellar JWT middleware
 */
const authenticateStellarToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ 
      success: false, 
      error: 'Access token required' 
    });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ 
        success: false, 
        error: 'Invalid or expired token' 
      });
    }

    // Verify it's a Stellar token
    if (decoded.type !== 'stellar') {
      return res.status(403).json({ 
        success: false, 
        error: 'Invalid token type' 
      });
    }

    // Check if session is still active
    const session = activeSessions.get(decoded.publicKey);
    if (!session || session.sessionId !== decoded.sessionId) {
      return res.status(403).json({ 
        success: false, 
        error: 'Session invalid or expired' 
      });
    }

    // Update last activity
    session.lastActivity = Date.now();

    req.user = {
      address: decoded.publicKey,
      publicKey: decoded.publicKey,
      tier: decoded.tier,
      type: 'stellar',
      sessionId: decoded.sessionId
    };
    
    next();
  });
};

/**
 * Handle wallet switching - invalidate old session and create new one
 */
const switchWallet = async (oldPublicKey, newPublicKey) => {
  try {
    // Invalidate old session
    const oldSession = activeSessions.get(oldPublicKey.toLowerCase());
    if (oldSession) {
      activeSessions.delete(oldPublicKey.toLowerCase());
    }

    // Verify new account status
    await stellarService.verifyAccountStatus(newPublicKey);

    return true;
  } catch (error) {
    console.error('Wallet switching error:', error);
    throw error;
  }
};

/**
 * Invalidate session for a specific public key
 */
const invalidateSession = (publicKey) => {
  activeSessions.delete(publicKey.toLowerCase());
};

/**
 * Check and invalidate sessions for inactive/merged accounts
 */
const validateAccountSessions = async () => {
  const invalidAccounts = [];

  for (const [publicKey, session] of activeSessions.entries()) {
    try {
      await stellarService.verifyAccountStatus(publicKey);
    } catch (error) {
      // Account is inactive or merged, invalidate session
      invalidAccounts.push(publicKey);
      activeSessions.delete(publicKey);
    }
  }

  return invalidAccounts;
};

/**
 * Get session information
 */
const getSessionInfo = (publicKey) => {
  const session = activeSessions.get(publicKey.toLowerCase());
  if (!session) {
    return null;
  }

  return {
    publicKey: publicKey.toLowerCase(),
    tier: session.tier,
    createdAt: session.createdAt,
    lastActivity: session.lastActivity,
    sessionId: session.sessionId
  };
};

/**
 * Clean up expired sessions (older than 24 hours)
 */
const cleanupExpiredSessions = () => {
  const now = Date.now();
  const expiredThreshold = 24 * 60 * 60 * 1000; // 24 hours

  for (const [publicKey, session] of activeSessions.entries()) {
    if (now - session.createdAt > expiredThreshold) {
      activeSessions.delete(publicKey);
    }
  }
};

/**
 * Set HttpOnly cookie with JWT token
 */
const setAuthCookie = (res, token) => {
  const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    path: '/'
  };

  res.cookie('stellar_auth_token', token, cookieOptions);
};

/**
 * Clear auth cookie
 */
const clearAuthCookie = (res) => {
  res.cookie('stellar_auth_token', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    expires: new Date(0),
    path: '/'
  });
};

module.exports = {
  generateStellarToken,
  authenticateStellarToken,
  switchWallet,
  invalidateSession,
  validateAccountSessions,
  getSessionInfo,
  cleanupExpiredSessions,
  setAuthCookie,
  clearAuthCookie,
  activeSessions
};
