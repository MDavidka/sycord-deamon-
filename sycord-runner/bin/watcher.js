#!/usr/bin/env node

const { execSync } = require('child_process');
const path = require('path');

const INSTALL_DIR = '/opt/sycord-runner';
const DEAMON_DIR = path.join(INSTALL_DIR, 'sycord-deamon');
const POLL_INTERVAL_MS = 60 * 1000;
const GIT_REPO = 'https://github.com/MDavidka/sycord-deamon';

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function checkAndPull() {
  try {
    if (!require('fs').existsSync(path.join(DEAMON_DIR, '.git'))) {
      log(`Cloning ${GIT_REPO}...`);
      execSync(`git clone ${GIT_REPO} ${DEAMON_DIR}`, { stdio: 'pipe', timeout: 30000 });
      log('Repository cloned successfully.');
      restartServices();
      return;
    }

    execSync('git fetch origin', { cwd: DEAMON_DIR, stdio: 'pipe', timeout: 15000 });

    const localHash = execSync('git rev-parse HEAD', { cwd: DEAMON_DIR, stdio: 'pipe', timeout: 5000 }).toString().trim();
    const remoteHash = execSync('git rev-parse origin/main', { cwd: DEAMON_DIR, stdio: 'pipe', timeout: 5000 }).toString().trim();

    if (localHash !== remoteHash) {
      log(`New commits detected: ${localHash.substring(0, 7)} → ${remoteHash.substring(0, 7)}`);
      execSync('git pull origin main', { cwd: DEAMON_DIR, stdio: 'pipe', timeout: 30000 });
      log('Repository updated. Restarting services...');
      restartServices();
    }
  } catch (err) {
    log(`Watcher error: ${err.message}`);
  }
}

function restartServices() {
  try {
    execSync('pm2 restart sycord-runner cloudflared-tunnel', { stdio: 'pipe', timeout: 10000 });
    log('Services restarted via PM2.');
  } catch (err) {
    log(`Failed to restart services: ${err.message}`);
  }
}

async function main() {
  log('Sycord repo watcher started — polling every 60s');
  while (true) {
    await checkAndPull();
    await sleep(POLL_INTERVAL_MS);
  }
}

main();
