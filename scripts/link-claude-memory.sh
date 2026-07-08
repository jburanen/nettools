#!/usr/bin/env bash
# macOS/Linux sibling of link-claude-memory.ps1 — see that file for the full
# explanation. Run this once per computer (after this repo has synced via
# OneDrive) to make Claude Code's per-project memory live inside the repo
# instead of the local user profile, so it travels with the repo between
# machines.
#
# It replaces the global memory folder Claude Code looks in with a symlink
# pointing at <repo>/.claude/memory. That folder is gitignored but still
# syncs fine via OneDrive since OneDrive syncs the whole tree regardless of
# git.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "$script_dir/.." && pwd -P)"
local_mem="$repo_root/.claude/memory"
mkdir -p "$local_mem"

projects_dir="$HOME/.claude/projects"

# Best-effort mirror of Claude Code's path->folder-name transform: replace
# path separators and dots with '-'. (The Windows version also lowercases a
# leading drive letter; POSIX paths have none.)
slug="$(printf '%s' "$repo_root" | sed -e 's/[\/.]/-/g')"
global_mem="$projects_dir/$slug/memory"

# Fallback in case the guessed slug is off: look for a project folder whose
# session transcripts already reference this repo path.
if [ ! -d "$projects_dir/$slug" ] && [ -d "$projects_dir" ]; then
    match="$(grep -Rl -F "\"cwd\":\"$repo_root\"" "$projects_dir" --include='*.jsonl' 2>/dev/null | head -n1 || true)"
    if [ -n "$match" ]; then
        slug="$(basename "$(dirname "$match")")"
        global_mem="$projects_dir/$slug/memory"
    fi
fi

if [ ! -d "$projects_dir/$slug" ]; then
    echo "No Claude Code project folder found for $repo_root yet." >&2
    echo "Open this repo in Claude Code once on this machine, then re-run this script." >&2
    exit 1
fi

if [ -L "$global_mem" ]; then
    echo "Already linked: $global_mem -> $(readlink "$global_mem")"
    exit 0
fi

if [ -e "$global_mem" ]; then
    if [ -n "$(ls -A "$global_mem" 2>/dev/null)" ]; then
        echo "Existing memory found at $global_mem - merge it into $local_mem by hand, then delete $global_mem and re-run this script." >&2
        exit 1
    fi
    rm -rf "$global_mem"
fi

ln -s "$local_mem" "$global_mem"
echo "Linked $global_mem -> $local_mem"
