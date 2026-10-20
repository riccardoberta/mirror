import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Minimal file logger. Tokens are never passed to the logger by design; as a second line of
 * defence, anything that looks like a bearer token or an upload-session URL is redacted.
 */
export class Logger {
  private readonly dir: string;
  private readonly recent: string[] = [];

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.rotate();
  }

  get directory(): string {
    return this.dir;
  }

  info(message: string): void {
    this.write('INFO', message);
  }

  warn(message: string): void {
    this.write('WARN', message);
  }

  error(message: string): void {
    this.write('ERROR', message);
  }

  /** Last lines, for the in-app details view. */
  tail(n = 200): string[] {
    return this.recent.slice(-n);
  }

  private write(level: string, message: string): void {
    const line = `${new Date().toISOString()} ${level} ${redact(message)}`;
    this.recent.push(line);
    if (this.recent.length > 2000) this.recent.splice(0, this.recent.length - 2000);
    try {
      appendFileSync(path.join(this.dir, `mirror-${new Date().toISOString().slice(0, 10)}.log`), line + '\n');
    } catch {
      /* logging must never break the app */
    }
  }

  private rotate(): void {
    try {
      const files = readdirSync(this.dir)
        .filter((f) => /^mirror-\d{4}-\d{2}-\d{2}\.log$/.test(f))
        .map((f) => ({ f, t: statSync(path.join(this.dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      for (const { f } of files.slice(14)) unlinkSync(path.join(this.dir, f));
    } catch {
      /* ignore */
    }
  }
}

export function redact(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, 'Bearer <redacted>')
    .replace(/eyJ[A-Za-z0-9\-_]{20,}\.[A-Za-z0-9\-_]{20,}\.[A-Za-z0-9\-_]+/g, '<jwt-redacted>')
    .replace(/https?:\/\/[^\s"']*\/up\/[^\s"']+/g, '<upload-session-url>')
    .replace(/(access_token|refresh_token|id_token|code)=([^&\s]+)/gi, '$1=<redacted>');
}
