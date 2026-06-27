# =============================================================
# init-repo.ps1
# Run once on your Windows machine to create the local repo
# folder structure and wire up git + GitHub remote.
#
# Usage:
#   1. Edit the CONFIG block below
#   2. Open PowerShell (not as admin)
#   3. .\init-repo.ps1
# =============================================================

# ── CONFIG — edit these ──────────────────────────────────────
$GITHUB_USER   = "jburanen"
$GITHUB_REPO   = "nettools"           # repo name on GitHub
$LOCAL_ROOT    = "$HOME\OneDrive\Github\nettools"  # where to create on Windows
$SERVER_USER   = "github-claude"
$SERVER_HOST   = "outbev.table15.dmz"
$SERVER_PATH   = "/home/jason/docker-nettools"      # deployment path on server
# ─────────────────────────────────────────────────────────────

Write-Host "`n[1/6] Creating folder structure..." -ForegroundColor Cyan

$folders = @(
    "$LOCAL_ROOT",
    "$LOCAL_ROOT\nginx",
    "$LOCAL_ROOT\subnet\css",
    "$LOCAL_ROOT\subnet\js"
    # Add future modules here, e.g.:
    # "$LOCAL_ROOT\cidr\css"
    # "$LOCAL_ROOT\cidr\js"
)

foreach ($f in $folders) {
    if (-not (Test-Path $f)) {
        New-Item -ItemType Directory -Path $f -Force | Out-Null
        Write-Host "  created: $f" -ForegroundColor Gray
    } else {
        Write-Host "  exists:  $f" -ForegroundColor DarkGray
    }
}

# ── .gitignore ───────────────────────────────────────────────
Write-Host "`n[2/6] Writing .gitignore..." -ForegroundColor Cyan
@"
# OS
.DS_Store
Thumbs.db
desktop.ini

# Editor
.vscode/settings.json
*.swp
*~

# Secrets — never commit these
*.pem
*.key
.env
secrets/
"@ | Set-Content "$LOCAL_ROOT\.gitignore" -Encoding UTF8

# ── deploy.ps1 (SCP quick-push) ──────────────────────────────
Write-Host "`n[3/6] Writing deploy.ps1 (SCP push script)..." -ForegroundColor Cyan
@"
# deploy.ps1 — Quick-push local files to server via SCP,
# then commit + push to GitHub.
# Run from the repo root: .\deploy.ps1
# Optional message:       .\deploy.ps1 -m "fix subnet broadcast"

param(
    [string][Alias('m')]`$CommitMsg = "update $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
)

`$SERVER_USER = "$SERVER_USER"
`$SERVER_HOST = "$SERVER_HOST"
`$SERVER_PATH = "$SERVER_PATH"
`$LOCAL_ROOT  = `$PSScriptRoot

Write-Host "`n>>> SCP push to server..." -ForegroundColor Cyan
scp -r "`$LOCAL_ROOT\subnet"       "`${SERVER_USER}@`${SERVER_HOST}:`${SERVER_PATH}/"
scp -r "`$LOCAL_ROOT\nginx"        "`${SERVER_USER}@`${SERVER_HOST}:`${SERVER_PATH}/"
scp    "`$LOCAL_ROOT\Dockerfile"   "`${SERVER_USER}@`${SERVER_HOST}:`${SERVER_PATH}/"
scp    "`$LOCAL_ROOT\docker-compose.yml" "`${SERVER_USER}@`${SERVER_HOST}:`${SERVER_PATH}/"

if (`$LASTEXITCODE -ne 0) {
    Write-Host "SCP failed — aborting git push." -ForegroundColor Red
    exit 1
}

Write-Host "`n>>> Git commit + push to GitHub..." -ForegroundColor Cyan
Set-Location `$LOCAL_ROOT
git add -A
git commit -m "`$CommitMsg"
git push origin main

Write-Host "`n[done] Server updated + GitHub synced." -ForegroundColor Green
"@ | Set-Content "$LOCAL_ROOT\deploy.ps1" -Encoding UTF8

# ── git-only.ps1 (commit to GitHub without SCP) ──────────────
Write-Host "`n[4/6] Writing git-push.ps1..." -ForegroundColor Cyan
@"
# git-push.ps1 — Commit and push to GitHub only (no SCP).
# Server will auto-pull via webhook.
# Usage: .\git-push.ps1 -m "your message"

param(
    [string][Alias('m')]`$CommitMsg = "update $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
)

Set-Location `$PSScriptRoot
git add -A
git commit -m "`$CommitMsg"
git push origin main

Write-Host "[done] Pushed to GitHub. Webhook will deploy to server." -ForegroundColor Green
"@ | Set-Content "$LOCAL_ROOT\git-push.ps1" -Encoding UTF8

# ── Init git repo ─────────────────────────────────────────────
Write-Host "`n[5/6] Initialising git repository..." -ForegroundColor Cyan
Set-Location $LOCAL_ROOT

if (-not (Test-Path "$LOCAL_ROOT\.git")) {
    git init
    git branch -M main
    Write-Host "  git init done" -ForegroundColor Gray
} else {
    Write-Host "  git repo already exists, skipping init" -ForegroundColor DarkGray
}

$remoteExists = git remote | Select-String "origin"
if (-not $remoteExists) {
    git remote add origin "https://github.com/$GITHUB_USER/$GITHUB_REPO.git"
    Write-Host "  remote 'origin' added -> https://github.com/$GITHUB_USER/$GITHUB_REPO.git" -ForegroundColor Gray
} else {
    Write-Host "  remote 'origin' already set" -ForegroundColor DarkGray
}

# ── Summary ───────────────────────────────────────────────────
Write-Host "`n[6/6] Done." -ForegroundColor Green
Write-Host @"

  Local repo  : $LOCAL_ROOT
  GitHub      : https://github.com/$GITHUB_USER/$GITHUB_REPO
  Server      : ${SERVER_USER}@${SERVER_HOST}:${SERVER_PATH}

Next steps:
  1. Create the GitHub repo at https://github.com/new
     Name: $GITHUB_REPO  |  Private or Public  |  NO readme/gitignore (we have one)

  2. Copy your project files into:
       $LOCAL_ROOT\subnet\
       $LOCAL_ROOT\nginx\
       $LOCAL_ROOT\Dockerfile
       $LOCAL_ROOT\docker-compose.yml

  3. First push:
       cd $LOCAL_ROOT
       git add -A
       git commit -m "initial commit"
       git push -u origin main

  4. Run server-setup.sh on your Ubuntu host (see docs\SETUP.md)

  Workflow going forward:
    Quick edit + SCP  ->  .\deploy.ps1 -m "what changed"
    GitHub-only push  ->  .\git-push.ps1 -m "what changed"
"@
