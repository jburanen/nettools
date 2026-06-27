# SETUP.md — AdminTools Deployment Guide

Complete setup for: Windows dev machine → GitHub → Ubuntu server, with webhook auto-deploy.

---

## Overview

```
Windows (edit code)
    │
    ├─► git push ──────────────────► GitHub (source of truth)
    │                                     │
    └─► scp (quick edits, optional)       │ webhook POST
                                          ▼
                                  Ubuntu server
                                  /opt/nettools
                                  docker compose up -d
                                  https://fwctl.com/
```

**Two ways to publish:**
- `.\deploy.ps1` — SCP to server immediately + push to GitHub
- `.\git-push.ps1` — Push to GitHub only; server auto-pulls via webhook

---

## Part 1 — Windows Setup

### Prerequisites
Install these once if not already present:

```powershell
# Check git
git --version       # need 2.x+

# Check OpenSSH (for scp)
ssh -V              # built into Windows 10/11

# If git is missing:
winget install Git.Git
```

### Step 1 — Edit init-repo.ps1

Open `init-repo.ps1` and fill in the CONFIG block at the top:

```powershell
$GITHUB_USER   = "yourname"              # your GitHub username
$GITHUB_REPO   = "nettools"       # repo name you'll create
$LOCAL_ROOT    = "$HOME\Projects\nettools"
$SERVER_USER   = "ubuntu"               # your SSH username on the server
$SERVER_HOST   = "192.168.1.100"        # server IP or hostname
$SERVER_PATH   = "/opt/nettools" # where files live on the server
```

### Step 2 — Run the initialiser

```powershell
cd path\to\this\folder
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\init-repo.ps1
```

This creates the folder structure, `.gitignore`, `deploy.ps1`, `git-push.ps1`, and initialises the git repo.

### Step 3 — Create the GitHub repo

1. Go to https://github.com/new
2. Repository name: `nettools`
3. Choose Public or Private
4. **Do NOT** tick "Add a README", ".gitignore", or "license" — the local repo already has these
5. Click **Create repository**

### Step 4 — Copy project files in

Copy the nettools project files into your new local repo:

```
$HOME\Projects\nettools\
├── Dockerfile
├── docker-compose.yml
├── nginx\
│   └── default.conf
└── subnet\
    ├── index.html
    ├── css\main.css
    └── js\subnet.js
       js\app.js
```

### Step 5 — First push to GitHub

```powershell
cd $HOME\Projects\nettools
git add -A
git commit -m "initial commit"
git push -u origin main
```

---

## Part 2 — Server Setup

SSH into your Ubuntu server and run these steps.

### Step 1 — Edit server-setup.sh

Open `server-setup.sh` and fill in:

```bash
GITHUB_USER="yourname"
GITHUB_REPO="nettools"
DEPLOY_PATH="/opt/nettools"
WEBHOOK_SECRET="pick-a-long-random-string-here"   # ← make this unique
```

Generate a good secret on your Windows machine:
```powershell
-join ((65..90 + 97..122 + 48..57) * 10 | Get-Random -Count 40 | % {[char]$_})
```

### Step 2 — Run server-setup.sh

```bash
# Upload the script
scp server-setup.sh user@your-server:~/
ssh user@your-server

# On the server:
chmod +x server-setup.sh
./server-setup.sh
```

The script will:
- Install git, docker, docker-compose, webhook daemon
- Clone your GitHub repo to `/opt/nettools`
- Write `/usr/local/bin/nettools-deploy`
- Configure and start the webhook listener on port 9000
- Open the firewall port

At the end it prints your **webhook URL** and **secret** — save these.

### Step 3 — Integrate with your existing docker-compose.yml

If your main `docker-compose.yml` lives at `/opt/docker-compose.yml`:

```bash
# Merge the nettools service into your existing compose file
# The volume paths use ./... relative to /opt/
```

The volume sources in `docker-compose.yml` are already set to `./subnet` and `./nginx/default.conf`, which resolve correctly from `/opt/`.

---

