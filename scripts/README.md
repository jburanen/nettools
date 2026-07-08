# scripts/

## link-claude-memory.ps1 / link-claude-memory.sh

Links this machine's global Claude Code memory folder for this project
(`~/.claude/projects/<slug>/memory`) to `.claude/memory/` inside the repo, so
memory travels with the repo via OneDrive instead of staying stuck in one
computer's user profile. `.claude/memory/` is gitignored — OneDrive syncs it
regardless of git status — and these scripts themselves are tracked in git
since they're tooling, not memory content.

**When to run:** once per computer, after this repo has synced via OneDrive
to that machine. Safe to re-run — both scripts detect an existing link and
no-op.

- Windows: `.\scripts\link-claude-memory.ps1`
- Mac/Linux: `./scripts/link-claude-memory.sh`
  - If it can't find a project folder yet, open this repo in Claude Code once
    on that machine first, then re-run.
  - If it finds an existing non-empty memory folder at the target (e.g. from
    using Claude Code on that machine before this setup existed), it stops
    and asks you to merge the contents into `.claude/memory/` by hand, then
    delete the old folder and re-run.

See [.claude/memory/project_portable_workspace_setup.md](../.claude/memory/project_portable_workspace_setup.md)
for the full rationale.
