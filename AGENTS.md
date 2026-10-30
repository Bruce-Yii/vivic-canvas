# Project Instructions

## Scope and context

- These instructions apply to this repository unless a nearer `AGENTS.md` or `AGENTS.override.md` is more specific.
- Read `README.md`, `project.json`, and relevant documents before substantive edits.
- Keep this file short and accurate; record detailed architecture in `docs/`.

## Working agreement

- Inspect Git status first and preserve unrelated user work.
- Keep project-private files inside this repository; do not depend on sibling project paths.
- Put disposable intermediate artifacts in `work/` and final user-facing artifacts in `outputs/`.
- Never commit credentials, tokens, cookies, private keys, or sensitive production data.
- Do not edit generated files when their source can be changed instead.
- For difficult work, write an execution plan using `docs/EXECUTION-PLAN-TEMPLATE.md`.

## Verification

- Use the actual commands declared in `project.json`; do not guess commands from language alone.
- Run the narrowest relevant checks first, then broader checks when warranted.
- Open, render, or execute final artifacts as appropriate instead of validating only file existence.
- Report checks that actually ran, failures, and anything that remains unverified.

## Durable learning

- Before substantive work, recall relevant project memory and inspect existing decisions, postmortems, tests, and runbooks. Treat current code and versioned docs as authoritative when memory is stale.
- After a nontrivial verified task, decide whether anything is worth retaining. Put project-specific decisions in `docs/decisions/`, failures and recoveries in `docs/postmortems/`, executable guarantees in tests, and repeated mandatory behavior in this `AGENTS.md`.
- Store a concise persistent memory only for a durable correction, decision, baseline, preference, or hard-won fix; update an existing key when correcting it. Never store secrets, raw logs, speculation, or temporary task progress.
- A worktree and its chat are execution state, not the sole record. Preserve durable code and learning in tracked project files before Handoff, archive, or cleanup.
- Cross-project promotion belongs to the parent workspace's governed knowledge process; do not create hidden dependencies on sibling repositories.
