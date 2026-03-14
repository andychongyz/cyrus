# AGENTS.md

Agent-specific operational guidelines for working in this repository.

## Git & GitHub Workflow

### Fork vs Upstream

This repository is a **fork** of `ceedaragents/cyrus`.

| Remote | Repo | Purpose |
|--------|------|---------|
| `origin` | `andychongyz/cyrus` | **Your fork** — PRs go here |
| `upstream` | `ceedaragents/cyrus` | Upstream project — do NOT open PRs here |

**CRITICAL**: Always create pull requests against `origin` (the fork: `andychongyz/cyrus`), never against `upstream` (`ceedaragents/cyrus`).

Use the `--repo` flag explicitly when creating PRs:

```bash
gh pr create --repo andychongyz/cyrus --base main --head <branch> ...
```
