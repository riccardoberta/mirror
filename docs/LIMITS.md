# What "mirror" means — and what is not mirrored

Mirror guarantees, after a run that ends as **Completed**, that for every enabled pair the set of
**relative paths** and the **byte content of regular files** on OneDrive equal those of the Mac
folder, including empty sub-folders. Everything else is best-effort or out of scope, as listed below.

## Content comparison

| Situation | Behaviour |
|---|---|
| Same path, different size | Re-uploaded. |
| Same path, same size | OneDrive: local `quickXorHash` compared with `file.hashes.quickXorHash` (the only hash available on OneDrive for Business; also present on personal accounts). Remote disk: SHA-1 computed on the remote machine (cached in `.mirror-manifest.json` by size + mtime). Equal → skipped. |
| The destination reports no hash for a file | Re-uploaded, with a warning (`remote.noHash`). Zero-byte files are considered identical by size. On the remote disk this happens when the hash command is unavailable or set to *None* (`remote.hashingUnavailable`). |
| After each upload | OneDrive: the driveItem returned by Graph is verified (size and `quickXorHash`). Remote disk: the uploaded files are hashed remotely in one batch and compared. A mismatch is an error and prevents deletions. |
| Local hash cache | Hashes are cached per absolute path with size + mtime + inode (`hash-cache.json` in the app's data folder). A changed size/mtime invalidates the entry. The cache never replaces the remote comparison. |

## Items that are **not** representable on OneDrive (reported, never silently skipped)

Each of these produces an **error** in the run details and makes the run *Incomplete*. The
corresponding path on OneDrive (if any) is **protected**: Mirror neither uploads nor deletes it.

| Local item | Handling |
|---|---|
| Symbolic links (files or folders) | Not followed, not uploaded (`local.symlink`). Links pointing outside the source are therefore never traversed. Aliases (Finder) are regular files and are uploaded as the small alias file they are. |
| Sockets, FIFOs, devices | `local.special`. |
| Names with `" * : < > ? / \ |` or control characters, names ending with `.`, with leading/trailing spaces, longer than 255 chars, reserved names (`CON`, `PRN`, `AUX`, `NUL`, `COM0–9`, `LPT0–9`, `.lock`, `desktop.ini`), names starting with `~$` or containing `_vti_` | `local.invalidName`. Folders with invalid names are not descended into. |
| Two siblings whose names differ only by case or Unicode normalization (`Report.pdf` / `report.pdf`, `Café` NFC / NFD) | OneDrive is case-insensitive and cannot hold both: `local.caseCollision`; **both** items (and their subtrees) are left out and their remote paths protected. |
| Full OneDrive path longer than 400 characters | `local.pathTooLong`. |
| iCloud "evicted" placeholders (`.name.icloud`) | `local.cloudPlaceholder` — download the file locally first. Files that are *dataless* in other ways (zero allocated blocks) are read normally; reading triggers the system's on-demand download, and a read failure is reported. |
| Files unreadable at hash time | `local.unreadable`; the remote copy is protected. |

Items that could not be enumerated at all (a sub-folder that cannot be listed, a disconnected disk,
permission denied, I/O error) **abort the whole pair before any cloud change**. A partial local
listing is never treated as "the files were deleted".

## Excluded by default (configurable in Settings)

`.DS_Store`, `.localized`, `Icon\r`, `.Trashes`, `.Spotlight-V100`, `.fseventsd`, `.TemporaryItems`,
`.DocumentRevisions-V100`, `.VolumeIcon.icns`, `.com.apple.timemachine.donotpresent`, `desktop.ini`,
`Thumbs.db`, and names starting with `._` (AppleDouble resource forks). Excluded items are not part of
the source, so a copy of them on OneDrive is removed. Other hidden files (dotfiles) **are** mirrored.

## macOS metadata that is lost

OneDrive stores a byte stream per file; Mirror does not try to encode anything else.

- **Extended attributes** (`com.apple.*`, Finder tags/colours, quarantine flag, custom icons, Spotlight comments) — not mirrored.
- **Resource forks** — not mirrored (`._*` files excluded).
- **POSIX permissions, owner/group, flags** (locked, hidden), **ACLs** — not mirrored.
- **Timestamps** — OneDrive sets its own `lastModifiedDateTime` on upload; creation/modification dates of the Mac files are not preserved.
- **Packages / bundles** (`.app`, `.rtfd`, `.pages`, `.photoslibrary`, …) are directories and are mirrored as ordinary folders with their inner files. They open as folders on the OneDrive website; the Mac bundle semantics (and code signatures that depend on xattrs) are not preserved.
- **Hard links** are uploaded as independent copies. **Sparse files** are uploaded at full logical size.
- **Case-only renames** (`readme.md` → `README.md`) are treated as the same item; a warning is shown and the OneDrive name keeps its previous case.
- **Name normalization**: OneDrive may normalize Unicode names; Mirror matches names case- and normalization-insensitively, so such differences do not cause re-uploads.

## Concurrency and consistency

- Mirror is **not atomic**: a run is a sequence of independent Graph calls. If it is interrupted, the
  destination can hold a mixture of old and new state; the next Clone converges again.
- Order within a pair: type fixes → folders → moves → uploads (+verification) → **deletions last**.
  Deletions run **only if every copy succeeded and the run was not cancelled**; otherwise they are
  skipped and listed (`deletions.skipped`).
- Every deletion is guarded by a precondition: `If-Match` with the eTag seen during inventory on
  OneDrive; size + modification time on the remote disk. An item changed at the destination in the
  meantime is **not** deleted (`remote.changed`) and the run is *Incomplete*; folders are re-checked to
  be empty right before deletion (`remote.folderNotEmpty`).
- Remote disk uploads are written to `<name>.mirror-part` and renamed over the target; an interrupted
  transfer is resumed from the partial file on the next run and verified by hash.
- Local files changed during the run are detected by a final re-scan (`local.changedDuringRun`) and
  the run is reported as *Incomplete* ("not guaranteed consistent").
- A type mismatch (file ↔ folder at the same path) requires removing the remote item before uploading;
  this is the one deletion that happens before uploads, still guarded by `If-Match`.
- Deleted OneDrive items go to the OneDrive **recycle bin** (Graph `DELETE` semantics), from which you
  can restore them for a limited time. Deletions on the remote disk are immediate.

## Scope of deletions

Mirror deletes only inside the destination folder of each configured pair. On OneDrive the folder is
identified by its persistent item ID and verified before every run to still be a child of the
configured root folder with the configured name. On the remote disk the root folder must carry the
`.mirror-destination.json` marker with the id recorded at set-up time, and the server must present the
recorded host key. If a destination was moved, renamed or deleted, the disk is not mounted, or the
marker is missing/different, the pair is skipped with an explanation and nothing is changed. The
OneDrive root and a drive root are never valid destinations. Removing a pair, changing its destination
name, or changing a root never deletes the old destination folder.

## Remote disk specifics

- Names follow the Windows/NTFS rules (same forbidden characters and reserved names as OneDrive);
  the full path limit is 240 characters on Windows unless long paths are enabled; NTFS is
  case-insensitive (case collisions are reported like on OneDrive).
- Modification times are preserved with one-second precision; nothing else (permissions, xattrs) is.
- Mirror's bookkeeping files `.mirror-destination.json` (root) and `.mirror-manifest.json`
  (each destination) live next to your data; local items with these names, or ending in
  `.mirror-part`, are reserved and reported.
- Linux/NAS hosts work with the `sha1sum` hash command; without any hash tool Mirror compares by size
  only and says so in every run.
