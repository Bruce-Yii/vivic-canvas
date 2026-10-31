# Backend deployment and rollback

Use the local SSH helpers in the outer `tools/` directory. Authentication stays outside Git. Optional overrides: `VIVIC_SSH_PYTHON` and `VIVIC_SSH_RUNNER`.

```sh
node scripts/deploy-backend.mjs <git-sha>
node scripts/deploy-backend.mjs --rollback
```

The deploy command archives the three runtime source directories from the requested Git commit. It refuses uncommitted runtime-source differences. Deployment scripts and Dockerfile come from this checkout; commit those before normal releases. A3 acceptance used the existing, unchanged baseline source commit while testing these new maintenance scripts.

The server stores the restricted environment file, upload bundles, deployment lock, and `DEPLOYED` record in `/opt/vivic-preview-20261025/backend`. `DEPLOYED` identifies the runtime source commit and image, not the latest documentation commit.

Before switching, the script builds from the locally available current image, copies data into an isolated staging directory, creates a consistent database backup with the application's Node SQLite runtime, boots staging on loopback port 18891, and checks health, imports, and database integrity. The copied process lock is removed only from staging. Production's data directory and lock are not removed by staging cleanup.

After staging passes, the old container stops, the SQLite files are backed up, the old container becomes `vivic-api-prev`, and the new container starts with the original working directory, command, user, port mapping, environment, and data mount. A post-switch failure invokes rollback. Rollback reuses the data directory and does not restore an older database over newer user data.

Only `vivic-api:*` tags are candidates for the three-image retention policy. The original `vivic-preview-20261027:vo-helpmove-1414` baseline is retained. No frontend files or nginx routing are changed by deployment.

On 2026-10-29, unchanged baseline deployment, rollback to the original container, and redeployment passed. The acceptance record is on the server at `backend/acceptance-A3-20261029.json`; see `docs/design/EXECUTION-LOG.md` for results and the first checkpoint.
