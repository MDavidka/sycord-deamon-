const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const config = require('./config');
const authMiddleware = require('./middleware/auth');
const dockerService = require('./services/docker');

const deployRoutes = require('./routes/deploy');
const healthRoutes = require('./routes/health');

const app = express();

// Security
app.use(helmet());
app.use(cors());

// Rate limiting on API routes
const deployLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many deploy requests, slow down.' },
});

// Trust proxy headers from Cloudflare Tunnel
app.set('trust proxy', true);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Logging
app.use(morgan('combined'));

// === Error handler ===
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// === Port registry (used by deploy routes) ===
app.getPortRegistry = () => portToProject;

const server = app.listen(config.port, '127.0.0.1', () => {
  console.log(`[sycord-runner] listening on http://127.0.0.1:${config.port}`);
  console.log(`[sycord-runner] API domain: api.${config.domain}`);
  console.log(`[sycord-runner] Root domain redirect: ${config.domain} -> ${config.redirectTarget}`);
});

module.exports = { app, server };