## Part 3 — GitHub Webhook

### Step 1 — Add the webhook in GitHub

1. Go to your repo → **Settings** → **Webhooks** → **Add webhook**
2. Fill in:
   - **Payload URL**: `https://fwctl.com/webhook/hooks/nettools-deploy`
   - **Content type**: `application/json`
   - **Secret**: the `WEBHOOK_SECRET` you set in `server-setup.sh`
   - **Which events**: Just the push event
3. Click **Add webhook**

### Step 2 — Test it

Push a trivial change from Windows:

```powershell
cd $HOME\Projects\nettools
echo "# test" >> README.md
.\git-push.ps1 -m "test webhook"
```

Then on the server, watch it deploy:

```bash
journalctl -fu webhook          # live webhook daemon logs
tail -f /var/log/nettools-deploy.log   # deploy script output
```

GitHub also shows webhook delivery status under Settings → Webhooks → your webhook → Recent Deliveries.

---

## Part 4 — Daily Workflow

### Editing code on Windows

```powershell
cd $HOME\Projects\nettools

# Edit files in subnet\, nginx\, etc.
# Then choose one of:

# Option A — SCP to server immediately AND push to GitHub
.\deploy.ps1 -m "fix subnet wildcard display"

# Option B — Push to GitHub only (webhook deploys automatically, ~5s)
.\git-push.ps1 -m "update CSS colours"
```

### Editing directly on the server (quick fix)

```bash
# Edit files in /opt/nettools/subnet/
nano /opt/nettools/subnet/index.html

# Sync back to GitHub so Windows stays up to date
cd /opt/nettools
git add -A
git commit -m "hotfix from server"
git push origin main

# Pull changes back to Windows later
cd $HOME\Projects\nettools
git pull
```

### Adding a new tool module

```
$HOME\Projects\nettools\
├── subnet\          ← existing
├── cidr\            ← new module: same structure
│   ├── index.html
│   ├── css\main.css
│   └── js\cidr.js
```

No Dockerfile or compose changes needed — nginx serves all subdirectories automatically.

---

## Reference

### File locations

| What | Where |
|------|-------|
| Local repo (Windows) | `%USERPROFILE%\Projects\nettools\` |
| GitHub | `https://github.com/YOU/nettools` |
| Server repo | `/opt/nettools/` |
| Deploy script | `/usr/local/bin/nettools-deploy` |
| Deploy log | `/var/log/nettools-deploy.log` |
| Webhook config | `/etc/webhook/hooks.json` |
| Webhook port | `9000` |

### Useful server commands

```bash
# View deploy log
tail -50 /var/log/nettools-deploy.log

# Watch webhook in real time
journalctl -fu webhook

# Trigger deploy manually (no GitHub push needed)
/usr/local/bin/nettools-deploy

# Check webhook service status
systemctl status webhook

# Restart webhook
sudo systemctl restart webhook

# View running containers
docker ps

# View container logs
docker logs nettools -f
```

### Useful Windows commands

```powershell
# Check git status
git status
git log --oneline -10

# Pull latest from GitHub (e.g. after editing on server)
git pull

# Undo last commit (keep changes)
git reset HEAD~1

# Check what's different from server
ssh user@server "cd /opt/nettools && git log --oneline -5"
```

### If the webhook stops working

```bash
# 1. Check the service is running
systemctl status webhook

# 2. Check the config is valid JSON
python3 -m json.tool /etc/webhook/hooks.json

# 3. Restart
sudo systemctl restart webhook

# 4. Test the endpoint directly
curl -s http://localhost:9000/hooks/nettools-deploy
# (will return 400 - no signature - but confirms it's listening)
```

### Exposing webhook through a reverse proxy (optional)

If your server is behind nginx already, you can proxy the webhook instead of exposing port 9000 directly:

```nginx
location /webhook/ {
    proxy_pass http://127.0.0.1:9000/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

Then your GitHub webhook URL becomes `https://fwctl.com/webhook/hooks/nettools-deploy` and you don't need port 9000 open publicly.
