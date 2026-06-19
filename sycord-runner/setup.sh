#!/usr/bin/env bash
set -euo pipefail

# ────────────────────────────────────────────────────────────
# Sycord Runner — Interactive Setup Script
# Installs and configures the deployment runner on Ubuntu
# ────────────────────────────────────────────────────────────

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
BOLD='\033[1m'

INSTALL_DIR="/opt/sycord-runner"
GIT_REPO="https://github.com/MDavidka/sycord-deamon"

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }
info() { echo -e "${CYAN}[i]${NC} $1"; }

# ────────────────────────────────────────────────────
# 0. Root check
# ────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  err "This script must be run as root (sudo). Try: curl -sL https://... | sudo bash"
fi

echo ""
echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${CYAN}║     Sycord Runner — Setup Wizard          ║${NC}"
echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""

# ────────────────────────────────────────────────────
# 1. Prerequisite checks
# ────────────────────────────────────────────────────
info "Checking prerequisites..."

command -v docker >/dev/null 2>&1 || err "Docker is not installed. Install it first: https://docs.docker.com/engine/install/ubuntu/"
command -v node   >/dev/null 2>&1 || err "Node.js is not installed. Install v20+: https://nodejs.org/"
command -v npm    >/dev/null 2>&1 || err "npm is not installed."
command -v git    >/dev/null 2>&1 || err "git is not installed."

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [[ $NODE_VER -lt 18 ]]; then
  err "Node.js 18+ required. Current: $(node -v)"
fi

log "Docker $(docker --version | awk '{print $3}' | sed 's/,//' | head -1)"
log "Node.js $(node -v)"
log "npm $(npm -v)"
log "git $(git --version | awk '{print $3}')"

# ────────────────────────────────────────────────────
# 2. Gather environment variables interactively
# ────────────────────────────────────────────────────
echo ""
info "Environment Configuration"
info "Leave blank to skip optional values. Press Ctrl+C to abort."
echo ""

