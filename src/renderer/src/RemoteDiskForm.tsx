import { useState } from 'react';
import type { AppState, HashCommand, SftpTestResult } from '@shared/ipc';
import { Banner, Field } from './common';

interface Props {
  state: AppState;
  onError: (e: unknown) => void;
  /** Compact mode for the setup screen. */
  compact?: boolean;
}

/**
 * Settings for the remote disk (external drive on an always-on machine reached over SSH/SFTP,
 * e.g. through Tailscale): connection, key, root folder, hashing command, test and root set-up.
 */
export function RemoteDiskForm({ state, onError, compact }: Props) {
  const s = state.sftp;
  const [host, setHost] = useState(s?.host ?? '');
  const [port, setPort] = useState(String(s?.port ?? 22));
  const [username, setUsername] = useState(s?.username ?? '');
  const [keyPath, setKeyPath] = useState(s?.privateKeyPath ?? '~/.ssh/id_ed25519');
  const [passphrase, setPassphrase] = useState('');
  const [clearPassphrase, setClearPassphrase] = useState(false);
  const [rootPath, setRootPath] = useState(s?.rootPath ?? 'D:\\Mirror');
  const [hashCommand, setHashCommand] = useState<HashCommand>(s?.hashCommand ?? 'powershell');
  const [busy, setBusy] = useState<string | undefined>();
  const [test, setTest] = useState<SftpTestResult | undefined>();

  const dirty =
    host !== (s?.host ?? '') ||
    port !== String(s?.port ?? 22) ||
    username !== (s?.username ?? '') ||
    keyPath !== (s?.privateKeyPath ?? '~/.ssh/id_ed25519') ||
    rootPath !== (s?.rootPath ?? 'D:\\Mirror') ||
    hashCommand !== (s?.hashCommand ?? 'powershell') ||
    passphrase !== '' ||
    clearPassphrase;

  const save = async (): Promise<void> => {
    await window.mirror.updateSftpSettings({
      host,
      port: Number(port) || 22,
      username,
      privateKeyPath: keyPath,
      rootPath,
      hashCommand,
      ...(passphrase ? { passphrase } : clearPassphrase ? { passphrase: null } : {}),
    });
    setPassphrase('');
    setClearPassphrase(false);
  };

  const act = async (label: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(undefined);
    }
  };

  const canTest = host.trim() && username.trim() && keyPath.trim() && rootPath.trim();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {!compact && (
        <p className="muted small" style={{ margin: 0 }}>
          Mirror connects with SSH (public key) to the machine the disk is attached to — for example a Windows PC with the built-in OpenSSH Server,
          reachable through Tailscale — and writes plain files and folders under the root folder below. See <code>docs/REMOTE_DISK_SFTP.md</code>.
        </p>
      )}
      <div className="fields">
        <Field label="Host (Tailscale name or IP)">
          <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="desktop-pc.tail1234.ts.net or 100.x.y.z" spellCheck={false} />
        </Field>
        <div className="fields" style={{ gridTemplateColumns: '1fr 80px' }}>
          <Field label="User name">
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Windows user" spellCheck={false} />
          </Field>
          <Field label="Port">
            <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
          </Field>
        </div>
        <Field label="Private key file" hint="Create one with: ssh-keygen -t ed25519">
          <input value={keyPath} onChange={(e) => setKeyPath(e.target.value)} spellCheck={false} />
        </Field>
        <Field label={s?.hasPassphrase && !clearPassphrase ? 'Key passphrase (stored encrypted)' : 'Key passphrase (optional)'}>
          <div className="row">
            <input type="password" className="grow" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder={s?.hasPassphrase ? '•••••••• (unchanged)' : 'none'} />
            {s?.hasPassphrase && !clearPassphrase && (
              <button className="btn" onClick={() => setClearPassphrase(true)}>
                Clear
              </button>
            )}
          </div>
        </Field>
        <Field label="Root folder on the remote disk" hint="All mirrored folders are created inside it; Mirror never touches anything outside.">
          <input value={rootPath} onChange={(e) => setRootPath(e.target.value)} placeholder="D:\Mirror" spellCheck={false} />
        </Field>
        <Field label="Remote hash command" hint="Used to verify contents on the remote machine.">
          <select value={hashCommand} onChange={(e) => setHashCommand(e.target.value as HashCommand)}>
            <option value="powershell">PowerShell Get-FileHash (Windows)</option>
            <option value="sha1sum">sha1sum (Linux / NAS)</option>
            <option value="none">None — compare by size only (not recommended)</option>
          </select>
        </Field>
      </div>

      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn" disabled={!dirty || busy !== undefined || state.running} onClick={() => act('save', save)}>
          Save
        </button>
        <button
          className="btn"
          disabled={!canTest || busy !== undefined || state.running}
          onClick={() =>
            act('test', async () => {
              if (dirty) await save();
              setTest(await window.mirror.testSftp());
            })
          }
        >
          {busy === 'test' ? 'Testing…' : 'Test connection'}
        </button>
        <button
          className="btn primary"
          disabled={!canTest || busy !== undefined || state.running}
          title="Creates the root folder if needed and writes the Mirror marker file that identifies it"
          onClick={() =>
            act('root', async () => {
              if (dirty) await save();
              await window.mirror.provisionSftpRoot();
              setTest(undefined);
            })
          }
        >
          {state.sftp?.rootId ? 'Set up root again' : 'Set up root folder'}
        </button>
      </div>

      {test && (
        <Banner tone={test.ok ? (test.hashToolOk === false ? 'warn' : 'info') : 'err'} glyph={test.ok ? 'i' : '!'}>
          <span className="small">
            {test.message}
            {test.hostKeyFingerprint && (
              <>
                {' '}
                Host key: <code>{test.hostKeyFingerprint}</code>
                {test.fingerprintRecorded ? ' (recorded; future connections must present the same key).' : ''}
              </>
            )}
          </span>
        </Banner>
      )}

      {s && (
        <dl className="kv">
          <dt>Status</dt>
          <dd>
            {state.sftpReady ? (
              <span className="status">
                <span className="dot ok" /> Ready — root {s.rootPath} (id {s.rootId?.slice(0, 8)}…)
              </span>
            ) : (
              <span className="status">
                <span className="dot warn" /> {!s.hostKeyFingerprint ? 'Not tested yet' : !s.rootId ? 'Root folder not set up yet' : 'Incomplete'}
              </span>
            )}
          </dd>
          {s.hostKeyFingerprint && (
            <>
              <dt>Host key</dt>
              <dd className="row">
                <code className="ellipsis">{s.hostKeyFingerprint}</code>
                <button
                  className="btn link small"
                  disabled={state.running}
                  title="Forget the recorded key, e.g. after reinstalling the remote machine"
                  onClick={() => act('fp', async () => void (await window.mirror.updateSftpSettings({ hostKeyFingerprint: null })))}
                >
                  forget
                </button>
              </dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
}
