const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  domain: process.env.CLOUDFLARE_DOMAIN || 'sycord.site',
  nodeEnv: process.env.NODE_ENV || 'production',

  cloudflare: {
    apiKey: process.env.CLOUDFLARE_API_KEY,
    zoneId: process.env.CLOUDFLARE_ZONE_ID,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  },

  mongo: {
    uri: process.env.MONGO_URI || 'mongodb://localhost:27017/sycord',
  },

  ubuntu: {
    username: process.env.UBUNTU_USERNAME,
    password: process.env.UBUNTU_PSW,
    ip: process.env.UBUNTU_IP,
  },

  docker: {
    network: process.env.DOCKER_NETWORK || 'sycord_network',
    workspaceBase: process.env.WORKSPACE_BASE || path.resolve(__dirname, '..', 'workspace'),
    containerPrefix: 'sycord-',
    portRange: { start: 4000, end: 4100 },
  },

  redirectTarget: 'https://sycord.com',
};

module.exports = config;
