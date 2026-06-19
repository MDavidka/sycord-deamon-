#!/usr/bin/env node

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const INSTALL_DIR = '/opt/sycord-runner';
const GREEN = '\x1b[32m'; const CYAN = '\x1b[36m'; const RED = '\x1b[31m'; const YELLOW = '\x1b[33m'; const NC = '\x1b[0m';
const BOLD = '\x1b[1m';

function log(msg) { console.log(`${GREEN}[✓]${NC} ${msg}`); }
function info(msg) { console.log(`${CYAN}[i]${NC} ${msg}`); }
function warn(msg) { console.log(`${YELLOW}[!]${NC} ${msg}`); }
function err(msg) { console.error(`${RED}[✗]${NC} ${msg}`); process.exit(1); }

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { stdio: opts.silent ? 'pipe' : 'inherit', ...opts });
  } catch (e) {
    if (!opts.ignoreError) throw e;
    return null;
  }
}

function printBanner() {
  console.log(`${BOLD}${CYAN}╔══════════════════════════════════════════╗${NC}`);
  console.log(`${BOLD}${CYAN}║        Sycord Runner v1.0.0             ║${NC}`);
  console.log(`${BOLD}${CYAN}╚══════════════════════════════════════════╝${NC}`);
  console.log('');
}

function printHelp() {
  console.log(`Usage: sycord-runner <command> [options]

${BOLD}Commands:${NC}
  ${CYAN}start${NC}        Start the runner API and Cloudflare tunnel via PM2
  ${CYAN}stop${NC}         Stop all Sycord Runner processes
  ${CYAN}restart${NC}      Restart all Sycord Runner processes
  ${CYAN}reconfigure${NC}  Re-run onboarding using saved env vars (non-interactive)
  ${CYAN}status${NC}       Show status of all processes
  ${CYAN}logs${NC}         Show live logs (Ctrl+C to exit)
  ${CYAN}setup${NC}        Run the interactive setup wizard
  ${CYAN}health${NC}       Check if the API is responding (requires curl)
  ${CYAN}api <method>${NC} Call any API endpoint directly from the CLI

${BOLD}Examples:${NC}
  sycord-runner start
  sycord-runner reconfigure
  sycord-runner status
  sycord-runner logs
  sycord-runner health
  sycord-runner api GET /api/health
  sycord-runner api POST /api/deploy/projects -d '{"projectName":"my-app"}'
`);
}

