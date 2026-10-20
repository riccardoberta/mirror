import { useEffect, useState } from 'react';
import type { AppState, RootCandidate } from '@shared/ipc';
import { AddFolderButton } from './AddFolderButton';
import { Banner, Field } from './common';
import { RemoteDiskForm } from './RemoteDiskForm';
import { SettingsSheet } from './SettingsSheet';

interface Props {
  state: AppState;
  isMac: boolean;
  onError: (e: unknown) => void;
}

export function SetupView({ state, isMac, onError }: Props) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [showOneDrive, setShowOneDrive] = useState<boolean | undefined>();
  const [showRemote, setShowRemote] = useState<boolean | undefined>();

  const anyReady = state.oneDriveReady || state.sftpReady;
  const oneDriveOpen = showOneDrive ?? (!state.sftpReady || state.oneDriveReady || Boolean(state.account));
  const remoteOpen = showRemote ?? Boolean(state.sftp);

  return (
    <>
      <div className={`titlebar${isMac ? '' : ' not-mac'}`}>
        <h1>Mirror</h1>
        <div className="actions">
          <button className="btn" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
        </div>
      </div>
      <div className="content">
        <div>
          <h3>Set up your mirror</h3>
          <p className="muted">
            Mirror copies folders from this Mac to a destination of your choice and keeps the copies identical to the originals — only when you press{' '}
            <b>Clone</b>. Nothing is ever transferred automatically, and your local files are never modified.
          </p>
        </div>

        <div className="card steps">
          {/* 1 ─ Destinations */}
          <div className={`step ${anyReady ? 'done' : 'active'}`}>
            <div className="num">{anyReady ? '✓' : '1'}</div>
            <div className="body">
              <b>Choose at least one destination</b>
              <p className="muted small" style={{ margin: 0 }}>
                You can configure both and decide per folder where it goes.
              </p>

              {/* OneDrive */}
              <div className="card" style={{ boxShadow: 'none' }}>
                <div className="section row between" style={{ cursor: 'pointer' }} onClick={() => setShowOneDrive(!oneDriveOpen)}>
                  <span>
                    <b>OneDrive</b> <span className="muted small">· Microsoft Graph</span>
                  </span>
                  <span className="status small muted">
                    <span className={`dot${state.oneDriveReady ? ' ok' : ''}`} /> {state.oneDriveReady ? `Ready — ${state.account?.username}, root "${state.root?.name}"` : state.account ? 'Choose a root folder' : 'Not connected'}
                  </span>
                </div>
                {oneDriveOpen && (
                  <div className="section">
                    <OneDriveSetup state={state} onError={onError} onOpenSettings={() => setSettingsOpen(true)} />
                  </div>
                )}
              </div>

              {/* Remote disk */}
              <div className="card" style={{ boxShadow: 'none' }}>
                <div className="section row between" style={{ cursor: 'pointer' }} onClick={() => setShowRemote(!remoteOpen)}>
                  <span>
                    <b>Remote disk</b> <span className="muted small">· SSH/SFTP, e.g. a drive on a Windows PC over Tailscale</span>
                  </span>
                  <span className="status small muted">
                    <span className={`dot${state.sftpReady ? ' ok' : ''}`} /> {state.sftpReady ? `Ready — ${state.sftp?.username}@${state.sftp?.host}:${state.sftp?.rootPath}` : state.sftp ? 'Incomplete' : 'Not configured'}
                  </span>
                </div>
                {remoteOpen && (
                  <div className="section">
                    <RemoteDiskForm state={state} onError={onError} />
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 2 ─ Folders */}
          <div className={`step ${anyReady ? 'active' : 'locked'}`}>
            <div className="num">2</div>
            <div className="body">
              <b>Add folders from this Mac</b>
              <p className="muted small" style={{ margin: 0 }}>
                Each folder you add gets its own destination folder with the same name inside the root. You can add several at once, rename destinations
                and disable folders later.
              </p>
              {warnings.map((w, i) => (
                <Banner key={i} tone="warn" glyph="!">
                  <span className="small">{w}</span>
                </Banner>
              ))}
              <div>
                <AddFolderButton state={state} primary disabled={!anyReady} onDone={setWarnings} onError={onError} />
              </div>
            </div>
          </div>
        </div>

        {state.secureStorage !== 'os' && (
          <Banner tone="warn" glyph="!">
            <span className="small">
              OS-level encryption for stored secrets is {state.secureStorage === 'basic' ? 'weak on this system (plain-text backend)' : 'not available'}; on
              macOS they are protected by the Keychain.
            </span>
          </Banner>
        )}
      </div>
      {settingsOpen && <SettingsSheet state={state} onClose={() => setSettingsOpen(false)} onError={onError} />}
    </>
  );
}

