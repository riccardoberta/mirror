import { useCallback, useEffect, useState } from 'react';
import type { AppState, Progress } from '@shared/ipc';
import { MainView } from './MainView';
import { SetupView } from './SetupView';

export function App() {
  const [state, setState] = useState<AppState | undefined>();
  const [progress, setProgress] = useState<Progress | undefined>();
  const [toast, setToast] = useState<string | undefined>();

  useEffect(() => {
    void window.mirror.getState().then((s) => {
      setState(s);
      setProgress(s.progress);
    });
    const offState = window.mirror.onStateChanged((s) => {
      setState(s);
      if (!s.running) setProgress(undefined);
      else if (s.progress) setProgress(s.progress);
    });
    const offProgress = window.mirror.onProgress(setProgress);
    return () => {
      offState();
      offProgress();
    };
  }, []);

  const showError = useCallback((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    // Electron prefixes IPC errors with "Error invoking remote method '...': Error: "
    setToast(msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(undefined), 7000);
    return () => clearTimeout(t);
  }, [toast]);

  if (!state) return <div className="app" />;

  const setupComplete = (state.oneDriveReady || state.sftpReady) && state.pairs.length > 0;
  const isMac = state.platform === 'darwin';

  return (
    <div className="app">
      {setupComplete ? (
        <MainView state={state} progress={progress} isMac={isMac} onError={showError} />
      ) : (
        <SetupView state={state} isMac={isMac} onError={showError} />
      )}
      {toast && (
        <div className="toast" role="alert" onClick={() => setToast(undefined)}>
          {toast}
        </div>
      )}
    </div>
  );
}
