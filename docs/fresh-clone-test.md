# Fresh-clone test

`scripts/fresh-clone-test.sh` clones this repo into a temp dir, with an empty state dir and no `plugins.json`,
runs `pnpm install` and `pnpm build`, starts the production server on port 4868 (`PORT=` to change), and checks `/`,
`/api/status`, `/api/state`, `/api/plugins`, the Host guard and the terminals daemon. It prints PASS/FAIL per check,
exits non-zero on any FAIL, and kills what it started (by PID) and removes the temp dir on exit.
It takes about 3 minutes and never touches your real state or config directories.
