#!/usr/bin/env bash
# =============================================================
# server-setup.sh
# Run once on your Ubuntu server as a non-root user with sudo.
#
# What this does:
#   1. Installs git, docker, docker-compose (if missing)
#   2. Clones the GitHub repo to /opt/nettools
#   3. Installs the 'webhook' daemon to listen for GitHub pushes
#   4. Creates a deploy script that pulls + restarts docker
#   5. Wires everything up with systemd
#
# Usage:
#   chmod +x server-setup.sh
#   ./server-setup.sh
# =============================================================

set -euo pipefail

# ── CONFIG — edit these ──────────────────────────────────────
GITHUB_USER="YOUR_GITHUB_USERNAME"
GITHUB_REPO="nettools"
DEPLOY_PATH="/opt/nettools"
DEPLOY_USER="${USER}"                 # the non-root user who owns the files
WEBHOOK_PORT="9000"
WEBHOOK_SECRET="CHANGE_THIS_TO_A_LONG_RANDOM_SECRET"
# ─────────────────────────────────────────────────────────────

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}[setup]${NC} $*"; }
ok()    { echo -e "${GREEN}[ok]${NC}    $*"; }
error() { echo -e "${RED}[error]${NC} $*"; exit 1; }

# ── 1. System packages ────────────────────────────────────────
info "Updating apt and installing dependencies..."
sudo apt-get update -qq
sudo apt-get install -y -qq git curl webhook

# Docker (skip if already installed)
if ! command -v docker &>/dev/null; then
    info "Installing Docker..."
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker "$DEPLOY_USER"
    ok "Docker installed. You may need to log out and back in for group membership."
else
    ok "Docker already installed: $(docker --version)"
fi

# docker compose plugin
if ! docker compose version &>/dev/null 2>&1; then
    info "Installing docker compose plugin..."
    sudo apt-get install -y -qq docker-compose-plugin
fi
ok "Docker Compose: $(docker compose version --short)"

# ── 2. Clone repo ─────────────────────────────────────────────
info "Setting up deploy path: $DEPLOY_PATH"
sudo mkdir -p "$DEPLOY_PATH"
sudo chown "$DEPLOY_USER:$DEPLOY_USER" "$DEPLOY_PATH"

if [ ! -d "$DEPLOY_PATH/.git" ]; then
    info "Cloning https://github.com/$GITHUB_USER/$GITHUB_REPO ..."
    git clone "https://github.com/$GITHUB_USER/$GITHUB_REPO.git" "$DEPLOY_PATH"
    ok "Repo cloned to $DEPLOY_PATH"
else
    ok "Repo already cloned at $DEPLOY_PATH"
fi

# ── 3. Deploy script ──────────────────────────────────────────
info "Writing /usr/local/bin/nettools-deploy..."
sudo tee /usr/local/bin/nettools-deploy > /dev/null << DEPLOY_SCRIPT
#!/usr/bin/env bash
# nettools-deploy — pull latest from GitHub and restart containers
set -euo pipefail
DEPLOY_PATH="$DEPLOY_PATH"
LOG="/var/log/nettools-deploy.log"

echo "[\$(date '+%Y-%m-%d %H:%M:%S')] Deploy triggered" >> "\$LOG"

cd "\$DEPLOY_PATH"

# Pull latest code
git fetch origin main
git reset --hard origin/main
echo "[\$(date '+%Y-%m-%d %H:%M:%S')] Git pull complete" >> "\$LOG"

# Restart only the nettools container (adjust service name if needed)
# Using the parent compose file one level up if it exists, otherwise local
if [ -f "/opt/docker-compose.yml" ]; then
    docker compose -f /opt/docker-compose.yml up -d --build nettools
else
    docker compose up -d --build
fi

echo "[\$(date '+%Y-%m-%d %H:%M:%S')] Deploy complete" >> "\$LOG"
DEPLOY_SCRIPT

sudo chmod +x /usr/local/bin/nettools-deploy
ok "Deploy script written"

# Allow DEPLOY_USER to run deploy without password (needed by webhook daemon)
SUDOERS_LINE="$DEPLOY_USER ALL=(ALL) NOPASSWD: /usr/local/bin/nettools-deploy"
if ! sudo grep -qF "$SUDOERS_LINE" /etc/sudoers.d/nettools 2>/dev/null; then
    echo "$SUDOERS_LINE" | sudo tee /etc/sudoers.d/nettools > /dev/null
    sudo chmod 440 /etc/sudoers.d/nettools
    ok "Sudoers entry added for passwordless deploy"
fi

# ── 4. Webhook config ─────────────────────────────────────────
info "Writing webhook configuration..."
sudo mkdir -p /etc/webhook
sudo tee /etc/webhook/hooks.json > /dev/null << WEBHOOK_JSON
[
  {
    "id": "nettools-deploy",
    "execute-command": "/usr/local/bin/nettools-deploy",
    "command-working-directory": "$DEPLOY_PATH",
    "response-message": "Deploy triggered.",
    "trigger-rule": {
      "and": [
        {
          "match": {
            "type": "payload-hmac-sha256",
            "secret": "$WEBHOOK_SECRET",
            "parameter": {
              "source": "header",
              "name": "X-Hub-Signature-256"
            }
          }
        },
        {
          "match": {
            "type": "value",
            "value": "refs/heads/main",
            "parameter": {
              "source": "payload",
              "name": "ref"
            }
          }
        }
      ]
    }
  }
]
WEBHOOK_JSON
ok "Webhook config written to /etc/webhook/hooks.json"

# ── 5. Systemd service for webhook ───────────────────────────
info "Writing systemd service for webhook daemon..."
sudo tee /etc/systemd/system/webhook.service > /dev/null << SYSTEMD_UNIT
[Unit]
Description=GitHub Webhook Listener (nettools)
After=network.target

[Service]
Type=simple
User=$DEPLOY_USER
ExecStart=/usr/bin/webhook \
    -hooks /etc/webhook/hooks.json \
    -port $WEBHOOK_PORT \
    -verbose \
    -hotreload
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
SYSTEMD_UNIT

sudo systemctl daemon-reload
sudo systemctl enable webhook
sudo systemctl restart webhook
ok "Webhook service enabled and started on port $WEBHOOK_PORT"

# ── 6. Firewall reminder ──────────────────────────────────────
if command -v ufw &>/dev/null; then
    info "Opening firewall port $WEBHOOK_PORT for webhook..."
    sudo ufw allow "$WEBHOOK_PORT/tcp" comment "GitHub webhook listener"
    ok "ufw rule added for port $WEBHOOK_PORT"
fi

# ── Done ──────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  Server setup complete!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo "  Deploy path   : $DEPLOY_PATH"
echo "  Webhook URL   : http://$(hostname -I | awk '{print $1}'):$WEBHOOK_PORT/hooks/nettools-deploy"
echo "  Webhook secret: $WEBHOOK_SECRET"
echo "  Deploy log    : /var/log/nettools-deploy.log"
echo ""
echo "  Next: add the webhook to GitHub (see docs/SETUP.md)"
echo ""
echo -e "${CYAN}  To test the deploy manually:${NC}"
echo "    /usr/local/bin/nettools-deploy"
echo ""
echo -e "${CYAN}  To watch webhook logs:${NC}"
echo "    journalctl -fu webhook"
