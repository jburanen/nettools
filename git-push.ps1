# git-push.ps1 â€” Commit and push to GitHub only (no SCP).
# Server will auto-pull via webhook.
# Usage: .\git-push.ps1 -m "your message"

param(
    [string][Alias('m')]$CommitMsg = "update 2026-06-27 01:50"
)

Set-Location $PSScriptRoot
git add -A
git commit -m "$CommitMsg"
git push origin main

Write-Host "[done] Pushed to GitHub. Webhook will deploy to server." -ForegroundColor Green
