require('dotenv').config();

// ─── Validate required environment variables on startup ─────────────
const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET', 'ADMIN_USER', 'ADMIN_PASS'];
for (const v of REQUIRED_ENV) {
  if (!process.env[v]) {
    console.error(`FATAL: Missing required environment variable: ${v}`);
    process.exit(1);
  }
}
if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET must be at least 32 characters');
  process.exit(1);
}

const express = require('express');
const whatsappRouter = require('./whatsapp');
const b2bRouter = require('./b2b-api');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Security middleware ────────────────────────────────────────────

// Request size limits — prevent large payload attacks
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: false }));

// Remove X-Powered-By header
app.disable('x-powered-by');

// Security headers for all responses
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ─── Simple rate limiter for API endpoints ──────────────────────────
const rateLimits = new Map();
const RATE_LIMIT = 30; // requests per minute per IP
const RATE_WINDOW = 60 * 1000;

app.use((req, res, next) => {
  // Only rate limit webhook and API endpoints
  if (!req.path.startsWith('/webhook/') && !req.path.startsWith('/api/')) return next();

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
  const now = Date.now();
  const record = rateLimits.get(ip);

  if (!record || now > record.resetAt) {
    rateLimits.set(ip, { count: 1, resetAt: now + RATE_WINDOW });
    return next();
  }

  record.count++;
  if (record.count > RATE_LIMIT) {
    console.warn(`[rate-limit] Blocked ${ip} — ${record.count} requests in ${RATE_WINDOW / 1000}s`);
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  next();
});

// Cleanup rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimits) {
    if (now > record.resetAt) rateLimits.delete(ip);
  }
}, 5 * 60 * 1000);

// ─── Routes ─────────────────────────────────────────────────────────
app.use(whatsappRouter);
app.use(b2bRouter);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'surepath' });
});

app.listen(PORT, () => {
  console.log(`Surepath server running on port ${PORT}`);
});

module.exports = app;
