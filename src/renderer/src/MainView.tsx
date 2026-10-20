import { useState } from 'react';
import type { AppState, Progress } from '@shared/ipc';
import { AddFolderButton } from './AddFolderButton';
import { Banner, Dot } from './common';
import { DetailsSheet } from './DetailsSheet';
import { PairList } from './PairList';
import { SettingsSheet } from './SettingsSheet';
import { formatBytes, formatDate, outcomeLabel, outcomeTone, phaseLabel } from './format';

interface Props {
  state: AppState;
  progress: Progress | undefined;
  isMac: boolean;
  onError: (e: unknown) => void;
}

export function MainView({ state, progress, isMac, onError }: Props) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [ackChecked, setAckChecked] = useState(false);
  const [busy, setBusy] = useState(false);

  const enabledPairs = state.pairs.filter((p) => p.enabled);
  const runnable = enabledPairs.every((p) => (p.target === 'onedrive' ? state.oneDriveReady : state.sftpReady));
  const canClone = !state.running && !state.needsAcknowledgement && enabledPairs.length > 0 && runnable;
  const usesOneDrive = state.pairs.some((p) => p.target === 'onedrive');
  const usesSftp = state.pairs.some((p) => p.target === 'sftp');
  const lastRun = state.lastRun;
  const errorCount = lastRun?.issues.filter((i) => i.severity === 'error').length ?? 0;

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const initials = (state.account?.displayName ?? '?')
    .split(/\s+/)
    .map((s) => s[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <>
      <div className={`titlebar${isMac ? '' : ' not-mac'}`}>
        <h1>Mirror</h1>
        <div className="actions">
          <button className="btn" onClick={() => setDetailsOpen(true)} title="Details of the last run">
            Details{errorCount > 0 ? ` (${errorCount})` : ''}
          </button>
          <button className="btn icon" onClick={() => setSettingsOpen(true)} title="Settings" aria-label="Settings">
            ⚙︎
          </button>
        </div>
      </div>

      <div className="content">
        {/* Destinations */}
        <div className="card">
          {(state.account || usesOneDrive) && (
            <div className="section row between">
              <div className="account">
                <div className="avatar">{state.account ? initials : '?'}</div>
                <div>
                  <div>
                    <b>{state.account?.displayName ?? 'OneDrive not connected'}</b>
                  </div>
                  <div className="muted small">{state.account ? <>{state.account.username} · root folder <b>{state.root?.name ?? '— not chosen'}</b></> : 'Connect in Settings to run the OneDrive folders'}</div>
                </div>
              </div>
              <span className="status muted small">
                <Dot tone={state.oneDriveReady ? 'ok' : 'warn'} /> {state.oneDriveReady ? 'OneDrive connected' : 'OneDrive incomplete'}
              </span>
            </div>
          )}
          {(state.sftp || usesSftp) && (
            <div className="section row between">
              <div className="account">
                <div className="avatar" title="Remote disk">⛁</div>
                <div>
                  <div>
                    <b>Remote disk</b>
                  </div>
                  <div className="muted small">
                    {state.sftp ? <>{state.sftp.username}@{state.sftp.host} · root <b>{state.sftp.rootPath}</b></> : 'not configured'}
                  </div>
                </div>
              </div>
              <span className="status muted small">
                <Dot tone={state.sftpReady ? 'ok' : 'warn'} /> {state.sftpReady ? 'Ready' : 'Set up in Settings'}
              </span>
            </div>
          )}
        </div>

        {/* First-run / changed-destination acknowledgement */}
        {state.needsAcknowledgement && (
          <Banner tone="warn" glyph="⚠︎">
            <b>Mirror can delete files in the destinations.</b>
            <p className="small">
              Clone makes each destination folder{usesOneDrive ? <> inside OneDrive/<b>{state.root?.name}</b></> : null}
              {usesOneDrive && usesSftp ? ' and' : ''}
              {usesSftp ? <> inside the remote disk folder <b>{state.sftp?.rootPath}</b></> : null} identical to its Mac folder: files that no longer exist
              on the Mac are removed from the destination, and any change made there is overwritten. Nothing outside the destinations is touched, and files on
              this Mac are never modified. You will be asked again only if the account, a root folder or a destination changes.
            </p>
            <label className="checkbox small">
              <input type="checkbox" checked={ackChecked} onChange={(e) => setAckChecked(e.target.checked)} />
              <span>I understand that the destination folders will be made identical to my Mac folders, including deletions.</span>
            </label>
            <div style={{ marginTop: 8 }}>
              <button className="btn primary" disabled={!ackChecked || busy} onClick={() => act(() => window.mirror.acknowledge())}>
                Confirm
              </button>
            </div>
          </Banner>
        )}

        {/* Pairs */}
        <div className="card">
          <div className="section row between">
            <h2 style={{ margin: 0 }}>Folders</h2>
            <AddFolderButton state={state} disabled={state.running || busy} onDone={(ws) => ws.forEach((w) => onError(w))} onError={onError} />
          </div>
          <PairList pairs={state.pairs} disabled={state.running || busy} onError={onError} />
        </div>

        {/* Clone */}
        <div className="card clone-area">
          {state.running ? (
            <>
              <ProgressView progress={progress} />
              <button className="clone-btn cancel" onClick={() => act(() => window.mirror.cancelClone())}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button className="clone-btn" disabled={!canClone} onClick={() => act(() => window.mirror.startClone())}>
                Clone
              </button>
              <span className="muted small">
                {enabledPairs.length === 0
                  ? 'Enable at least one folder to run.'
                  : !runnable
                    ? 'A destination used by an enabled folder is not set up. Open Settings.'
                    : `Mirrors ${enabledPairs.length} folder${enabledPairs.length === 1 ? '' : 's'}. Runs only when you press Clone.`}
              </span>
            </>
          )}
          <dl className="kv" style={{ marginTop: 8 }}>
            <dt>Last attempt</dt>
            <dd>
              {lastRun ? (
                <span className="status">
                  <Dot tone={outcomeTone(lastRun.outcome)} />
                  {formatDate(lastRun.finishedAt)} · {outcomeLabel(lastRun.outcome)} · {lastRun.summary}
                  {lastRun.issues.length > 0 && (
                    <>
                      {' · '}
                      <button className="btn link" onClick={() => setDetailsOpen(true)}>
                        details
                      </button>
                    </>
                  )}
                </span>
              ) : (
                <span className="faint">never</span>
              )}
            </dd>
            <dt>Last completed</dt>
            <dd>{state.lastSuccessfulRun ? `${formatDate(state.lastSuccessfulRun.at)} · ${state.lastSuccessfulRun.summary}` : <span className="faint">never</span>}</dd>
          </dl>
        </div>
      </div>

      {settingsOpen && <SettingsSheet state={state} onClose={() => setSettingsOpen(false)} onError={onError} />}
      {detailsOpen && <DetailsSheet state={state} onClose={() => setDetailsOpen(false)} />}
    </>
  );
}

function ProgressView({ progress }: { progress: Progress | undefined }) {
  const p = progress;
  const determinate = p && p.phase === 'uploading' && p.bytesTotal > 0;
  const pct = determinate ? Math.min(100, Math.round((p.bytesDone / p.bytesTotal) * 100)) : 0;
  return (
    <div className="progress">
      <div className="row between small">
        <span>
          <b>{p ? phaseLabel(p.phase) : 'Starting…'}</b>
          {p?.pairLabel && p.pairCount > 0 && (
            <span className="muted">
              {' '}
              · {p.pairLabel} ({p.pairIndex + 1}/{p.pairCount})
            </span>
          )}
        </span>
        <span className="muted">{determinate ? `${formatBytes(p.bytesDone)} / ${formatBytes(p.bytesTotal)}` : p?.message ?? ''}</span>
      </div>
      <div className={`bar${determinate ? '' : ' indeterminate'}`}>
        <div style={determinate ? { width: `${pct}%` } : undefined} />
      </div>
      <div className="faint small ellipsis" style={{ minHeight: 16 }}>
        {p?.currentPath ?? (determinate ? p.message : '')}
      </div>
    </div>
  );
}
