# Testing

Two clearly separated levels.

## 1. Simulated tests (automated, `npm test`)

Run with Vitest against two simulated destinations:

- **`tests/fakeGraph.ts`** — an in-memory model of the Graph endpoints Mirror uses (items, paging with
  `@odata.nextLink`, `conflictBehavior`, eTags/`If-Match` → 412, upload sessions with
  `Content-Range`/`nextExpectedRanges`, quota → 507, injected 429/503/network faults);
- **`tests/sftpServer.ts`** — a real SSH/SFTP server started in-process with `ssh2` over a temporary
  directory, emulating a Windows OpenSSH host (`/D:/…` paths, rename refuses existing targets, the
  PowerShell `Get-FileHash` command and `sha1sum` are emulated, faults such as dropped connections,
  missing hash tool, rejected authentication).

Local folders are real temporary directories. These tests were executed during development
(79 passing, 1 skipped when running as root).

| Requirement | Test |
|---|---|
| First copy (files, sub-folders, empty folders) | `mirror.test.ts` › first copy |
| Identical files skipped | second run no-op; large identical file skipped |
| Update (same size, different content) | update |
| Deletion (files then folders, bottom-up) | delete; `planner.test.ts` › deletions |
| Rename / move (PATCH, no re-upload; fallback to upload+delete) | rename and move; fallback |
| Empty folders created and removed | first copy / delete |
| Paging | paging (page size 2) |
| Source missing / not a folder / permission denied | safety boundaries; `scanner.test.ts` |
| Empty source does not wipe destination | empty source guard (planner + e2e) |
| Destination moved / renamed on OneDrive | destination moved |
| Account mismatch | refuses to run when the signed-in account differs |
| Network error retried; persistent failure ⇒ no deletions | network errors are retried… |
| Throttling with Retry-After | throttling |
| If-Match on deletions, folder re-check | If-Match…; folder that received new remote content |
| Local changes during the run | local changes during the run… |
| Cancellation | cancellation stops the run… |
| Quota exhausted | quota exhaustion… |
| Symlinks / invalid names / case collisions | `scanner.test.ts`, planner › protected paths, e2e symlink |
| Files outside destinations preserved | sentinels in first copy / delete; pair removal; two pairs |
| Upload sessions, 320 KiB fragments, resume | large files |
| QuickXorHash correctness | `quickxorhash.test.ts` (59 published vectors + streaming) |
| Real HTTP shapes (Content-Length, Content-Range, nextLink, Retry-After) | `http.test.ts` against a local HTTP stub |
| Remote disk: first copy, no-op (manifest), update, delete, rename, adoption of an existing backup (remote hashing), remote edits reverted | `sftp.test.ts` |
| Remote disk safety: missing/mismatched marker, missing root (disk unplugged), missing destination, size+mtime precondition, non-empty folder, interrupted upload resumed via `.mirror-part`, hash tool unavailable, host key mismatch, auth failure, TOFU fingerprint, cancellation | `sftp.test.ts` |

What the simulation cannot prove: OneDrive's exact validation messages, server-side name
normalization, latency/throttling behaviour, hash availability; and, for the remote disk, the real
Windows OpenSSH behaviour (posix-rename support, PowerShell on the SSH session PATH, NTFS timestamps,
Tailscale throughput). That is what the real tests are for.

## 2. Real test on OneDrive (manual, `npm run test:real`)

`scripts/real-test.ts` runs the **same engine** against the **real Microsoft Graph** with your
account, inside a freshly created top-level folder `Mirror-Test-<timestamp>` and a temporary local
folder. It never reads or writes anything else on your OneDrive. Steps performed and checked:

1. first copy (files, nested folders, an empty folder, a 3 MiB file through an upload session);
2. second run performs no transfers;
3. update of a same-size file and of a grown file (exactly 2 uploads);
4. rename + move into a new folder (1 PATCH, 0 uploads);
5. deletion of a subtree;
6. an edit and an extra file made on OneDrive are reverted (Mac authoritative);
7. empty-source guard refuses to wipe the destination;
8. missing source aborts without changes;
9. at every step, sentinel items *outside the destination* (in the test root and in a sibling folder) are verified intact.

It writes `real-test-report-<timestamp>.md` in the project folder, marked as a **real** run, and
deletes the test root (OneDrive recycle bin) unless `--keep` is given.

```bash
# on your Mac, in the project folder
npm install
MIRROR_CLIENT_ID=<your app id> MIRROR_TENANT=organizations npm run test:real
# or, once the app is configured, simply:
npm run test:real
```

The script signs you in through the browser (same MSAL flow as the app) and keeps its token cache in
a private temporary file that is deleted at the end.

## 3. Real test on the remote disk (manual, `npm run test:real:sftp`)

`scripts/real-test-sftp.ts` runs the same engine over SSH/SFTP against **your** machine, inside a
freshly created `Mirror-Test-<timestamp>` folder under the root you pass (with its own marker), and a
temporary local folder. Scenarios: first copy (incl. an empty folder and a 6 MiB file), no-op, update,
rename/move, deletion, remote edits reverted, empty-source guard, missing marker → pair skipped;
sentinels in the test root are verified at every step. It writes `real-test-sftp-report-<timestamp>.md`
and deletes the test folder unless `--keep` is given.

```bash
MIRROR_SFTP_HOST=desktop-pc MIRROR_SFTP_USER=<windows user> MIRROR_SFTP_KEY=~/.ssh/id_ed25519 \
MIRROR_SFTP_ROOT='D:\Mirror' npm run test:real:sftp
```

**Status: neither real test has been executed by the developer** (no OneDrive account and no remote
machine were available in the development environment). Run them once after setting things up; the
reports tell you exactly what passed.

## Manual UI checks

- Launch → nothing happens until **Clone** is pressed (check the log: `Clone started` appears only after the button).
- Press Clone with a destination you renamed on OneDrive → the pair is *Skipped (not safe to run)*.
- Unplug an external disk configured as a source → *source.missing*, destination intact.
- Cancel during upload → *Cancelled*, no deletions, next run converges.
