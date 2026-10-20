import { useEffect, useState } from 'react';
import type { AppState, RootCandidate } from '@shared/ipc';
import { Banner, Field, Sheet, Toggle } from './common';
import { RemoteDiskForm } from './RemoteDiskForm';
import { OneDriveSetup } from './SetupView';

interface Props {
  state: AppState;
  onClose: () => void;
  onError: (e: unknown) => void;
}

export function SettingsSheet({ state, onClose, onError }: Props) {
  const s = state.settings;
  const [clientId, setClientId] = useState(s.clientId);
  const [tenant, setTenant] = useState(s.tenant);
  const [excludeNames, setExcludeNames] = useState(s.excludeNames.join('\n'));
  const [excludePrefixes, setExcludePrefixes] = useState(s.excludePrefixes.join('\n'));
  const [concurrency, setConcurrency] = useState(s.uploadConcurrency);
  const [allowEmpty, setAllowEmpty] = useState(s.allowEmptySourceToWipeDestination);
  const [busy, setBusy] = useState(false);
  const [changingRoot, setChangingRoot] = useState(false);
  const [candidates, setCandidates] = useState<RootCandidate[] | undefined>();
  const [newRoot, setNewRoot] = useState('');

  useEffect(() => {
    if (changingRoot && candidates === undefined) {
      window.mirror
        .listRootCandidates()
        .then(setCandidates)
        .catch((e) => {
          setCandidates([]);
          onError(e);
        });
    }
  }, [changingRoot, candidates, onError]);

  const act = async (fn: () => Promise<unknown>, close = false): Promise<void> => {
    setBusy(true);
    try {
      await fn();
      if (close) onClose();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const save = (): Promise<void> =>
    act(
      () =>
        window.mirror.updateSettings({
          clientId: clientId.trim(),
          tenant: tenant.trim() || 'organizations',
          excludeNames: excludeNames.split('\n').map((x) => x.replace(/\r$/, '')).filter(Boolean),
          excludePrefixes: excludePrefixes.split('\n').map((x) => x.trim()).filter(Boolean),
          uploadConcurrency: concurrency,
          allowEmptySourceToWipeDestination: allowEmpty,
        }),
      true,
    );

  const authChanged = clientId.trim() !== s.clientId || tenant.trim() !== s.tenant;

  return (
    <Sheet
      title="Settings"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || state.running} onClick={save}>
            Save
          </button>
        </>
      }
    >
      <section>
        <h2>OneDrive account</h2>
        {state.account ? (
          <div className="row between">
            <span>
              <b>{state.account.displayName}</b> <span className="muted">· {state.account.username}</span>
            </span>
            <button className="btn danger" disabled={busy || state.running} onClick={() => act(() => window.mirror.disconnect(), true)}>
              Disconnect
            </button>
          </div>
        ) : (
          <OneDriveSetup state={state} onError={onError} onOpenSettings={() => {}} />
        )}
      </section>

      <section>
        <h2>OneDrive root folder</h2>
        {state.root ? (
          <div className="row between">
            <span>
              <b>{state.root.name}</b> <span className="muted small">(id {state.root.id})</span>
            </span>
            <button className="btn" disabled={busy || state.running || changingRoot} onClick={() => setChangingRoot(true)}>
              Change…
            </button>
          </div>
        ) : (
          <span className="muted">Not chosen yet.</span>
        )}
        {changingRoot && (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Banner tone="info" glyph="i">
              <span className="small">
                Changing the root re-creates each destination folder inside the new root and asks you to confirm the mirror warning again. Folders under the old
                root are left untouched on OneDrive.
              </span>
            </Banner>
            <div className="fields">
              <Field label="Create a new folder">
                <div className="row">
                  <input value={newRoot} onChange={(e) => setNewRoot(e.target.value)} placeholder="Mirror" className="grow" />
                  <button className="btn primary" disabled={!newRoot.trim() || busy} onClick={() => act(() => window.mirror.selectRoot({ createName: newRoot.trim() }), true)}>
                    Create
                  </button>
                </div>
              </Field>
              <Field label="…or use an existing top-level folder">
                {candidates === undefined ? (
                  <span className="faint small">Loading…</span>
                ) : (
                  <div className="list">
                    {candidates.map((c) => (
                      <button key={c.id} disabled={busy} onClick={() => act(() => window.mirror.selectRoot({ id: c.id }), true)}>
                        <span className="ellipsis">{c.name}</span>
                        <span className="faint">{c.childCount} items</span>
                      </button>
                    ))}
                  </div>
                )}
              </Field>
            </div>
          </div>
        )}
      </section>

      <section>
        <h2>Remote disk (SSH/SFTP)</h2>
        <RemoteDiskForm state={state} onError={onError} />
      </section>

      <section>
        <h2>Microsoft Entra application</h2>
        <div className="fields">
          <Field label="Application (client) ID">
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} spellCheck={false} />
          </Field>
          <Field label="Tenant" hint='"organizations", "common", "consumers", a tenant ID or a domain'>
            <input value={tenant} onChange={(e) => setTenant(e.target.value)} spellCheck={false} />
          </Field>
        </div>
        {authChanged && state.account && (
          <p className="small muted">Changing these values requires reconnecting OneDrive.</p>
        )}
      </section>

      <section>
        <h2>Mirror behaviour</h2>
        <div className="fields">
          <Field label="Excluded names (one per line, exact match)" hint="Items with these names are not mirrored and are removed from destinations.">
            <textarea value={excludeNames} onChange={(e) => setExcludeNames(e.target.value)} spellCheck={false} />
          </Field>
          <Field label="Excluded name prefixes (one per line)" hint='"._" skips AppleDouble resource-fork files.'>
            <textarea value={excludePrefixes} onChange={(e) => setExcludePrefixes(e.target.value)} spellCheck={false} />
          </Field>
        </div>
        <div className="row between" style={{ marginTop: 12 }}>
          <div>
            <div>Parallel uploads</div>
            <div className="muted small">1–8. Lower this if OneDrive throttles you often.</div>
          </div>
          <input type="number" min={1} max={8} value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} style={{ width: 64 }} />
        </div>
        <div className="row between" style={{ marginTop: 12 }}>
          <div>
            <div>Allow an empty source to empty its destination</div>
            <div className="muted small">
              Off by default: a readable but empty Mac folder whose destination still has content is skipped, so an unmounted disk never wipes its mirror.
            </div>
          </div>
          <Toggle on={allowEmpty} onChange={setAllowEmpty} label="Allow empty source" />
        </div>
      </section>

      <section>
        <h2>Diagnostics</h2>
        <div className="row between">
          <span className="muted small ellipsis">{state.logDirectory}</span>
          <button className="btn" onClick={() => window.mirror.openLogFolder().catch(onError)}>
            Open log folder
          </button>
        </div>
        <p className="faint small">
          Logs never contain tokens. Sign-in cache: {state.secureStorage === 'os' ? 'encrypted with the system keychain' : state.secureStorage === 'basic' ? 'weakly encrypted (Linux basic backend)' : 'encryption unavailable'}. Mirror {state.version}.
        </p>
      </section>
    </Sheet>
  );
}
