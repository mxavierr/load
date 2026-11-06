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
  It also never ticks a task with tracked time (`opts.tracked`): a MyLab score only means
  the lesson was started. Deleted tasks stay in the index so sync never resurrects them. Tests in
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

- `GET /d2l/api/le/1.100/<ou>/grades/` and `/grades/categories/` are readable as a student:
  they give each item's weight, max points and category, and each category's weight and drops.

## How sync stays reliable (`extension/src/background.js`)

- Always read through a fresh hidden tab. Never reuse an open Brightspace tab: its session can
  be expired, and rebuilding the extension orphans its content script, which then answers
  nothing. **A reply of `undefined` is not an answer**; check for `{ ok: true }`.
- Don't reload or navigate the waiting sign-in tab (`signinTab`): someone may be typing in it.
- Never enter or store credentials. A person signs in; the extension only notices and resumes.
- Brightspace is saved before MyLab starts. A snapshot with `courses: []` is MyLab-only and must
  not move `lastSync`.
- Safari can stop the background page at any time, and timers die with it. `run` in storage
  is the record that lets the next start clean up.
- Rebuilding the extension breaks existing tabs' scripts, which fresh tabs make harmless.
- Anything written to a data file must be stamped, including `library`. Unstamped fields tie on
  merge, and a tie compares the text, so older data can win forever (this froze grades until 2026-11-06).

## Grades

- Course rules live in `GRADING` in `shared/grades.js`, one entry per course. Update it each term.
- What-ifs are in `db.grading[course].whatIf`. Real grades come from the library and are never edited.

## Testing

- `npm test`: unit tests. They cover saving from two devices, the planner, quick add,
  edits and locks, sync safety, the checks, and the extension's scheduling, matching and
  sessions. Reconcile tests also run against captured Brightspace data when
  `fixtures/` exists.
- **Never test against the live data.** For a throwaway hub, run
  `LOAD_HOME=<scratch dir> node hub/server.mjs` with a `config.json` containing
  `{"mode":"local","port":8799,"repo":"test/load-data"}` and a copy of the data in
  `<scratch>/data`.
- Phone path without a real token: open `http://127.0.0.1:8799/?remote` and set
  localStorage `load:v1:gh` to `{token, repo, api}`, where `api` points at a local fake
  contents API.
- Extension end to end: `node tests/ext-harness.mjs <hub url> fixtures/snap-live.json fixtures/mylab-snap.json`
  runs the built `extension/dist/background.js` against a simulated Safari API.
- Sync failure modes: `node tests/ext-scenarios.mjs <hub url> fixtures/snap-live.json fixtures/mylab-snap.json`
  (signed out, silent renewal, dead tab, background shutdown, save retry, MyLab failure).
