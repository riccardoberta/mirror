# Remote disk: an external drive on a Windows 11 PC, reached through Tailscale

Mirror can mirror folders to a disk attached to another computer that is always on, without any
Mirror software on that computer: it uses the **OpenSSH Server built into Windows** (SFTP for files,
one PowerShell command for content hashes) over your **Tailscale** network. Everything on the disk is
plain files and folders.

This guide is for **Windows 11 with an administrator account** (the account you sign in with). It
takes about ten minutes. Steps marked *(PowerShell as Administrator)* are run in a terminal opened
with right-click → *Run as administrator*.

## 1. Install Tailscale on both machines

1. Install Tailscale on the Windows PC and on the Mac and sign both into the same tailnet.
2. Note the Windows machine's name in the Tailscale admin console or app, e.g. `desktop-pc`.
   With MagicDNS on, the Mac can reach it as `desktop-pc` or `desktop-pc.<tailnet>.ts.net`; the
   `100.x.y.z` address works too. Mirror's *Host* field takes any of these.
3. Make sure the Windows PC does not sleep (Settings → System → Power: *Screen and sleep → Never*
   when plugged in) and that the external disk stays mounted with a fixed drive letter
   (Disk Management → right-click the volume → *Change Drive Letter and Paths*; choose e.g. `D:`).

## 2. Enable the OpenSSH Server on Windows

*(PowerShell as Administrator)*

```powershell
# Install the server feature (the client is usually present already)
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0

# Start it now and at every boot
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic

# Check
Get-Service sshd
```

Windows adds a firewall rule *OpenSSH SSH Server (sshd)* for port 22 on all interfaces. Restrict it
to the Tailscale network only, so nothing else can reach the server:

```powershell
Set-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -RemoteAddress 100.64.0.0/10
```

(`100.64.0.0/10` is the Tailscale address range. If the rule name differs, list it with
`Get-NetFirewallRule -DisplayName "OpenSSH*"`.)

## 3. Create an SSH key on the Mac

In Terminal on the Mac (press Enter for the default path; a passphrase is optional — if you set one,
enter it in Mirror and it is stored encrypted in the Keychain):

```bash
ssh-keygen -t ed25519 -C "mirror@mac"
cat ~/.ssh/id_ed25519.pub
```

Copy the single line printed by `cat` (it starts with `ssh-ed25519`).

## 4. Authorise the key on Windows (administrator account)

For members of the *Administrators* group, Windows OpenSSH reads the keys from
`C:\ProgramData\ssh\administrators_authorized_keys`, **not** from the user's `.ssh` folder, and the
file must have restrictive permissions or it is ignored.

*(PowerShell as Administrator)* — paste your public key in place of `ssh-ed25519 AAAA… mirror@mac`:

```powershell
$key = 'ssh-ed25519 AAAA... mirror@mac'
$file = 'C:\ProgramData\ssh\administrators_authorized_keys'
Add-Content -Path $file -Value $key -Encoding ascii

# Required ACL: only SYSTEM and Administrators
icacls $file /inheritance:r /grant "SYSTEM:(F)" /grant "BUILTIN\Administrators:(F)"
```

If your Windows user is **not** an administrator, use `C:\Users\<user>\.ssh\authorized_keys`
instead (create the `.ssh` folder; no special ACL needed).

Optional hardening — disable password logins so only keys work. Edit
`C:\ProgramData\ssh\sshd_config` (Notepad as Administrator), set

```
PasswordAuthentication no
PubkeyAuthentication yes
```

and restart the service: `Restart-Service sshd`.

## 5. Test from the Mac

```bash
ssh <windows-user>@desktop-pc 'powershell -NoProfile -Command "Get-FileHash -Algorithm SHA1 C:\Windows\notepad.exe | Select -Expand Hash"'
```

- The first time, ssh shows the server's key fingerprint and asks to continue — type `yes`.
- You should see a 40-character hash and no password prompt. If you are asked for a password, the key
  was not accepted: check the file path and the `icacls` step above.
