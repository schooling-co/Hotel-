const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const Admin = require('./Admin');
const { ok, fail, serverError } = require('./respond');
const { EMAIL_RE } = require('./validate');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts. Try again later.' },
});

// Fixed hash so response time doesn't reveal whether the email exists
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

router.post('/login', limiter, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!EMAIL_RE.test(email) || !password) return fail(res, 400, 'Valid email and password are required');

    const admin = await Admin.findOne({ email });
    const valid = await bcrypt.compare(password, admin ? admin.passwordHash : DUMMY_HASH);
    if (!admin || !valid) return fail(res, 401, 'Invalid credentials');

    const token = jwt.sign({ id: admin._id, email: admin.email }, process.env.JWT_SECRET, { expiresIn: '1d' });
    return ok(res, { token, email: admin.email });
  } catch (e) {
    return serverError(res, e);
  }
});

module.exports = router;
