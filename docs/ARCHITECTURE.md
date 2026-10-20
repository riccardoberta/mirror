# Architecture

```
┌────────────────────────── Electron ───────────────────────────┐
│  renderer (React, src/renderer)      preload (contextBridge)  │
│   setup · pairs · Clone · progress  ◄──── IPC (typed) ────►   │
│                                                               │
│  main process (src/main)                                      │
│   index.ts        window, IPC handlers, single-run guard      │
│   config.ts       config.json (atomic writes)                 │
│   auth.ts         MSAL Node (PKCE, loopback) + safeStorage    │
│   provisioning.ts account identity, root & destination setup  │
│   runController.ts one in-flight run, summaries, hash cache   │
│   log.ts          rotating log with redaction                 │
│                                                               │
│  engine (src/core — pure Node, no Electron)                   │
│   scanner.ts         strict local inventory                   │
│   planner.ts         diff → ordered plan, protections         │
│   executor.ts        folders → moves → uploads → verify →     │
│                      deletes, through a DestinationBackend    │
│   mirror.ts          per-pair orchestration & safety checks   │
│   backend.ts         DestinationBackend contract              │
│   backends/onedrive  Graph: ids, eTags/If-Match, upload       │
│     + graph/client   sessions (resume), Retry-After, 401      │
│   backends/sftp      ssh2: marker, manifest, .part + rename,  │
│     + sftpConnection remote SHA-1 batches, size+mtime guards  │
│   quickxorhash.ts    OneDrive content hash                    │
└───────────────────────────────────────────────────────────────┘
```

## Destination backends

The engine never talks to a service directly: `mirror.ts`/`executor.ts` use the `DestinationBackend`
interface (`src/core/backend.ts`): `verifyDestination`, `list`, optional `fillRemoteHashes`, `mkdir`,
`uploadFile`, `verifyUploads`, `move`, `deleteFile` / `deleteFolder` / `deleteConflicting` with
preconditions, `finalize`, `isQuotaError`. Two implementations:

| | OneDrive (`backends/onedrive.ts`) | Remote disk (`backends/sftp.ts`) |
|---|---|---|
| Addressing | persistent driveItem ids | absolute SFTP paths under a root with a marker file (UUID) |
| Identity check | account id, root id, destination parent + name | host key fingerprint, root exists, marker id, destination exists |
| Content hash | `quickXorHash` from Graph | SHA-1 computed remotely in batches (PowerShell / sha1sum), cached in `.mirror-manifest.json` |
| Upload | PUT < 4 MiB, upload sessions above (10 MiB fragments, resume) | stream to `<name>.mirror-part` (resume from partial), set mtime, atomic rename |
| Deletion guard | `If-Match` eTag; folder `childCount` re-check | size + mtime equality; folder emptiness re-check |
| Quota | 507 | ENOSPC-like errors |

## Run lifecycle (per pair, sequential)

1. **Identity checks** — performed by the backend (see table above). Any mismatch aborts the pair before
   any change.
2. **Local inventory** — recursive `readdir`/`lstat`; any enumeration failure aborts the pair. Items that
   cannot be mirrored become *problems* (never silent).
3. **Remote inventory** — complete listing by the backend (OneDrive: BFS over `children?$top=200`
   following every `@odata.nextLink`, packages not descended into; SFTP: recursive `readdir`, manifest
   hashes attached where size+mtime still match).
4. **Hashing** — only files whose decision depends on content (same path & size, or rename candidates)
   are hashed: remotely in batches where the backend can (SFTP), locally with a size+mtime+inode cache.
5. **Plan** — `replaceType → mkdir (shallow first) → move → upload → deleteFile → deleteFolder (deep first)`.
   Problem paths and their ancestors are protected from deletion. Empty-source guard.
6. **Execute** — uploads with bounded concurrency through the backend; a verification phase compares
   size and hash of everything uploaded. Deletions only when all copies succeeded and verified and the
   run was not cancelled, each with the backend's precondition; folders re-checked empty. Final local
   re-scan detects concurrent changes.
7. **Report** — per-pair outcome (`completed`, `completedWithWarnings`, `incomplete`, `aborted`,
   `cancelled`), issues with stable codes, counters; persisted as last attempt / last success.

## Manual-only guarantee

The only code path that starts a run is the IPC handler for the renderer's **Clone** button
(`IPC.startClone`). There are no file watchers, timers, launch-time or network-event hooks; the
`RunController` refuses a second concurrent run. Closing the window on macOS leaves a running Clone
to finish (or cancel from the dock/quit); re-opening never restarts it.

## Persistence

- `config.json` — settings, account (`userId`, `driveId`), OneDrive root (`id`, `name`), remote disk
  (host, user, key path, root path, marker `rootId`, host key fingerprint, passphrase encrypted with
  `safeStorage`), pairs (`sourcePath`, `target`, `destinationId`, `destinationName`, enabled, last
  attempt/success), acknowledgement, last run summary.
- `msal-cache.bin` — MSAL token cache encrypted with `safeStorage` (Keychain-backed on macOS).
- On the remote disk: `.mirror-destination.json` in the root (identity marker) and
  `.mirror-manifest.json` in each destination (hash cache).
- `hash-cache.json` — local content hashes keyed by path (size, mtime, inode).
- `logs/mirror-YYYY-MM-DD.log` — 14 days kept; tokens never logged (and redacted defensively).

Mirror is not sandboxed, so macOS security-scoped bookmarks are unnecessary: the app accesses the
chosen folders directly; macOS asks once (TCC) for protected locations such as Desktop, Documents,
Downloads and removable volumes, and remembers the answer.

## Why these choices

- **Electron + TypeScript**: a single code base for macOS/Windows/Linux, fully testable in CI without a Mac.
- **MSAL Node** rather than hand-rolled OAuth: official library, PKCE and loopback handled correctly,
  token refresh and cache serialization built in.
- **QuickXorHash** rather than size/mtime: the only content hash OneDrive for Business exposes; verified
  against published vectors.
- **ID-based addressing** (`/drives/{driveId}/items/{itemId}`) rather than paths: persistent identities
  make it possible to detect moved/renamed destinations and refuse to run.
- **SFTP over the built-in Windows OpenSSH server** rather than SMB mounts or an agent: nothing to install
  on the remote PC, robust to Tailscale hiccups (one guarded connection per pair, resumable `.part`
  uploads), and hashes computed where the data lives so verification costs one command, not a download.
