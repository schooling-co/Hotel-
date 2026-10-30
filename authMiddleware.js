const jwt = require('jsonwebtoken');
const { fail } = require('./respond');

module.exports = function adminAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return fail(res, 401, 'Authentication required');
    req.admin = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return fail(res, 401, 'Invalid or expired token');
  }
};
