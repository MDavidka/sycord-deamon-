#!/usr/bin/env bash
set -euo pipefail

# ────────────────────────────────────────────────────────────
# Sycord Runner — Bootstrapper
# Downloads the runner, then starts the web-based setup wizard.
# ────────────────────────────────────────────────────────────

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
BOLD='\033[1m'

INSTALL_DIR="/opt/sycord-runner"
GIT_REPO="https://github.com/MDavidka/sycord-deamon"
SETUP_PORT="${SETUP_PORT:-8443}"
RECONFIGURE=false

if [[ "${1:-}" == "--reconfigure" ]]; then
  RECONFIGURE=true
fi

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }
info() { echo -e "${CYAN}[i]${NC} $1"; }

# ────────────────────────────────────────────────────
# Root check
# ────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  err "This script must be run as root (sudo). Try: curl -sL https://... | sudo bash"
fi

echo ""
echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${CYAN}║     Sycord Runner — Setup Bootstrapper    ║${NC}"
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
# 2. Clone/download runner source
# ────────────────────────────────────────────────────
echo ""
info "Fetching runner source code..."

mkdir -p "${INSTALL_DIR}"

if [[ -d "${INSTALL_DIR}/.git" ]]; then
  git -C "${INSTALL_DIR}" pull origin main 2>/dev/null || warn "Could not pull latest — using cached version"
  log "Runner source updated"
else
  # Clone the runner repo
  git clone "${GIT_REPO}" "${INSTALL_DIR}" 2>/dev/null || {
    warn "Could not clone from ${GIT_REPO}"
    warn "If you are running locally, ensure the source is at ${INSTALL_DIR}"
    if [[ ! -f "${INSTALL_DIR}/bin/setup-server.js" ]]; then
      err "Runner source not found and cannot be cloned. Place source at ${INSTALL_DIR} manually."
    fi
  }
  log "Runner source cloned"
fi

# ────────────────────────────────────────────────────
# 3. Install npm dependencies for setup server
# ────────────────────────────────────────────────────
echo ""
info "Installing dependencies..."

cd "${INSTALL_DIR}"
npm install --production 2>&1 | tail -3
log "Dependencies installed"

# Ensure scripts are executable
chmod +x "${INSTALL_DIR}/bin/"*.js 2>/dev/null || true

# ────────────────────────────────────────────────────
# 4. Detect public IP
# ────────────────────────────────────────────────────
echo ""
info "Detecting server IP..."

PUBLIC_IP=$(curl -sf4 icanhazip.com 2>/dev/null || curl -sf4 ifconfig.me 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1")

# ────────────────────────────────────────────────────
# 5. Start web setup server
# ────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${GREEN}║   Web Setup Wizard Starting...            ║${NC}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Open this URL in your browser:"
echo -e "  ${BOLD}${CYAN}http://${PUBLIC_IP}:${SETUP_PORT}${NC}"
echo ""
echo -e "  Press Ctrl+C to stop the setup server."
echo ""

# If reconfigure, pre-load env for the web server
if [[ "$RECONFIGURE" == "true" ]] && [[ -f "${INSTALL_DIR}/.env" ]]; then
  export $(grep -v '^#' "${INSTALL_DIR}/.env" | xargs)
  log "Loaded saved configuration for reconfigure"
fi

exec node "${INSTALL_DIR}/bin/setup-server.js"
