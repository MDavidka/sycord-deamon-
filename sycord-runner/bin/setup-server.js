#!/usr/bin/env node

const { exec, execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');

const SETUP_PORT = parseInt(process.env.SETUP_PORT || '8443', 10);
const INSTALL_DIR = '/opt/sycord-runner';

let clients = [];

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => res.write(msg));
}

function addSSEClient(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  clients.push(res);
  req.on('close', () => {
    clients = clients.filter(c => c !== res);
  });
}

function logEvent(text, style) {
  broadcast({ type: 'log', text, style: style || 'info' });
  console.log(`[setup] ${text}`);
}

function getPublicIP() {
  try {
    return execSync('curl -sf4 icanhazip.com 2>/dev/null || curl -sf4 ifconfig.me 2>/dev/null || hostname -I 2>/dev/null | awk \'{print $1}\'', {
      stdio: 'pipe',
      timeout: 5000,
    }).toString().trim();
  } catch {
    try {
      return execSync('hostname -I 2>/dev/null | awk \'{print $1}\'', { stdio: 'pipe' }).toString().trim();
    } catch {
      return '127.0.0.1';
    }
  }
}

async function runSetup(config) {
  logEvent('Starting setup process...', 'heading');

  // Step 1: Write .env
  try {
    logEvent('Writing .env configuration...', 'info');
    fs.mkdirSync(path.join(INSTALL_DIR, 'workspace'), { recursive: true });
    fs.mkdirSync(path.join(INSTALL_DIR, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(INSTALL_DIR, 'docker'), { recursive: true });
    fs.mkdirSync('/var/log', { recursive: true });

    const envContent = `CLOUDFLARE_API_KEY=${config.apiKey}
CLOUDFLARE_ZONE_ID=${config.zoneId}
CLOUDFLARE_ACCOUNT_ID=${config.accountId}
MONGO_URI=${config.mongoUri}
CLOUDFLARE_DOMAIN=${config.domain}
PORT=${config.port}
UBUNTU_USERNAME=
UBUNTU_PSW=
UBUNTU_IP=
NODE_ENV=production
DOCKER_NETWORK=sycord_network
WORKSPACE_BASE=${INSTALL_DIR}/workspace
`;

    fs.writeFileSync(path.join(INSTALL_DIR, '.env'), envContent, { mode: 0o600 });
    logEvent('.env file created', 'success');
  } catch (e) {
    logEvent(`Failed to write .env: ${e.message}`, 'error');
    broadcast({ type: 'error', text: e.message });
    return;
  }

  // Step 2: Install cloudflared
  try {
    logEvent('Installing cloudflared...', 'info');
    try {
      execSync('which cloudflared', { stdio: 'pipe' });
      logEvent('cloudflared already installed', 'success');
    } catch {
      execSync('curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg 2>/dev/null', { stdio: 'pipe', timeout: 30000 });
      execSync('echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" > /etc/apt/sources.list.d/cloudflared.list', { stdio: 'pipe' });
      execSync('apt-get update -qq && apt-get install -y -qq cloudflared', { stdio: 'pipe', timeout: 120000 });
      logEvent('cloudflared installed', 'success');
    }
  } catch (e) {
    logEvent(`cloudflared install failed: ${e.message}`, 'error');
  }

  // Step 3: Configure Cloudflare tunnel
  try {
    logEvent('Configuring Cloudflare Tunnel...', 'info');
    const credDir = `${os.homedir()}/.cloudflared`;
    fs.mkdirSync(credDir, { recursive: true });

    fs.writeFileSync(`${credDir}/${config.accountId}.json`, JSON.stringify({
      AccountTag: config.accountId,
      TunnelSecret: config.apiKey,
      TunnelID: config.accountId,
    }));

    const yamlContent = `tunnel: sycord-tunnel
credentials-file: ${credDir}/${config.accountId}.json

ingress:
  - hostname: "*.${config.domain}"
    service: http://localhost:${config.port}
  - hostname: "${config.domain}"
    service: http://localhost:${config.port}
  - hostname: "api.${config.domain}"
    service: http://localhost:${config.port}
  - service: http_status:404
`;
    fs.writeFileSync(`${credDir}/config.yml`, yamlContent);
    logEvent('Tunnel config written', 'success');

    try { execSync('cloudflared tunnel login 2>/dev/null || true', { stdio: 'pipe', timeout: 30000 }); } catch {}
    try {
      execSync('cloudflared tunnel create sycord-tunnel 2>/dev/null || true', { stdio: 'pipe', timeout: 30000 });
      logEvent('Tunnel created', 'success');
    } catch { logEvent('Tunnel may already exist', 'warn'); }

    try {
      execSync('cloudflared tunnel route dns sycord-tunnel "*.${config.domain}" 2>/dev/null || true', { stdio: 'pipe', timeout: 15000 });
      execSync('cloudflared tunnel route dns sycord-tunnel "*.${config.domain}" 2>/dev/null || true', { stdio: 'pipe', timeout: 15000 });
      logEvent('DNS routes configured', 'success');
    } catch { logEvent('DNS route may need manual setup in Cloudflare dashboard', 'warn'); }
  } catch (e) {
    logEvent(`Tunnel config error: ${e.message}`, 'error');
  }

  // Step 4: Clone sycord-deamon
  try {
    logEvent('Cloning sycord-deamon...', 'info');
    const deamonDir = path.join(INSTALL_DIR, 'sycord-deamon');
    if (fs.existsSync(path.join(deamonDir, '.git'))) {
      execSync('git pull origin main', { cwd: deamonDir, stdio: 'pipe', timeout: 30000 });
      logEvent('Daemon repository updated', 'success');
    } else {
      execSync('git clone https://github.com/MDavidka/sycord-deamon ' + deamonDir, { stdio: 'pipe', timeout: 60000 });
      logEvent('Daemon repository cloned', 'success');
    }
  } catch (e) {
    logEvent(`Daemon clone warning: ${e.message}`, 'warn');
  }

  // Step 5: Copy source files
  try {
    logEvent('Copying source files...', 'info');
    const srcDir = path.resolve(__dirname, '..');
    if (srcDir !== INSTALL_DIR) {
      execSync(`cp -a ${srcDir}/src ${INSTALL_DIR}/ 2>/dev/null || true`);
      execSync(`cp -a ${srcDir}/bin ${INSTALL_DIR}/ 2>/dev/null || true`);
      execSync(`cp -a ${srcDir}/docker ${INSTALL_DIR}/ 2>/dev/null || true`);
      execSync(`cp ${srcDir}/package.json ${INSTALL_DIR}/ 2>/dev/null || true`);
      execSync(`cp ${srcDir}/ecosystem.config.js ${INSTALL_DIR}/ 2>/dev/null || true`);
      execSync(`cp ${srcDir}/api.json ${INSTALL_DIR}/ 2>/dev/null || true`);
    }
    logEvent('Source files copied', 'success');
  } catch (e) {
    logEvent(`File copy warning: ${e.message}`, 'warn');
  }

  // Step 6: Install npm dependencies
  try {
    logEvent('Installing Node.js dependencies...', 'info');
    execSync('npm install --production', { cwd: INSTALL_DIR, stdio: 'pipe', timeout: 120000 });
    logEvent('Dependencies installed', 'success');
  } catch (e) {
    logEvent(`npm install failed: ${e.message}`, 'error');
  }

  // Step 7: Install CLI globally
  try {
    logEvent('Installing CLI command...', 'info');
    fs.chmodSync(path.join(INSTALL_DIR, 'bin', 'runner.js'), 0o755);
    fs.chmodSync(path.join(INSTALL_DIR, 'bin', 'watcher.js'), 0o755);
    try { fs.symlinkSync(path.join(INSTALL_DIR, 'bin', 'runner.js'), '/usr/local/bin/sycord-runner'); } catch { execSync('ln -sf ' + path.join(INSTALL_DIR, 'bin', 'runner.js') + ' /usr/local/bin/sycord-runner', { stdio: 'pipe' }); }
    logEvent('CLI command installed', 'success');
  } catch (e) {
    logEvent(`CLI install warning: ${e.message}`, 'warn');
  }

  // Step 8: Docker network
  try {
    logEvent('Setting up Docker network...', 'info');
    try { execSync('docker network inspect sycord_network', { stdio: 'pipe' }); } catch {
      execSync('docker network create sycord_network', { stdio: 'pipe', timeout: 15000 });
    }
    logEvent('Docker network ready', 'success');
  } catch (e) {
    logEvent(`Docker network error: ${e.message}`, 'error');
  }

  // Step 9: PM2
  try {
    logEvent('Installing PM2...', 'info');
    try { execSync('which pm2', { stdio: 'pipe' }); } catch {
      execSync('npm install -g pm2', { stdio: 'pipe', timeout: 60000 });
    }

    if (!fs.existsSync(path.join(INSTALL_DIR, 'ecosystem.config.js'))) {
      const ecosystemConfig = `module.exports = {
  apps: [
    {
      name: 'sycord-runner',
      script: 'src/index.js',
      cwd: '/opt/sycord-runner',
      env: { NODE_ENV: 'production' },
      env_file: '.env',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: '/var/log/sycord-runner-error.log',
      out_file: '/var/log/sycord-runner-out.log',
      merge_logs: true,
    },
    {
      name: 'cloudflared-tunnel',
      script: 'cloudflared',
      args: 'tunnel run sycord-tunnel',
      cwd: '/opt/sycord-runner',
      interpreter: 'none',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_restarts: 10,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: '/var/log/cloudflared-error.log',
      out_file: '/var/log/cloudflared-out.log',
      merge_logs: true,
    },
    {
      name: 'sycord-watcher',
      script: 'bin/watcher.js',
      cwd: '/opt/sycord-runner',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: '/var/log/sycord-watcher-error.log',
      out_file: '/var/log/sycord-watcher-out.log',
      merge_logs: true,
    },
  ],
};
`;
      fs.writeFileSync(path.join(INSTALL_DIR, 'ecosystem.config.js'), ecosystemConfig);
    }

    logEvent('Starting PM2 processes...', 'info');
    execSync('pm2 delete all 2>/dev/null || true', { stdio: 'pipe' });
    execSync(`pm2 start ${path.join(INSTALL_DIR, 'ecosystem.config.js')}`, { stdio: 'pipe', timeout: 15000, cwd: INSTALL_DIR });
    execSync('pm2 save', { stdio: 'pipe' });
    execSync('pm2 startup systemd -u root --hp /root 2>/dev/null || pm2 startup', { stdio: 'pipe' });
    logEvent('PM2 configured and processes started', 'success');
  } catch (e) {
    logEvent(`PM2 error: ${e.message}`, 'error');
  }

  // Step 10: Verify
  try {
    logEvent('Verifying deployment...', 'info');
    const runnerStatus = execSync('pm2 show sycord-runner 2>/dev/null && echo "online" || echo "offline"', { stdio: 'pipe' }).toString().trim();
    const tunnelStatus = execSync('pm2 show cloudflared-tunnel 2>/dev/null && echo "online" || echo "offline"', { stdio: 'pipe' }).toString().trim();
    logEvent(`sycord-runner: ${runnerStatus}`, runnerStatus === 'online' ? 'success' : 'warn');
    logEvent(`cloudflared-tunnel: ${tunnelStatus}`, tunnelStatus === 'online' ? 'success' : 'warn');
  } catch (e) {
    logEvent(`Verification warning: ${e.message}`, 'warn');
  }

  // Complete
  logEvent('', 'break');
  logEvent(`API Endpoint: https://api.${config.domain}`, 'success');
  logEvent(`Health Check: https://api.${config.domain}/api/health`, 'success');
  logEvent(`Root Domain: ${config.domain} → https://sycord.com`, 'info');
  logEvent(`CLI: sycord-runner status`, 'info');

  broadcast({ type: 'complete', domain: config.domain });
}

function getFormHTML(ip) {
  const envPath = path.join(INSTALL_DIR, '.env');
  let savedDomain = 'sycord.site';
  let savedPort = '3000';
  let savedMongo = 'mongodb://localhost:27017/sycord';
  let savedApiKey = '';
  let savedZoneId = '';
  let savedAccountId = '';
  let hasSaved = false;

  if (fs.existsSync(envPath)) {
    const env = fs.readFileSync(envPath, 'utf-8');
    const m = (k) => { const r = env.match(new RegExp(`^${k}=(.+)$`, 'm')); return r ? r[1].trim() : ''; };
    savedDomain = m('CLOUDFLARE_DOMAIN') || savedDomain;
    savedPort = m('PORT') || savedPort;
    savedMongo = m('MONGO_URI') || savedMongo;
    savedApiKey = m('CLOUDFLARE_API_KEY') || '';
    savedZoneId = m('CLOUDFLARE_ZONE_ID') || '';
    savedAccountId = m('CLOUDFLARE_ACCOUNT_ID') || '';
    hasSaved = !!(savedApiKey || savedZoneId || savedAccountId);
  }

  const reconfigureBanner = hasSaved
    ? '<div style="background:#1a1f2b;border:1px solid #30363d;border-radius:6px;padding:12px;margin-bottom:8px;font-size:0.8rem;color:#8b949e;">Saved configuration loaded. Update any field and click <b>Start Setup</b> to reconfigure.</div>'
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sycord Runner — Setup</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0d1117;
    color: #c9d1d9;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .container {
    max-width: 560px;
    width: 100%;
    padding: 20px;
  }
  .card {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 12px;
    padding: 36px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.4);
  }
  h1 {
    font-size: 1.5rem;
    margin-bottom: 4px;
    color: #58a6ff;
  }
  .subtitle {
    font-size: 0.85rem;
    color: #8b949e;
    margin-bottom: 24px;
  }
  label {
    display: block;
    font-size: 0.8rem;
    color: #8b949e;
    margin-bottom: 4px;
    margin-top: 16px;
    font-weight: 600;
  }
  input {
    width: 100%;
    padding: 10px 12px;
    background: #0d1117;
    border: 1px solid #30363d;
    border-radius: 6px;
    color: #c9d1d9;
    font-size: 0.9rem;
    outline: none;
    transition: border-color 0.2s;
  }
  input:focus { border-color: #58a6ff; }
  button {
    width: 100%;
    margin-top: 24px;
    padding: 12px;
    background: #238636;
    border: 1px solid #2ea043;
    border-radius: 6px;
    color: #fff;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s;
  }
  button:hover { background: #2ea043; }
  button:disabled { opacity: 0.6; cursor: not-allowed; }
  #logs {
    margin-top: 20px;
    background: #0d1117;
    border: 1px solid #30363d;
    border-radius: 8px;
    padding: 16px;
    max-height: 280px;
    overflow-y: auto;
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 0.8rem;
    display: none;
  }
  #logs .line { padding: 2px 0; }
  #logs .success { color: #3fb950; }
  #logs .error { color: #f85149; }
  #logs .warn { color: #d29922; }
  #logs .heading { color: #58a6ff; font-weight: bold; margin-top: 8px; }
  #logs .break { height: 4px; }
  .complete-banner {
    display: none;
    margin-top: 20px;
    padding: 16px;
    background: #052e16;
    border: 1px solid #238636;
    border-radius: 8px;
  }
  .complete-banner h2 { color: #3fb950; font-size: 1.1rem; margin-bottom: 8px; }
  .complete-banner a { color: #58a6ff; word-break: break-all; }
  .tip {
    margin-top: 8px;
    font-size: 0.8rem;
    color: #8b949e;
  }
  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid #30363d;
    border-top: 2px solid #58a6ff;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin-left: 8px;
    vertical-align: middle;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div class="container">
  <div class="card" id="form-card">
    <h1>Sycord Runner Setup</h1>
    <p class="subtitle">Configure your deployment runner on this server</p>
    ${reconfigureBanner}
    <form id="setup-form">
      <label for="apiKey">Cloudflare API Key *</label>
      <input type="password" id="apiKey" name="apiKey" required placeholder="Your Cloudflare API token" value="${savedApiKey}">

      <label for="zoneId">Cloudflare Zone ID *</label>
      <input type="text" id="zoneId" name="zoneId" required placeholder="DNS Zone ID" value="${savedZoneId}">

      <label for="accountId">Cloudflare Account ID *</label>
      <input type="text" id="accountId" name="accountId" required placeholder="Account identifier" value="${savedAccountId}">

      <label for="domain">Domain</label>
      <input type="text" id="domain" name="domain" value="${savedDomain}" placeholder="sycord.site">

      <label for="port">API Port</label>
      <input type="number" id="port" name="port" value="${savedPort}" placeholder="3000">

      <label for="mongoUri">MongoDB URI</label>
      <input type="text" id="mongoUri" name="mongoUri" value="${savedMongo}" placeholder="mongodb://localhost:27017/sycord">

      <button type="submit" id="submit-btn">Start Setup</button>
    </form>
    <div id="logs"></div>
  </div>
  <div class="complete-banner" id="complete-banner">
    <h2>Setup Complete!</h2>
    <p>API: <a id="api-link" href="#" target="_blank"></a></p>
    <p style="margin-top:4px;">Health: <a id="health-link" href="#" target="_blank"></a></p>
    <p class="tip">Run <code style="background:#0d1117;padding:2px 6px;border-radius:3px;">sycord-runner status</code> on this server to view status.</p>
    <p class="tip">You can close this page now.</p>
  </div>
</div>
<script>
const form = document.getElementById('setup-form');
const logsEl = document.getElementById('logs');
const submitBtn = document.getElementById('submit-btn');
const completeBanner = document.getElementById('complete-banner');
let setupDone = false;

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (setupDone) return;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Setting up...';
  submitBtn.insertAdjacentHTML('afterbegin', '<span class="spinner"></span> ');
  logsEl.style.display = 'block';
  logsEl.innerHTML = '';

  const evSource = new EventSource('/events');
  evSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'log') {
      const div = document.createElement('div');
      div.className = 'line ' + data.style;
      div.textContent = data.text || '';
      logsEl.appendChild(div);
      logsEl.scrollTop = logsEl.scrollHeight;
    } else if (data.type === 'complete') {
      completeBanner.style.display = 'block';
      document.getElementById('api-link').href = 'https://api.' + data.domain;
      document.getElementById('api-link').textContent = 'https://api.' + data.domain;
      document.getElementById('health-link').href = 'https://api.' + data.domain + '/api/health';
      document.getElementById('health-link').textContent = 'https://api.' + data.domain + '/api/health';
      submitBtn.textContent = 'Done';
      evSource.close();
    } else if (data.type === 'error') {
      const div = document.createElement('div');
      div.className = 'line error';
      div.textContent = 'ERROR: ' + data.text;
      logsEl.appendChild(div);
      logsEl.scrollTop = logsEl.scrollHeight;
      submitBtn.textContent = 'Setup Failed';
      submitBtn.disabled = false;
      evSource.close();
    }
  };

  const formData = new FormData(form);
  const config = Object.fromEntries(formData.entries());

  fetch('/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  }).catch(err => {
    const div = document.createElement('div');
    div.className = 'line error';
    div.textContent = 'ERROR: ' + err.message;
    logsEl.appendChild(div);
    submitBtn.textContent = 'Retry Setup';
    submitBtn.disabled = false;
  });
});
</script>
</body>
</html>`;
}

// ─── Server ──────────────────────────────────────────
if (process.getuid && process.getuid() !== 0) {
  console.error('This setup server must run as root (sudo).');
  process.exit(1);
}

const publicIP = getPublicIP();
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET' && req.url === '/events') {
    return addSSEClient(req, res);
  }

  if (req.method === 'POST' && req.url === '/setup') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const config = JSON.parse(body);
        if (!config.apiKey || !config.zoneId || !config.accountId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'apiKey, zoneId, and accountId are required' }));
          return;
        }
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'started' }));

        // Remove emoji-less log prefix for clean web display
        await runSetup({
          apiKey: config.apiKey.trim(),
          zoneId: config.zoneId.trim(),
          accountId: config.accountId.trim(),
          domain: (config.domain || 'sycord.site').trim(),
          port: config.port || '3000',
          mongoUri: (config.mongoUri || 'mongodb://localhost:27017/sycord').trim(),
        });
      } catch (e) {
        broadcast({ type: 'error', text: e.message });
      }
    });
    return;
  }

  // Serve HTML form
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(getFormHTML(publicIP));
});

server.listen(SETUP_PORT, '0.0.0.0', () => {
  console.log('');
  console.log('══════════════════════════════════════════════');
  console.log('  Sycord Runner — Web Setup');
  console.log('══════════════════════════════════════════════');
  console.log('');
  console.log(`  Open this URL in your browser:`);
  console.log(`  http://${publicIP}:${SETUP_PORT}`);
  console.log('');
  if (publicIP === '127.0.0.1') {
    console.log('  Try other interfaces:');
    const ifaces = os.networkInterfaces();
    for (const [name, addrs] of Object.entries(ifaces)) {
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) {
          console.log(`  http://${addr.address}:${SETUP_PORT}`);
        }
      }
    }
  }
  console.log('');
  console.log('  Press Ctrl+C to stop the setup server.');
  console.log('══════════════════════════════════════════════');
  console.log('');
});
