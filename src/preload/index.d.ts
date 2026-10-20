import type { MirrorApi } from '../shared/ipc.js';

declare global {
  interface Window {
    mirror: MirrorApi;
  }
}

export {};
