# Sycord Runner

Secure deployment bridge for managing Docker-based Next.js applications behind a Cloudflare Wildcard Tunnel.

## Architecture

```
AI/Client  →  api.sycord.site (Cloudflare Tunnel)  →  Sycord Runner (Node.js)
                                                         ├── API Server (Express)
                                                         ├── Docker Orchestrator
                                                         └── Dynamic Subdomain Router

Users      →  myapp.sycord.site (Cloudflare Tunnel)  →  Router →  Docker Container (Next.js)
              sycord.site                              →  Router →  301 → sycord.com
```

- **Cloudflare Wildcard Tunnel** (`*.sycord.site`) routes all traffic to the central Node.js router
- **Root Domain** (`sycord.site`) returns HTTP 301 redirect to `https://sycord.com`
- **API Subdomain** (`api.sycord.site`) is reserved for the Runner API
- **Project Subdomains** (`<projectname>.sycord.site`) proxy to isolated Docker containers
- **Workspaces** are isolated at `workspace/<uuid>` and bind-mounted into containers
- **PM2** manages both the API server and `cloudflared` tunnel process with auto-restart on reboot

## Quick Install

On your Ubuntu VM, run this single command:

```bash
curl -sL https://raw.githubusercontent.com/MDavidka/sycord-deamon/main/setup.sh | sudo bash
```

This starts the **web-based setup wizard**. Open the URL printed in your terminal to a browser and fill out the form. No SSH interaction needed beyond the initial command.

**What it does automatically:**
- Installs cloudflared and creates the wildcard tunnel (`*.sycord.site`)
- Writes environment configuration
- Installs npm dependencies, PM2, and Docker network
- Starts the runner API, tunnel, and GitHub auto-watcher
- Enables auto-start on VM reboot
- Installs the `sycord-runner` CLI command

After setup, manage the service from the VM:
```bash
sycord-runner status   # View all processes
sycord-runner logs     # Watch live logs
sycord-runner health   # Check API health
```

## Prerequisites

- Ubuntu 20.04+ / 22.04+ / 24.04+
- Docker (with `docker` CLI available)
- Node.js 18+
- Cloudflare account with a domain (`sycord.site`) on Cloudflare DNS

## Environment Variables

| Variable              | Required | Description                                      |
|-----------------------|----------|--------------------------------------------------|
| `CLOUDFLARE_API_KEY`  | Yes      | Cloudflare API token with Tunnel permissions      |
| `CLOUDFLARE_ZONE_ID`  | Yes      | Cloudflare DNS Zone ID for your domain            |
| `CLOUDFLARE_ACCOUNT_ID` | Yes    | Cloudflare Account ID                             |
| `CLOUDFLARE_DOMAIN`   | Yes      | Your wildcard domain (e.g. `sycord.site`)         |
| `MONGO_URI`           | No       | MongoDB connection string (default: localhost)    |
| `PORT`                | No       | Internal API port (default: 3000)                 |

## API Reference

Full OpenAPI 3.0 specification at [api.json](./api.json).

### Authentication

All API endpoints (except `/api/health`) require the `X-API-Key` header set to your `CLOUDFLARE_API_KEY`.

### Endpoints

| Method   | Path                                       | Description                  |
|----------|--------------------------------------------|------------------------------|
| `GET`    | `/api/health`                              | Health check (no auth)       |
| `GET`    | `/api/deploy/projects`                     | List all projects            |
| `POST`   | `/api/deploy/projects`                     | Create project workspace     |
| `PUT`    | `/api/deploy/projects/:id/files`           | Write source files           |
| `POST`   | `/api/deploy/projects/:id/build`           | Build Next.js application    |
| `POST`   | `/api/deploy/projects/:id/deploy`          | Deploy to Docker container   |
| `POST`   | `/api/deploy/projects/:id/stop`            | Stop and remove container    |
| `DELETE` | `/api/deploy/projects/:id`                 | Delete project entirely      |
| `GET`    | `/api/deploy/projects/:id/logs`            | Get container logs           |
| `GET`    | `/api/deploy/projects/:id/status`          | Get project/container status |

