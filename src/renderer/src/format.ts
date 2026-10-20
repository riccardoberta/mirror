import type { PairOutcome, RunOutcome } from '@shared/ipc';

export function formatDate(ts: number | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export type Tone = 'ok' | 'warn' | 'err' | 'neutral';

export function outcomeTone(o: RunOutcome | PairOutcome | undefined): Tone {
  switch (o) {
    case 'completed':
      return 'ok';
    case 'completedWithWarnings':
      return 'warn';
    case 'incomplete':
    case 'failed':
    case 'aborted':
      return 'err';
    case 'cancelled':
      return 'warn';
    default:
      return 'neutral';
  }
}

export function outcomeLabel(o: RunOutcome | PairOutcome | undefined): string {
  switch (o) {
    case 'completed':
      return 'Completed';
    case 'completedWithWarnings':
      return 'Completed with warnings';
    case 'incomplete':
      return 'Incomplete';
    case 'failed':
      return 'Failed';
    case 'aborted':
      return 'Skipped (not safe to run)';
    case 'cancelled':
      return 'Cancelled';
    case 'skipped':
      return 'Disabled';
    default:
      return '—';
  }
}

export function phaseLabel(phase: string): string {
  switch (phase) {
    case 'preparing':
      return 'Preparing';
    case 'scanningLocal':
      return 'Scanning local folder';
    case 'listingRemote':
      return 'Listing OneDrive destination';
    case 'hashing':
      return 'Comparing contents';
    case 'planning':
      return 'Planning';
    case 'creatingFolders':
      return 'Creating folders';
    case 'uploading':
      return 'Uploading';
    case 'verifying':
      return 'Verifying';
    case 'deleting':
      return 'Removing items no longer in the source';
    case 'finalizing':
      return 'Finalizing';
    case 'done':
      return 'Done';
    default:
      return phase;
  }
}
