<#
Run this once per computer (after this repo has synced via OneDrive) to make
Claude Code's per-project memory live inside the repo instead of the local
user profile, so it travels with the repo between machines.

It replaces the global memory folder Claude Code looks in with a junction
pointing at <repo>\.claude\memory. That folder is gitignored but still syncs
fine via OneDrive since OneDrive syncs the whole tree regardless of git.
#>

$repoRoot = Split-Path -Parent $PSScriptRoot
$localMem = Join-Path $repoRoot ".claude\memory"

# Mirrors Claude Code's own path->folder-name transform: replace ':', '\' and
# '.' with '-', then lowercase the (now leading) drive letter.
$slug = $repoRoot -replace '[:\\.]', '-'
$slug = $slug.Substring(0,1).ToLower() + $slug.Substring(1)

$globalMem = Join-Path $env:USERPROFILE ".claude\projects\$slug\memory"

New-Item -ItemType Directory -Force -Path $localMem | Out-Null

if (Test-Path $globalMem) {
    $existing = Get-Item $globalMem
    if ($existing.LinkType) {
        Write-Host "Already linked: $globalMem -> $($existing.Target)"
        exit 0
    }
    $hasContent = (Get-ChildItem $globalMem -Force -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0
    if ($hasContent) {
        Write-Warning "Existing memory found at $globalMem - merge it into $localMem by hand, then delete $globalMem and re-run this script."
        exit 1
    }
    Remove-Item -Recurse -Force $globalMem
}

New-Item -ItemType Junction -Path $globalMem -Target $localMem | Out-Null
Write-Host "Linked $globalMem -> $localMem"
