# Load

Your coursework in one place: Brightspace and MyLab keep it filled in, your phone and
Mac share it, and it learns how long things actually take you.

- **Mac:** http://127.0.0.1:8766 (served by the hub)
- **Phone:** the GitHub Pages address, once it's published (step 4)

## Finish setting up (about 10 minutes)

Some of these steps change system settings or publish to your GitHub account, so they're
left for you.

1. **Keep the hub running.** It's running now, but it won't restart after a reboot until you install it:
   ```bash
   ./hub/install.sh
   ```
2. **Turn on the Safari extension.** Safari › Settings › Extensions › tick **Load**. Then
   click *Edit Websites…* and set **Load** to *Allow* on every website. It needs this to
   read Brightspace and MyLab, and to notice which assignment page you're working on.
3. **Connect the assistant to your Claude plan.** In Terminal, run `claude` once and sign
   in with your Pro account. From then on the command bar and the Check button run on
   your plan, with no API key.
4. **Phone access (GitHub).** Make the private data repo and the app repo, then publish:
   ```bash
   gh repo create mxavierr/load-data --private
   node scripts/publish-data.mjs        # moves your data up, switches the hub to GitHub
   ./hub/install.sh                     # restart the hub in GitHub mode
   gh repo create mxavierr/load --public --source . --push
   gh api -X POST repos/mxavierr/load/pages -f build_type=workflow
   ```
   On the phone, open `https://mxavierr.github.io/load/`, tap Share › *Add to Home
   Screen*, then paste a fine-grained token. To make one: github.com › Settings ›
   Developer settings › Fine-grained tokens. Give it access to **only** `load-data`, with
   *Contents: Read and write*.

## How it works

| Piece | Where | Does |
|---|---|---|
| App | `app/` | One page of blocks you can rearrange: Today, Upcoming, Status, Classes, Insights, Announcements. Click a task to open its side panel. |
| Hub | `hub/` | Background process on the Mac. Serves the app, holds your GitHub login, merges syncs, answers the command bar and runs the checks. |
| Safari extension | `extension/` | Syncs at 8:00 and 18:00 when you're using the Mac (or when you press Sync), and tracks time on assignment pages. |
| Shared core | `shared/` | Data format and merging, the Brightspace reconciler, the quick-add parser, the planner and estimates, and the health checks. |

**Why duplicates are gone.** Each task is keyed by Brightspace's own ids (dropbox, quiz,
survey, content topic, folder), and calendar events and content links are folded into the
item they point at. A placeholder you typed ("HW 21") is merged automatically when the real
item shows up.

**Why nothing slips.** Every sync reads each course's content tree, dropboxes, quizzes,
surveys, calendar and announcements, plus MyLab's list. It doesn't rely on just the calendar feed.

**What sync never does:**
- It never deletes anything. A task that disappears from Brightspace is marked *Not in Brightspace*.
- It never un-ticks a task.
- It never overrides a date or title you edited. If Brightspace disagrees with a date you set, the task shows *Date differs* with a one-tap fix.

**Command bar** (⌘K or /):
- Typing `phys lab report fri 5pm 2h` adds the task immediately.
- A request or question (`push all ENGT labs an hour later`, `what's due before the exam?`) goes to Opus on your plan. You see the proposed changes and tap Apply.
- Tab switches between the two.
- From the phone, requests wait until the Mac is awake.

**Status / Check.** Plain-code checks run all the time: stale sync, sign-out, duplicates,
date conflicts, overdue work, vanished items, and announcements that mention date changes.
The reviewer looks at them after a sync that changed something, and every night at 21:00.
Type into the box next to Check to point it at something specific.

**Time and estimates.**
- The extension logs time while you're active on a page tied to a task. That includes tools you open from it, such as WileyPLUS from a WileyPLUS link.
- You can also press ▶ on any task, on the Mac or phone.
- Estimates come from your own past times on similar work.
- Today's list spreads big work over the days before it's due, within your daily capacity (set it in Settings).

## Commands

```bash
npm test                         # core tests (reconcile runs against captured Brightspace data if present)
npm run build                    # build the app into app/dist (the hub serves it)
./scripts/build-safari.sh        # rebuild + reinstall the Safari extension
./hub/install.sh                 # (re)start the hub at login; --remove to uninstall
tail -f ~/Library/Logs/Load/hub.log
```

Data lives in `~/Library/Application Support/Load/data` (local mode) or the private
`load-data` repo (GitHub mode). Nightly copies go to `…/Load/backups` (90 kept), and in
GitHub mode every save is also a commit.

The old tracker (`../fall26-load-local`) is untouched and its scheduled syncs still run.
Retire it once you're happy with this.