function pm2Exists() {
  try {
    execSync('which pm2', { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

function cmdStart() {
  if (!pm2Exists()) err('PM2 is not installed. Run: sudo npm install -g pm2');
  if (!fs.existsSync(INSTALL_DIR)) err(`Installation not found at ${INSTALL_DIR}. Run: sudo sycord-runner setup`);
  info('Starting Sycord Runner via PM2...');
  run(`pm2 start ${INSTALL_DIR}/ecosystem.config.js`, { cwd: INSTALL_DIR });
  run('pm2 save');
  log('All processes started');
  cmdStatus();
}

function cmdStop() {
  info('Stopping all Sycord Runner processes...');
  run('pm2 stop sycord-runner cloudflared-tunnel sycord-watcher', { ignoreError: true });
  log('Processes stopped');
}

function cmdRestart() {
  info('Restarting all Sycord Runner processes...');
  if (fs.existsSync(INSTALL_DIR)) {
    run(`pm2 restart ${INSTALL_DIR}/ecosystem.config.js`, { cwd: INSTALL_DIR });
  } else {
    run('pm2 restart sycord-runner cloudflared-tunnel', { ignoreError: true });
  }
  log('Processes restarted');
}

function cmdStatus() {
  printBanner();
  console.log(`${BOLD}PM2 Status:${NC}`);
  run('pm2 status', { ignoreError: true });
  console.log('');
  console.log(`${BOLD}Docker Containers:${NC}`);
  run('docker ps --filter "name=sycord-" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"', { ignoreError: true });
}

function cmdLogs() {
  info('Showing live logs (Ctrl+C to exit)...');
  try {
    const proc = spawn('pm2', ['logs'], { stdio: 'inherit', cwd: INSTALL_DIR });
    proc.on('close', () => process.exit(0));
  } catch {
    run('pm2 logs', { cwd: INSTALL_DIR });
  }
}

function cmdHealth() {
  info('Checking API health...');
  const envPath = path.join(INSTALL_DIR, '.env');
  if (!fs.existsSync(envPath)) err('.env file not found. Run: sycord-runner setup');

  const envContent = fs.readFileSync(envPath, 'utf-8');
  const portMatch = envContent.match(/PORT=(\d+)/);
  const port = portMatch ? portMatch[1] : '3000';
  const domainMatch = envContent.match(/CLOUDFLARE_DOMAIN=(.+)/);
  const domain = domainMatch ? domainMatch[1].trim() : null;

  // Try local first, then API domain
  let result = run(`curl -sf http://127.0.0.1:${port}/api/health`, { silent: true, ignoreError: true });
  if (result) {
    console.log(result.toString());
    return;
  }
  if (domain) {
    result = run(`curl -sf https://api.${domain}/api/health`, { silent: true, ignoreError: true });
    if (result) {
      console.log(result.toString());
      return;
    }
  }
  err('API is not responding. Check logs: sycord-runner logs');
}

function cmdSetup() {
  const setupScript = path.join(INSTALL_DIR, 'setup.sh');
  if (fs.existsSync(setupScript)) {
    run(`bash ${setupScript}`, { cwd: INSTALL_DIR });
  } else {
    err('setup.sh not found. Re-clone the repository.');
  }
}

function cmdReconfigure() {
  info('Reconfiguring Sycord Runner using saved .env values...');
  const envPath = path.join(INSTALL_DIR, '.env');
  if (!fs.existsSync(envPath)) {
    err('No .env file found. Run interactive setup first: sycord-runner setup');
  }

  const setupScript = path.join(INSTALL_DIR, 'setup.sh');
  if (!fs.existsSync(setupScript)) {
    err('setup.sh not found. Re-clone the repository.');
  }

  // Source the existing .env and run setup in reconfigure mode
  const cmd = `source ${envPath} 2>/dev/null; export $(grep -v '^#' ${envPath} | xargs); bash ${setupScript} --reconfigure`;
  run(cmd, { cwd: INSTALL_DIR });
}

function cmdApi(args) {
  const envPath = path.join(INSTALL_DIR, '.env');
  let apiKey = '';
  let domain = 'sycord.site';

  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    const keyMatch = envContent.match(/CLOUDFLARE_API_KEY=(.+)/);
    if (keyMatch) apiKey = keyMatch[1].trim();
    const domainMatch = envContent.match(/CLOUDFLARE_DOMAIN=(.+)/);
    if (domainMatch) domain = domainMatch[1].trim();
  }

  if (!apiKey) {
    apiKey = process.env.CLOUDFLARE_API_KEY || '';
    if (!apiKey) warn('No API key found. Set CLOUDFLARE_API_KEY or run setup first.');
  }

  const method = (args[0] || 'GET').toUpperCase();
  let endpoint = args[1] || '/api/health';
  const dataFlag = args.indexOf('-d') !== -1 ? args[args.indexOf('-d') + 1] : null;

  if (dataFlag && !['POST', 'PUT', 'PATCH'].includes(method)) {
    warn('Data flag (-d) is typically used with POST/PUT/PATCH methods.');
  }

  const url = `https://api.${domain}${endpoint}`;
  let curlCmd = `curl -sS -X ${method} "${url}" -H "X-API-Key: ${apiKey}" -H "Content-Type: application/json"`;

  if (dataFlag) {
    curlCmd += ` -d '${dataFlag}'`;
  }

  info(`${method} ${url}`);
  run(curlCmd);
}

// ─── Main ───────────────────────────────────────────────
const args = process.argv.slice(2);
const command = args[0];

if (!command || command === 'help' || command === '--help' || command === '-h') {
  printHelp();
  process.exit(0);
}

if (command === 'version' || command === '--version' || command === '-v') {
  console.log('sycord-runner v1.0.0');
  process.exit(0);
}

switch (command) {
  case 'start':        cmdStart(); break;
  case 'stop':         cmdStop(); break;
  case 'restart':      cmdRestart(); break;
  case 'reconfigure':  cmdReconfigure(); break;
  case 'status':       cmdStatus(); break;
  case 'logs':         cmdLogs(); break;
  case 'setup':        cmdSetup(); break;
  case 'health':       cmdHealth(); break;
  case 'api':          cmdApi(args.slice(1)); break;
  default:
    err(`Unknown command: ${command}\nRun 'sycord-runner help' for usage.`);
}
