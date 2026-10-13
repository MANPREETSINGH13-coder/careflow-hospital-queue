'use strict';

require('dotenv').config();
const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const { rateLimit } = require('express-rate-limit');

const app = express();
const port = Number(process.env.DATA_DETECTIVE_PORT || 3001);
const production = process.env.NODE_ENV === 'production';
const secret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, referrerPolicy: { policy: 'no-referrer' } }));
app.use(express.json({ limit: '2.1mb', strict: true }));
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false }));
app.use((req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('origin')) {
    try { if (new URL(req.get('origin')).host !== req.get('host')) return res.status(403).json({ error: 'Cross-origin request blocked.' }); }
    catch { return res.status(403).json({ error: 'Invalid request origin.' }); }
  }
  next();
});
app.use(session({
  name: 'data-detective.sid', secret, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, secure: production, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000, path: '/' }
}));
app.use('/api/data-detective', require('./data-detective'));
app.get('/api/health', (_req, res) => res.json({ status: 'ok', openaiConfigured: Boolean(process.env.OPENAI_API_KEY) }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'data-detective', 'index.html')));
app.use(express.static(path.join(__dirname, 'data-detective'), { index: false }));
app.use((req, res) => res.status(404).json({ error: 'Page not found.' }));
app.listen(port, '127.0.0.1', () => console.log(`Local Data Detective listening at http://localhost:${port}`));
