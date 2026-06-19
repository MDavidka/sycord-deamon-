const config = require('../config');

function authMiddleware(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;

  if (!apiKey) {
    return res.status(401).json({ error: 'Missing API key. Provide X-API-Key header.' });
  }

  if (apiKey !== config.cloudflare.apiKey) {
    return res.status(403).json({ error: 'Invalid API key.' });
  }

  next();
}

module.exports = authMiddleware;
