# Load — working agreement

Replaces `../fall26-load-local`. Read README.md for the layout.

## Rules that protect Matthew's data

- **Task ids are never derived from titles.** Synced tasks use source keys
  (`bs:<ou>:<type>:<id>`, `mylab:<id>`); hand-made ones `t:<random>`; migrated
  leftovers keep their old `x…` id. Never re-key a task by hand.
- **Edit data only through `shared/ops.js` / the app / the hub.** Every field carries a
  `_t` stamp; hand-editing JSON without stamping breaks merging between devices.
- **Sync (`shared/reconcile.js`) never deletes, never un-ticks, never overrides a field in
  `task.lock`.** A vanished source sets `missing`; a disagreeing date sets `srcDue`.
  Deleted tasks stay in the index so sync never resurrects them. Tests in
  `tests/core.test.js` pin these; keep them passing.
- **`x6e58f3d4b3`** (old shared-title AI survey row) is Matthew's decision. It was
  migrated as-is and excluded from matching (`KEEP_AS_IS` in scripts/migrate.mjs). Don't
  edit it unless he says so.
- The assistant and reviewer only *propose* ops; Matthew applies them.

## Running things

- The hub must run as its own process (LaunchAgent via `hub/install.sh`, or detached).
  Never via preview_start: the desktop app stops preview servers.
- Hub API calls need the header `X-Load: 1`.
- After changing `extension/src` or `shared/collect.js`: `./scripts/build-safari.sh`.
- After changing `app/` or `shared/`: `npm run build` (the hub serves `app/dist`).
- `fixtures/` holds captured Brightspace/MyLab data for tests. It's personal, so it's
  gitignored and never committed or pushed.

## Brightspace facts (checked 2026-11-01)

- LE API 1.100, LP 1.30. Courses: PHYS172 1641950, MA261 REC 1638698 / LEC 1638714,
  ENGT182 1634743, AD227 1625379, Empowered Choices 1134648.
- Calendar EventType 6 = due, 3 = end, 2 = start/available, 1 = plain event.
- Content-topic `DueDateTime` is stale (last year's copy); use tool or calendar dates.
- `content/myItems` `DateCompleted` means submitted for dropbox/quiz/survey doorways and
  viewed for files and links; for LTI (WileyPLUS) it only means opened.
- MyLab: topic 21938619's quickLink → console.pearson.com → navigate the same tab to
  `mylab.pearson.com/api/v1/courses/14285764/links/assignments/launch` → DoAssignments.
