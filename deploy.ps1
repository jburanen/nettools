# deploy.ps1 â€” Quick-push local files to server via SCP,
# then commit + push to GitHub.
# Run from the repo root: .\deploy.ps1
# Optional message:       .\deploy.ps1 -m "fix subnet broadcast"

param(
    [string][Alias('m')]$CommitMsg = "update 2026-06-27 01:50"
)

$SERVER_USER = "github-claude"
$SERVER_HOST = "outbev.table15.dmz"
$SERVER_PATH = "/home/jason/docker-nettools"
$LOCAL_ROOT  = $PSScriptRoot

Write-Host "
>>> SCP push to server..." -ForegroundColor Cyan
scp -r "$LOCAL_ROOT\subnet"       "${SERVER_USER}@${SERVER_HOST}:${SERVER_PATH}/"
scp -r "$LOCAL_ROOT\nginx"        "${SERVER_USER}@${SERVER_HOST}:${SERVER_PATH}/"
scp    "$LOCAL_ROOT\Dockerfile"   "${SERVER_USER}@${SERVER_HOST}:${SERVER_PATH}/"
scp    "$LOCAL_ROOT\docker-compose.yml" "${SERVER_USER}@${SERVER_HOST}:${SERVER_PATH}/"

if ($LASTEXITCODE -ne 0) {
    Write-Host "SCP failed â€” aborting git push." -ForegroundColor Red
    exit 1
}

Write-Host "
>>> Git commit + push to GitHub..." -ForegroundColor Cyan
Set-Location $LOCAL_ROOT
git add -A
git commit -m "$CommitMsg"
git push origin main

Write-Host "
[done] Server updated + GitHub synced." -ForegroundColor Green
