import { useState } from 'react';
import type { PairConfig } from '@shared/ipc';
import { targetLabel } from './AddFolderButton';
import { Dot, Toggle } from './common';
import { formatDate, outcomeLabel, outcomeTone } from './format';

interface Props {
  pairs: PairConfig[];
  disabled: boolean;
  onError: (e: unknown) => void;
}

export function PairList({ pairs, disabled, onError }: Props) {
  if (pairs.length === 0) return <div className="empty">No folders yet. Add a folder from this Mac to mirror it.</div>;
  return (
    <div>
      {pairs.map((p) => (
        <PairRow key={p.id} pair={p} disabled={disabled} onError={onError} />
      ))}
    </div>
  );
}

function PairRow({ pair, disabled, onError }: { pair: PairConfig; disabled: boolean; onError: (e: unknown) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(pair.destinationName);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const commit = async (): Promise<void> => {
    setEditing(false);
    if (name.trim() === pair.destinationName || !name.trim()) {
      setName(pair.destinationName);
      return;
    }
    try {
      await window.mirror.updatePair(pair.id, { destinationName: name.trim() });
    } catch (e) {
      setName(pair.destinationName);
      onError(e);
    }
  };

  const tone = outcomeTone(pair.lastAttempt?.outcome);
  const statusText = pair.lastAttempt
    ? `${outcomeLabel(pair.lastAttempt.outcome)} · ${formatDate(pair.lastAttempt.at)}`
    : 'Never run';

  return (
    <div className={`pair${pair.enabled ? '' : ' disabled'}`}>
      <Toggle on={pair.enabled} disabled={disabled} label="Enabled" onChange={(v) => window.mirror.updatePair(pair.id, { enabled: v }).catch(onError)} />
      <div className="grow">
        <div className="path ellipsis" title={pair.sourcePath}>
          {pair.sourcePath}
        </div>
        <div className="status muted" title={pair.lastAttempt?.summary}>
          <Dot tone={tone} /> {statusText}
        </div>
      </div>
      <span className="arrow">→</span>
      <div className="dest grow">
        {editing ? (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commit();
              if (e.key === 'Escape') {
                setName(pair.destinationName);
                setEditing(false);
              }
            }}
          />
        ) : (
          <>
            <div className="ellipsis" title="Destination folder name (click Edit to rename; the previous destination folder is kept)">
              <span className="faint small">{targetLabel(pair.target)} / </span>
              {pair.destinationName}
            </div>
            <div className="muted small">{pair.lastSuccess ? `last completed ${formatDate(pair.lastSuccess.at)}` : 'not yet completed'}</div>
          </>
        )}
      </div>
      <div className="row">
        <button className="btn icon" disabled={disabled} title="Rename destination" onClick={() => setEditing(true)}>
          Edit
        </button>
        {confirmRemove ? (
          <>
            <button
              className="btn danger"
              disabled={disabled}
              onClick={() => window.mirror.removePair(pair.id).catch(onError)}
              title="Removes the pair from Mirror. The destination folder is kept."
            >
              Remove (keeps destination)
            </button>
            <button className="btn icon" onClick={() => setConfirmRemove(false)}>
              ✕
            </button>
          </>
        ) : (
          <button className="btn icon" disabled={disabled} title="Remove from Mirror (destination folder is kept)" onClick={() => setConfirmRemove(true)}>
            −
          </button>
        )}
      </div>
    </div>
  );
}
