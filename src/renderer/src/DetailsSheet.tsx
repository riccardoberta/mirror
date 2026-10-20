import type { AppState } from '@shared/ipc';
import { Dot, Sheet } from './common';
import { formatDate, outcomeLabel, outcomeTone } from './format';

export function DetailsSheet({ state, onClose }: { state: AppState; onClose: () => void }) {
  const run = state.lastRun;
  return (
    <Sheet
      title="Last run"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={() => void window.mirror.openLogFolder()}>
            Open log folder
          </button>
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {!run ? (
        <p className="muted">No run yet.</p>
      ) : (
        <>
          <section>
            <div className="status">
              <Dot tone={outcomeTone(run.outcome)} />
              <b>{outcomeLabel(run.outcome)}</b>
              <span className="muted">
                · {formatDate(run.startedAt)} → {formatDate(run.finishedAt)} · {run.summary}
              </span>
            </div>
            {run.outcome !== 'completed' && (
              <p className="small muted">
                A run is reported as completed only when every enabled folder was mirrored and verified with no errors. Items listed below were not mirrored;
                nothing was deleted on OneDrive for pairs that were skipped.
              </p>
            )}
          </section>
          <section>
            <h2>Folders</h2>
            {run.pairs.map((p) => (
              <div key={p.pairId} className="issue">
                <Dot tone={outcomeTone(p.outcome)} />
                <div>
                  <b>{p.label}</b> <span className="muted">· {outcomeLabel(p.outcome)}</span>
                  <div className="small muted">{p.summary}</div>
                </div>
              </div>
            ))}
          </section>
          <section>
            <h2>
              Issues ({run.issues.length})
            </h2>
            {run.issues.length === 0 ? (
              <p className="muted small">None.</p>
            ) : (
              run.issues.map((i, idx) => (
                <div key={idx} className="issue">
                  <Dot tone={i.severity === 'error' ? 'err' : 'warn'} />
                  <div className="small">
                    {i.pairLabel && <b>{i.pairLabel}: </b>}
                    {i.relPath && <code>{i.relPath}</code>} {i.message} <code className="faint">[{i.code}]</code>
                  </div>
                </div>
              ))
            )}
          </section>
        </>
      )}
    </Sheet>
  );
}
