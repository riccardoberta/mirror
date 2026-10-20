# Mirror

**Mirror** keeps copies of selected folders from your Mac (or Windows/Linux PC) on your existing
**OneDrive** and/or on a **remote disk** (for example an external drive attached to an always-on
Windows PC, reached through Tailscale), as plain files and folders, and makes them identical to the
originals every time you press **Clone** — and only then. It talks to Microsoft Graph and to the
built-in Windows OpenSSH server directly: no OneDrive client, no rclone, no third-party sync or backup
engine, nothing to install on the remote PC.

| | |
|---|---|
| **Direction** | One way, local → cloud. The local folder is always authoritative. |
| **Trigger** | Manual only. Nothing runs at launch, at login, on file changes, when the network comes back, or on a schedule. |
| **Result on OneDrive** | Ordinary files and folders, browsable on the OneDrive website. No archives, no proprietary formats, no encrypted containers. |
| **Destinations** | OneDrive (Microsoft Graph) and/or a remote disk over SSH/SFTP (Windows OpenSSH Server, Linux, NAS). Chosen per folder. |
| **Scope of deletions** | Only inside the destination folders Mirror manages, all under one root folder per destination that you choose (for example `Mirror` on OneDrive, `D:\Mirror` on the remote disk). |
| **Platforms** | macOS (primary), Windows, Linux — Electron + TypeScript. |

---

## Table of contents