read -p "  Cloudflare API Key              : " CF_API_KEY
read -p "  Cloudflare Zone ID              : " CF_ZONE_ID
read -p "  Cloudflare Account ID           : " CF_ACCOUNT_ID
read -p "  MongoDB URI [default shown]     : " MONGO_URI
MONGO_URI=${MONGO_URI:-mongodb://localhost:27017/sycord}
read -p "  Domain (e.g. sycord.site)       : " DOMAIN
DOMAIN=${DOMAIN:-sycord.site}
read -p "  API Port [3000]                  : " PORT_NUM
PORT_NUM=${PORT_NUM:-3000}

# ────────────────────────────────────────────────────
# 3. Create installation directory & .env
# ────────────────────────────────────────────────────
echo ""
info "Creating installation directory at ${INSTALL_DIR}"

mkdir -p "${INSTALL_DIR}"/{workspace,logs,docker}
mkdir -p /var/log

cat > "${INSTALL_DIR}/.env" <<ENVEOF
CLOUDFLARE_API_KEY=${CF_API_KEY}
CLOUDFLARE_ZONE_ID=${CF_ZONE_ID}
CLOUDFLARE_ACCOUNT_ID=${CF_ACCOUNT_ID}
MONGO_URI=${MONGO_URI}
CLOUDFLARE_DOMAIN=${DOMAIN}
PORT=${PORT_NUM}
UBUNTU_USERNAME=
UBUNTU_PSW=
UBUNTU_IP=
NODE_ENV=production
DOCKER_NETWORK=sycord_network
WORKSPACE_BASE=${INSTALL_DIR}/workspace
ENVEOF

chmod 600 "${INSTALL_DIR}/.env"
log ".env file created at ${INSTALL_DIR}/.env"

# ────────────────────────────────────────────────────
# 4. Install cloudflared
# ────────────────────────────────────────────────────
echo ""
info "Installing cloudflared..."

if command -v cloudflared >/dev/null 2>&1; then
  log "cloudflared already installed: $(cloudflared version 2>&1 | head -1)"
else
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg 2>/dev/null
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" \
    > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -qq && apt-get install -y -qq cloudflared
  log "cloudflared installed: $(cloudflared version 2>&1 | head -1)"
fi

# ────────────────────────────────────────────────────
# 5. Authenticate & create wildcard tunnel
# ────────────────────────────────────────────────────
echo ""
info "Configuring Cloudflare Tunnel..."

CLOUDFLARED_CRED="${HOME}/.cloudflared"
mkdir -p "${CLOUDFLARED_CRED}"

# Create tunnel credentials file
cat > "${CLOUDFLARED_CRED}/${CF_ACCOUNT_ID}.json" <<CREDEOF
{"AccountTag":"${CF_ACCOUNT_ID}","TunnelSecret":"${CF_API_KEY}","TunnelID":"${CF_ACCOUNT_ID}"}
CREDEOF

# Create cloudflared config for wildcard tunnel
cat > "${CLOUDFLARED_CRED}/config.yml" <<YAMLEOF
tunnel: sycord-tunnel
credentials-file: ${CLOUDFLARED_CRED}/${CF_ACCOUNT_ID}.json

ingress:
  - hostname: "*.${DOMAIN}"
    service: http://localhost:${PORT_NUM}
  - hostname: "${DOMAIN}"
    service: http://localhost:${PORT_NUM}
  - hostname: "api.${DOMAIN}"
    service: http://localhost:${PORT_NUM}
  - service: http_status:404
YAMLEOF

log "Cloudflare tunnel config created at ${CLOUDFLARED_CRED}/config.yml"

# Login and create tunnel
cloudflared tunnel login 2>/dev/null || true
cloudflared tunnel create sycord-tunnel 2>/dev/null || log "Tunnel 'sycord-tunnel' may already exist"

# Route DNS for wildcard
cloudflared tunnel route dns sycord-tunnel "*.${DOMAIN}" 2>/dev/null || warn "Could not set wildcard DNS route automatically. Set it manually in Cloudflare dashboard."
cloudflared tunnel route dns sycord-tunnel "${DOMAIN}" 2>/dev/null || true

log "Cloudflare tunnel configured"

# ────────────────────────────────────────────────────
# 6. Clone/pull sycord-deamon
# ────────────────────────────────────────────────────
echo ""
info "Cloning Sycord Deamon from ${GIT_REPO}..."

DEAMON_DIR="${INSTALL_DIR}/sycord-deamon"
if [[ -d "${DEAMON_DIR}/.git" ]]; then
  git -C "${DEAMON_DIR}" pull origin main 2>/dev/null || warn "Could not pull latest daemon code"
  log "Daemon repository updated"
else
  git clone "${GIT_REPO}" "${DEAMON_DIR}" 2>/dev/null || warn "Could not clone daemon repository (may not be public yet)"
  log "Daemon repository cloned"
fi

# ────────────────────────────────────────────────────
# 7. Copy runner source if running from different location
# ────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${SCRIPT_DIR}" != "${INSTALL_DIR}" ]]; then
  info "Copying runner source files to ${INSTALL_DIR}..."
  cp -a "${SCRIPT_DIR}/src" "${INSTALL_DIR}/" 2>/dev/null || true
  cp -a "${SCRIPT_DIR}/docker" "${INSTALL_DIR}/" 2>/dev/null || true
  cp "${SCRIPT_DIR}/package.json" "${INSTALL_DIR}/" 2>/dev/null || true
  cp "${SCRIPT_DIR}/ecosystem.config.js" "${INSTALL_DIR}/" 2>/dev/null || true
  cp "${SCRIPT_DIR}/api.json" "${INSTALL_DIR}/" 2>/dev/null || true
  log "Source files copied"
fi

# ────────────────────────────────────────────────────
# 8. Install npm dependencies
# ────────────────────────────────────────────────────
echo ""
info "Installing Node.js dependencies..."

cd "${INSTALL_DIR}"
npm install --production 2>&1 | tail -3
log "Dependencies installed"

# ────────────────────────────────────────────────────
# 9. Create Docker network
# ────────────────────────────────────────────────────
echo ""
info "Setting up Docker network..."

docker network inspect sycord_network >/dev/null 2>&1 || docker network create sycord_network
log "Docker network 'sycord_network' ready"

# ────────────────────────────────────────────────────
# 10. Install & configure PM2
# ────────────────────────────────────────────────────
echo ""
info "Setting up PM2 process manager..."

if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2 2>&1 | tail -3
  log "PM2 installed globally"
fi

# Generate ecosystem.config.js if not present
if [[ ! -f "${INSTALL_DIR}/ecosystem.config.js" ]]; then
  cat > "${INSTALL_DIR}/ecosystem.config.js" <<'ECOSYSTEM'
module.exports = {
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
  ],
};
ECOSYSTEM
fi

# Stop existing processes if running
pm2 delete all 2>/dev/null || true

# Start PM2
pm2 start "${INSTALL_DIR}/ecosystem.config.js"
pm2 save
pm2 startup systemd -u root --hp /root 2>/dev/null || pm2 startup

log "PM2 configured and processes started"
pm2 status

# ────────────────────────────────────────────────────
# 11. Verify deployment
# ────────────────────────────────────────────────────
echo ""
info "Verifying deployment..."
sleep 3

if pm2 show sycord-runner >/dev/null 2>&1; then
  log "sycord-runner is running"
else
  warn "sycord-runner may have failed to start. Check logs: pm2 logs sycord-runner"
fi

if pm2 show cloudflared-tunnel >/dev/null 2>&1; then
  log "cloudflared-tunnel is running"
else
  warn "cloudflared-tunnel may have failed to start. Check logs: pm2 logs cloudflared-tunnel"
fi

# ────────────────────────────────────────────────────
# 12. Final summary
# ────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${GREEN}║     Sycord Runner Setup Complete!         ║${NC}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  API Endpoint:    ${CYAN}https://api.${DOMAIN}${NC}"
echo -e "  Health Check:    ${CYAN}https://api.${DOMAIN}/api/health${NC}"
echo -e "  Root Redirect:   ${DOMAIN} → https://sycord.com"
echo -e "  Install Dir:     ${INSTALL_DIR}"
echo -e "  PM2 Status:      pm2 status"
echo -e "  PM2 Logs:        pm2 logs"
echo -e "  Cloudflare Logs: pm2 logs cloudflared-tunnel"
echo ""

exit 0
