const express = require('express');
const router = express.Router();
const config = require('../config');

// GET /api/health - Health check
router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'sycord-runner',
    version: '1.0.0',
    domain: config.domain,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