1. [How it works](#how-it-works)
2. [Requirements](#requirements)
3. [Install and run](#install-and-run)
4. [First configuration](#first-configuration)
5. [Everyday use](#everyday-use)
6. [Outcomes and what they mean](#outcomes-and-what-they-mean)
7. [Safety rules](#safety-rules)
8. [What is and is not mirrored](#what-is-and-is-not-mirrored)
9. [Settings](#settings)
10. [Testing](#testing)
11. [Troubleshooting](#troubleshooting)
12. [Project layout and development](#project-layout-and-development)
13. [Data locations and privacy](#data-locations-and-privacy)

---

## How it works

For every enabled pair *local folder → OneDrive folder*, a Clone run does the following, in order:

1. **Checks identities.** OneDrive: the signed-in Microsoft account must be the one Mirror was
   configured with; the root folder must exist and must not be the OneDrive root; the destination must
   still exist, be a folder, be a direct child of the root and keep its configured name. Remote disk:
   the server must present the recorded host key, the root folder must exist and carry the marker file
   with the expected id (so an unplugged disk or a different machine is never mistaken for an empty
   destination), and the destination folder must exist. If anything differs, the pair is skipped and
   nothing is touched.
2. **Takes a complete local inventory.** Every file and sub-folder is listed (including empty folders
   and hidden files). If any folder cannot be listed — missing source, unmounted disk, permission denied,
   I/O error — the pair is aborted before any cloud change. A partial listing is never treated as
   "the files are gone".
3. **Takes a complete remote inventory** of the destination, following every page of the Graph API.
4. **Compares contents** by hash and size: OneDrive's `quickXorHash`, or SHA-1 computed on the remote
   machine (PowerShell `Get-FileHash` / `sha1sum`) and cached in a manifest inside the destination.
   Local hashes are cached by size, modification time and inode so unchanged files are not re-read.
5. **Builds a plan**: create folders → move/rename files whose content already exists → upload new and
   changed files → delete what no longer exists locally (files first, then folders bottom-up).
6. **Executes the plan**, verifying every upload by size and hash. Deletions run **only if every copy
   succeeded** and the run was not cancelled, each guarded by a precondition (`If-Match` eTag on
   OneDrive, size + modification time on the remote disk) so an item changed at the destination in the
   meantime is never deleted blindly.
7. **Re-scans the source** to detect files that changed while it was running and reports the run as
   *Incomplete* in that case.

Details: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Requirements

- **Node.js 20 or newer** — <https://nodejs.org> (LTS). Everything else is installed by `npm install`.
- For **OneDrive**: a Microsoft Entra app registration (one-time, free, no publishing). Mirror uses the official
  Microsoft Authentication Library (MSAL) with OAuth 2.0 + PKCE in your system browser and has no
  client secret; you only paste the *Application (client) ID* into Settings. Step-by-step guide for
  work/school accounts (including the case where your organisation restricts app registrations) and
  personal accounts: [`docs/ENTRA_APP_REGISTRATION.md`](docs/ENTRA_APP_REGISTRATION.md).
- Delegated Graph permissions requested: `Files.ReadWrite` (your own files only — not `.All`),
  `User.Read`, `offline_access`.
- For a **remote disk**: SSH access with a key to the machine the disk is attached to. For a Windows
  11 PC this is the built-in *OpenSSH Server* feature (ten-minute setup, including Tailscale and a
  firewall rule limited to the tailnet): [`docs/REMOTE_DISK_SFTP.md`](docs/REMOTE_DISK_SFTP.md).

## Install and run

```bash
cd Mirror
npm install          # first time only: downloads Electron and the dependencies
npm run dev          # starts the app in development mode
```

To get a regular, double-clickable application:

```bash
npm run dist:mac     # → dist/Mirror-<version>-<arch>.dmg and dist/mac*/Mirror.app
npm run dist:win     # → dist/Mirror Setup <version>.exe
npm run dist:linux   # → dist/Mirror-<version>.AppImage
```

The build is unsigned (nothing is published or notarised). On macOS, open it the first time with
right-click → **Open**, or run `xattr -dr com.apple.quarantine dist/mac*/Mirror.app`.

## First configuration

The setup screen has two steps; none of them transfers any file. Configure one destination or both.

1. **Choose at least one destination.**
   - *OneDrive*: paste the *Application (client) ID* and the tenant (`organizations` for any
     work/school account, your tenant domain such as `unige.it`, `consumers` for a personal account),
     press **Connect OneDrive** (browser sign-in), then create or pick the **root folder** (default
     `Mirror`). The OneDrive root itself cannot be chosen.
   - *Remote disk*: enter host (Tailscale name or IP), user, private key file, root folder (e.g.
     `D:\Mirror`) and the remote hash command; press **Test connection** (records the server's host
     key) and **Set up root folder** (creates the folder and its marker file).
2. **Add folders** — select one or more folders from your Mac with the native file dialog; when both
   destinations are configured, choose where the folders go. Each gets a destination folder with the
   same name inside the root (rename with *Edit*; names must be unique per destination,
   case-insensitively). You can add, rename, disable or remove pairs at any time.

Before the first Clone, the main screen shows a warning explaining that **destinations will be made
identical to your folders, including deletions**, with a checkbox to confirm. You are asked again only
if the account, the root folder or a destination changes — never on every run.

## Everyday use

Open Mirror → press **Clone** → wait.

The main screen shows:

- the connected account and the root folder;
- the list of pairs (`source path → OneDrive / Remote disk / destination name`), each with an on/off
  switch and the date and outcome of its last attempt and last successful completion;
- the big **Clone** button (runs all enabled pairs, one after the other);
- during a run: the current phase, the current file, byte progress for uploads, and a **Cancel** button;
- the date and outcome of the **last attempt** and of the **last completed** run;
- **Details** (every issue of the last run with the affected path) and **Settings** (gear icon).

Only one run can be active at a time. Cancelling, quitting or relaunching never resumes a run: the next
one starts only when you press Clone again. Retries and resumed uploads happen only inside a run you
started.

## Outcomes and what they mean

| Outcome | Meaning |
|---|---|
| **Completed** | Every enabled pair was mirrored and verified; no divergences remain. |
| **Completed with warnings** | Same, with non-blocking notes (e.g. a name that differs from OneDrive only by case). |
| **Incomplete** | Something could not be mirrored: an upload failed, an item is not representable on OneDrive (symlink, invalid name, …), an item changed on OneDrive or locally during the run. Deletions are skipped for any pair whose copies failed. Fix the cause and run Clone again. |
| **Skipped (not safe to run)** | The pair was not touched at all: source missing/unreadable/not a folder, source empty while the destination is not, or destination moved/renamed/deleted on OneDrive. |
| **Cancelled** | You pressed Cancel. No deletion is executed after a cancellation. |
| **Failed** | The run could not start (not signed in, token expired, account mismatch). |

Mirror never reports *Completed* while errors or divergences remain.

## Safety rules

- **Local files are never modified or deleted.** Sources are only read.
- **Deletions are confined** to the configured destinations, which are addressed by persistent
  identities (OneDrive item IDs; on the remote disk the root marker id plus the folder name) and
  re-verified before every run. The OneDrive root and a drive root are never destinations. Overlapping
  destinations and duplicate names between pairs are rejected.
- **Removing a pair, renaming a destination or changing the root never deletes the old cloud folder.**
- **Complete inventory before any change.** All API pages are read; the plan is built before the first
  write. A missing folder, an unmounted disk, a permission error or a partial listing abort the pair.
- **An empty source never silently wipes a destination** (configurable in Settings for the rare case
  where that is what you want).
- **Copies first, then verification, then deletions.** Deletions run only if every copy succeeded;
  each is guarded by a precondition (eTag / size + mtime) and folders are re-checked to be empty right
  before deletion. On the remote disk uploads are written to a `.mirror-part` file and renamed over the
  target, so a half-written file never replaces a good one.
- **Concurrent changes are detected**, not overwritten blindly: remote items changed after the inventory
  are left in place and reported; local files changed during the run make the run *Incomplete*.
- **No atomicity is promised** for the whole run; an interrupted run leaves a mixture of old and new
  state that the next Clone converges again.
- **Resilience**: exponential backoff honouring `Retry-After` (429/5xx), token refresh on 401,
  resumable upload sessions for large files (10 MiB fragments), a clear stop when OneDrive storage is
  full (507).
- **Credentials** (MSAL token cache, SSH key passphrase) are encrypted with Electron `safeStorage`
  (macOS Keychain, Windows DPAPI, Linux libsecret) and never written to logs. The SSH server's host key
  fingerprint is recorded on first use and enforced afterwards.
- Deleted OneDrive items go to the **OneDrive recycle bin**, from which they can be restored. On the
  remote disk deletions are immediate (no recycle bin).

## What is and is not mirrored

"Mirror" means equality of **relative paths** and **byte contents of regular files**, including empty
sub-folders. Everything below is reported in the run details and never skipped silently; the full
list with the exact behaviour is in [`docs/LIMITS.md`](docs/LIMITS.md).

- **Hidden files** (dotfiles) are mirrored. A short default exclusion list (`.DS_Store`, `.localized`,
  `Icon\r`, `.Trashes`, `.Spotlight-V100`, `.fseventsd`, `.TemporaryItems`, `._*` AppleDouble files,
  `desktop.ini`, `Thumbs.db`, …) is configurable.
- **macOS packages/bundles** (`.app`, `.rtfd`, `.pages`, `.photoslibrary`, …) are mirrored as ordinary
  folders with their inner files.
- **Symbolic links** are not followed and not uploaded (so links pointing outside the source are never
  traversed); their remote path is protected.
- **Names not allowed on OneDrive** (`" * : < > ? / \ |`, control characters, leading/trailing spaces,
  trailing period, reserved names such as `CON`, `.lock`, `desktop.ini`, `~$…`, `_vti_`, names over 255
  characters, full paths over 400 characters) are reported; the item is not mirrored.
- **Case / normalization collisions** (`Report.pdf` and `report.pdf` in the same folder) cannot exist
  on OneDrive: both items are left out and reported.
- **Cloud-only placeholders** (iCloud `.name.icloud`) are reported; download the file first.
- **Not preserved**: extended attributes (Finder tags, comments, quarantine), resource forks, POSIX
  permissions/ownership/flags, ACLs, original timestamps, hard-link identity, bundle semantics.

## Settings

| Setting | Effect |
|---|---|
| Application (client) ID, Tenant | Your Entra app registration. Changing them requires reconnecting. |
| OneDrive root folder | Create or pick another top-level folder; destinations are re-created under it, the old ones are kept, and the mirror warning must be confirmed again. |
| Remote disk | Host, user, port, private key and passphrase, root folder, hash command; *Test connection*, *Set up root folder*, recorded host key (*forget* after reinstalling the remote machine). |
| Excluded names / prefixes | Items not considered part of the source (and therefore removed from destinations). |
| Parallel uploads | 1–8 concurrent uploads (default 3). Lower it if you are throttled often. |
| Allow an empty source to empty its destination | Off by default. |
| Open log folder | Daily log files (14 days kept), tokens never logged. |
| Disconnect | Signs out and deletes the token cache; configuration is kept. |

## Testing

```bash
npm test                # simulated: 79 Vitest tests (in-memory Graph model, local HTTP stub, in-process SFTP server)
npm run typecheck       # TypeScript, main + renderer
npm run test:real       # REAL OneDrive test with your account, inside a dedicated "Mirror-Test-<timestamp>" root
npm run test:real:sftp  # REAL remote-disk test against your machine, inside "<root>\Mirror-Test-<timestamp>"
```

The simulated suite covers first copy, identical-file skipping, update (same size, different bytes),
deletion order, rename/move via PATCH with fallback, empty folders, API paging, missing/unreadable/
empty source, destination moved or renamed, account mismatch, network errors and retries, `Retry-After`
throttling, `If-Match` divergences, local changes during the run, cancellation, quota exhaustion,
symlinks and invalid names, preservation of files outside the destinations, resumable upload sessions
and the `quickXorHash` implementation (59 published vectors).

The SFTP suite runs the backend over the real SFTP protocol against an in-process ssh2 server that
emulates a Windows OpenSSH host (paths, rename semantics, the PowerShell hashing command).

The real tests exercise the same engine against Microsoft Graph, respectively your remote machine, in
a freshly created test folder and a temporary local folder, check sentinel items outside the
destination at every step, write a `real-test…-report-<timestamp>.md` and delete the test folder at
the end (`--keep` to retain it). They have to be run by you with your account/machine; see
[`docs/TESTING.md`](docs/TESTING.md) for the exact scenarios and the distinction between simulated
and real results.

## Troubleshooting

| Symptom | What to do |
|---|---|
| "No Application (client) ID configured" | Complete the app registration guide and paste the ID in Settings. |
| Browser shows an `AADSTS…` error during sign-in | See the table in `docs/ENTRA_APP_REGISTRATION.md` (redirect URI `http://localhost`, public client flows, tenant, admin consent). |
| "Your Microsoft sign-in has expired" | Settings → Disconnect, then Connect OneDrive again; the configuration is kept. |
| A pair is *Skipped (not safe to run)* | Read the message in Details: reconnect the disk, fix permissions, or edit the pair if its destination was moved or renamed on OneDrive. |
| Run is *Incomplete* with `remote.changed` | Someone edited the item on OneDrive after the inventory; the next Clone re-evaluates it. |
| Run is *Incomplete* with `local.changedDuringRun` | Files changed while Mirror was running; run Clone again. |
| macOS asks for permission to access Documents/Desktop/removable volumes | Grant it once; Mirror only reads the folders you selected. |
| Slow or throttled (`429`) | Lower *Parallel uploads* in Settings; Mirror already waits the time OneDrive asks for. |
| Remote disk: timeout, authentication failed, host key mismatch, hashing failed | See the troubleshooting table in `docs/REMOTE_DISK_SFTP.md`. |

## Project layout and development

```
src/core      engine (platform-independent, fully tested): scanner, planner, executor, orchestration,
              destination backends (OneDrive via Graph client, remote disk via SFTP), QuickXorHash
src/main      Electron main process: config store, MSAL auth + safeStorage, provisioning, IPC,
              single-run controller, logging
src/preload   typed contextBridge API
src/renderer  React UI (setup, main screen, settings, details)
src/shared    IPC types shared by main and renderer
tests         Vitest suites + fake Graph backend (tests/fakeGraph.ts)
scripts       real-test.ts / real-test-sftp.ts — real verification against OneDrive / your remote machine
docs          ARCHITECTURE, ENTRA_APP_REGISTRATION, REMOTE_DISK_SFTP, LIMITS, TESTING
```

Useful scripts: `npm run dev` (hot reload), `npm run build` (bundle to `out/`), `npm start` (run the
bundle), `npm test`, `npm run test:watch`, `npm run typecheck`, `npm run dist:*`.

Design notes: the engine never imports Electron, so it runs in plain Node for tests and for the real
test script; all cloud addressing uses `/drives/{driveId}/items/{itemId}` with persistent IDs; the only
code path that starts a run is the IPC handler behind the Clone button.

## Data locations and privacy

On macOS everything lives in `~/Library/Application Support/Mirror/`
(`%APPDATA%\Mirror` on Windows, `~/.config/Mirror` on Linux):

| File | Content |
|---|---|
| `config.json` | Settings, account identity (user and drive IDs), root and destination IDs, remote-disk settings (host key fingerprint, root marker id, passphrase encrypted), pairs, last outcomes. |
| `msal-cache.bin` | MSAL token cache, encrypted with the OS key store. Removed on Disconnect. |
| `hash-cache.json` | Local content hashes keyed by path, size, mtime and inode. Safe to delete (slower next run). |
| `logs/` | Daily logs, 14 days, with token redaction. |

Mirror contacts only `login.microsoftonline.com` (sign-in), `graph.microsoft.com` plus the upload URLs
it returns, and the SSH host you configure. No telemetry, no third-party services.

## License

MIT.