- `powershell` must be found: this is the command Mirror uses to hash files on the PC.

Find the Windows user name with `whoami` in a Windows terminal (use the part after the backslash, or
the full `user@domain` / Microsoft-account e-mail if `whoami` shows one).

## 6. Configure Mirror

Mirror → Settings → **Remote disk**:

| Field | Value |
|---|---|
| Host | `desktop-pc` (or `desktop-pc.<tailnet>.ts.net`, or `100.x.y.z`) |
| User name | the Windows user from `whoami` |
| Port | `22` |
| Private key file | `~/.ssh/id_ed25519` |
| Key passphrase | only if you set one |
| Root folder | e.g. `D:\Mirror` — a folder on the external disk, never the drive root itself |
| Remote hash command | *PowerShell Get-FileHash (Windows)* |

1. **Test connection** — connects, shows the host key fingerprint and records it (trust on first use:
   from now on Mirror refuses to talk to a server presenting a different key — if you reinstall
   Windows, press *forget* next to the fingerprint), checks the root and that remote hashing works.
2. **Set up root folder** — creates `D:\Mirror` if needed and writes `.mirror-destination.json`
   inside it. This marker carries a unique id: before every Clone, Mirror checks that the root exists
   and carries exactly that id. An unplugged disk, an empty mount point or a different machine never
   look like "the files were deleted" — the pair is simply skipped.
3. Add folders and pick **Remote disk** as the destination. Each gets `D:\Mirror\<name>`.
4. Confirm the mirror warning, press **Clone**.

## How files are compared and verified on the remote disk

- Content hashes (SHA-1) are computed **on the Windows PC** with `Get-FileHash`, in batches, so only
  hashes travel over the network. They are cached in `.mirror-manifest.json` inside each destination
  folder (keyed by size and modification time); untouched files are never re-hashed.
- Every upload goes to `<name>.mirror-part`, gets the local modification time, and is renamed over the
  final name atomically; it is then hashed remotely and compared with the local file.
- An interrupted transfer is resumed from the partial file on the next Clone and verified.
- Deletions compare size and modification time with the inventory taken at the start of the run and
  skip items that changed in the meantime; folders are removed only when empty.
- If `Get-FileHash` is not available (e.g. a NAS), set *Remote hash command* to `sha1sum` (Linux) or
  `None`; with `None` Mirror compares by size only and says so in every run.

## Limits specific to the remote disk

- Windows file names: the same rules as OneDrive (`" * : < > ? / \ |`, reserved names, trailing dots
  or spaces) and a full-path limit of 240 characters unless long paths are enabled on Windows
  (`LongPathsEnabled` policy). Over-long paths are reported, not silently skipped.
- NTFS is case-insensitive: two Mac files differing only by case cannot both be mirrored (reported).
- Modification times are kept with one-second precision; permissions, extended attributes and resource
  forks are not transferred (same as OneDrive, see `LIMITS.md`).
- Deleted remote files are **not** moved to a recycle bin (unlike OneDrive): deletion is immediate.
- Throughput depends on the Tailscale path (direct peer-to-peer is fast; relayed DERP connections are
  slower). Mirror keeps one SSH connection per pair and pipelines requests.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Timed out connecting` | Tailscale not connected on one side, PC asleep, or firewall rule not matching. Try `tailscale ping desktop-pc` from the Mac. |
| `Authentication failed` | Key not in `administrators_authorized_keys`, wrong ACL (`icacls` step), wrong user name, or wrong key file. Test with `ssh -v user@host`. |
| `host key … does not match` | The PC was reinstalled or replaced. Verify, then press *forget* next to the fingerprint and test again. |
| `remote hashing failed` | `powershell` not on PATH for the SSH session or execution blocked. Run the test command from step 5. |
| Pair skipped with `destination.markerMissing` | Disk not mounted, letter changed, or the marker was deleted. Fix the mount; if the marker is gone for good, *Set up root again* (adopts an existing marker or writes a new one — a new id requires confirming the warning again). |
| Path too long errors | Enable long paths on Windows or shorten the root folder path. |