### Typical Workflow

```bash
# 1. Create workspace
curl -X POST https://api.sycord.site/api/deploy/projects \
  -H "X-API-Key: $CLOUDFLARE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"projectName": "my-next-app"}'

# 2. Write source files
curl -X PUT https://api.sycord.site/api/deploy/projects/<projectId>/files \
  -H "X-API-Key: $CLOUDFLARE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"files": [
    {"path": "package.json", "content": "{...}"},
    {"path": "pages/index.js", "content": "export default function Home() { return <h1>Hello</h1> }"}
  ]}'

# 3. Build
curl -X POST https://api.sycord.site/api/deploy/projects/<projectId>/build \
  -H "X-API-Key: $CLOUDFLARE_API_KEY"

# 4. Deploy
curl -X POST https://api.sycord.site/api/deploy/projects/<projectId>/deploy \
  -H "X-API-Key: $CLOUDFLARE_API_KEY"

# Site now live at: https://my-next-app.sycord.site
```

## Management

```bash
# Using the sycord-runner CLI (installed system-wide after setup)
sycord-runner start        # Start all services
sycord-runner stop         # Stop all services
sycord-runner restart      # Restart all services
sycord-runner reconfigure  # Re-run onboarding with saved .env values (non-interactive)
sycord-runner status       # Show PM2 + Docker status
sycord-runner logs         # Watch live logs
sycord-runner health       # Check API health
sycord-runner api <method> <path> [-d <data>]  # Call any API endpoint

# Direct PM2 commands
pm2 status                 # View all processes
pm2 logs sycord-runner     # API server logs
pm2 logs cloudflared-tunnel  # Tunnel logs
pm2 logs sycord-watcher    # GitHub repo watcher logs
pm2 restart all            # Restart all processes
```

### GitHub Auto-Watcher

The `sycord-watcher` PM2 process polls its own git repository every 60 seconds. When new commits are detected on `main`, it auto-pulls, runs `npm install`, and restarts all services. No manual intervention needed for updates.

### CLI API Examples

```bash
sycord-runner api GET /api/health
sycord-runner api POST /api/deploy/projects -d '{"projectName":"my-app"}'
sycord-runner api GET /api/deploy/projects
sycord-runner api POST /api/deploy/projects/<id>/build
sycord-runner api POST /api/deploy/projects/<id>/deploy
```

## Directory Structure

```
/opt/sycord-runner/
├── .env                 # Environment variables (created by setup.sh)
├── ecosystem.config.js  # PM2 process configuration
├── api.json             # OpenAPI specification
├── package.json         # Node.js dependencies
├── bin/
│   ├── runner.js        # CLI tool (sycord-runner command)
│   ├── setup-server.js  # Web-based setup wizard
│   └── watcher.js       # GitHub repo auto-update watcher
├── src/
│   ├── index.js         # Main server + domain router
│   ├── config.js        # Configuration loader
│   ├── routes/
│   │   ├── deploy.js    # Deployment API routes
│   │   └── health.js    # Health check route
│   ├── services/
│   │   └── docker.js    # Docker container management
│   ├── middleware/
│   │   └── auth.js      # API key authentication
│   └── utils/
│       └── workspace.js # Workspace directory helpers
├── docker/
│   └── Dockerfile.nextjs # Docker image for Next.js apps
├── workspace/
│   └── <project-uuid>/   # Isolated project workspaces
└── .git/                 # Git repo for self-updating runner source
```

## Security

- API authentication via `X-API-Key` header
- Project files isolated per UUID workspace
- Docker containers run on isolated bridge network
- Containers bind-mount read/write only their own workspace
- Rate limiting on API endpoints
- Helmet.js security headers
