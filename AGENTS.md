# Agent instructions

## Agent skills

### Issue tracker

Issues and specs for this repo live in GitHub Issues; use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default five triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository with a root `CONTEXT.md` and ADRs under `docs/adr/`. See `docs/agents/domain.md`.

### Review

For code review and re-review, fix the baseline and target commits and explicitly account for working-tree changes. See `docs/agents/review.md`.

### Releases

When delivering extension changes, publish an updated GitHub Release. Increment the third version component for each release, starting with `v0.3.1`, and keep the manifest version, Git tag, Release title, and ZIP asset name aligned. The ZIP must contain the built `dist/` directory.

For release preparation, artifact verification, and relay deployment, read `docs/agents/releases.md` and `docs/sponsored-trial-deployment.md`.