/* ------------------------------------------------------------------ */

export function OneDriveSetup({ state, onError, onOpenSettings }: { state: AppState; onError: (e: unknown) => void; onOpenSettings: () => void }) {
  const [busy, setBusy] = useState<string | undefined>();
  const [clientId, setClientId] = useState(state.settings.clientId);
  const [tenant, setTenant] = useState(state.settings.tenant);
  const [candidates, setCandidates] = useState<RootCandidate[] | undefined>();
  const [newRootName, setNewRootName] = useState('Mirror');

  const hasClientId = state.settings.clientId.trim().length > 0;
  const step = !hasClientId ? 1 : !state.account ? 2 : !state.root ? 3 : 4;

  useEffect(() => {
    if (step === 3 && candidates === undefined && !busy) {
      setBusy('roots');
      window.mirror
        .listRootCandidates()
        .then(setCandidates)
        .catch((e) => {
          setCandidates([]);
          onError(e);
        })
        .finally(() => setBusy(undefined));
    }
  }, [step, candidates, busy, onError]);

  const run = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(undefined);
    }
  };

  if (step === 4) {
    return (
      <div className="row between">
        <span className="small muted">
          {state.account?.displayName} · {state.account?.username} · root <b>{state.root?.name}</b>
        </span>
        <button className="btn link small" onClick={onOpenSettings}>
          Change in Settings
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {step === 1 && (
        <>
          <p className="muted small" style={{ margin: 0 }}>
            Mirror signs in with your own Microsoft Entra app registration (no secret is stored). Create one once following{' '}
            <code>docs/ENTRA_APP_REGISTRATION.md</code>, then paste its Application (client) ID here.
          </p>
          <div className="fields">
            <Field label="Application (client) ID">
              <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" spellCheck={false} />
            </Field>
            <Field label="Tenant" hint='"organizations" for work/school accounts, or your tenant domain (e.g. unige.it)'>
              <input value={tenant} onChange={(e) => setTenant(e.target.value)} spellCheck={false} />
            </Field>
          </div>
          <div>
            <button
              className="btn primary"
              disabled={!clientId.trim() || busy !== undefined}
              onClick={() => run('settings', () => window.mirror.updateSettings({ clientId: clientId.trim(), tenant: tenant.trim() || 'organizations' }))}
            >
              Save
            </button>
          </div>
        </>
      )}
      {step === 2 && (
        <>
          <p className="muted small" style={{ margin: 0 }}>
            Signs in with your Microsoft account in your browser. Mirror requests only access to your own files.
          </p>
          <div className="row">
            <button className="btn primary" disabled={busy !== undefined} onClick={() => run('connect', () => window.mirror.connect())}>
              {busy === 'connect' ? 'Waiting for browser sign-in…' : 'Connect OneDrive'}
            </button>
            <button className="btn link small" onClick={onOpenSettings}>
              Change client ID
            </button>
          </div>
        </>
      )}
      {step === 3 && (
        <>
          <p className="muted small" style={{ margin: 0 }}>
            Signed in as <b>{state.account?.username}</b>. Choose the OneDrive folder that will contain every mirrored folder. The OneDrive root itself
            cannot be used.
          </p>
          <div className="fields">
            <Field label="Create a new folder">
              <div className="row">
                <input value={newRootName} onChange={(e) => setNewRootName(e.target.value)} className="grow" />
                <button
                  className="btn primary"
                  disabled={!newRootName.trim() || busy !== undefined}
                  onClick={() => run('root', () => window.mirror.selectRoot({ createName: newRootName.trim() }))}
                >
                  Create
                </button>
              </div>
            </Field>
            <Field label="…or use an existing top-level folder">
              {candidates === undefined ? (
                <span className="faint small">Loading…</span>
              ) : candidates.length === 0 ? (
                <span className="faint small">No folders yet.</span>
              ) : (
                <div className="list">
                  {candidates.map((c) => (
                    <button key={c.id} disabled={busy !== undefined} onClick={() => run('root', () => window.mirror.selectRoot({ id: c.id }))}>
                      <span className="ellipsis">{c.name}</span>
                      <span className="faint">{c.childCount} items</span>
                    </button>
                  ))}
                </div>
              )}
            </Field>
          </div>
        </>
      )}
    </div>
  );
}
