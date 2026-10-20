import { useState } from 'react';
import type { AppState, TargetKind } from '@shared/ipc';

export function targetLabel(t: TargetKind): string {
  return t === 'onedrive' ? 'OneDrive' : 'Remote disk';
}

interface Props {
  state: AppState;
  disabled?: boolean;
  primary?: boolean;
  onDone: (warnings: string[]) => void;
  onError: (e: unknown) => void;
}

/** "Add folder…" button; asks which destination to use when both OneDrive and the remote disk are ready. */
export function AddFolderButton({ state, disabled, primary, onDone, onError }: Props) {
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const targets: TargetKind[] = [];
  if (state.oneDriveReady) targets.push('onedrive');
  if (state.sftpReady) targets.push('sftp');

  const add = async (t: TargetKind): Promise<void> => {
    setChoosing(false);
    setBusy(true);
    try {
      const r = await window.mirror.addFolders(t);
      onDone(r.warnings);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  if (targets.length === 0) {
    return (
      <button className={`btn${primary ? ' primary' : ''}`} disabled>
        Add folder…
      </button>
    );
  }
  if (choosing) {
    return (
      <span className="row">
        <span className="muted small">Mirror to:</span>
        {targets.map((t) => (
          <button key={t} className="btn" disabled={busy} onClick={() => add(t)}>
            {targetLabel(t)}
          </button>
        ))}
        <button className="btn icon" onClick={() => setChoosing(false)} aria-label="Cancel">
          ✕
        </button>
      </span>
    );
  }
  return (
    <button className={`btn${primary ? ' primary' : ''}`} disabled={disabled || busy} onClick={() => (targets.length === 1 ? add(targets[0]!) : setChoosing(true))}>
      Add folder…
    </button>
  );
}
