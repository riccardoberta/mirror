export class GraphError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | undefined,
    public readonly requestId?: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'GraphError';
  }

  get isNotFound(): boolean {
    return this.status === 404 || this.code === 'itemNotFound';
  }
  get isPreconditionFailed(): boolean {
    return this.status === 412;
  }
  get isInsufficientStorage(): boolean {
    return this.status === 507 || this.code === 'quotaLimitReached';
  }
  get isUnauthenticated(): boolean {
    return this.status === 401 || this.code === 'InvalidAuthenticationToken';
  }
  get isThrottled(): boolean {
    return this.status === 429;
  }
}

export class NetworkError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'NetworkError';
  }
}

export class CancelledError extends Error {
  constructor(message = 'Operation cancelled') {
    super(message);
    this.name = 'CancelledError';
  }
}

export function isAbortError(err: unknown): boolean {
  return (
    err instanceof CancelledError ||
    (typeof err === 'object' && err !== null && 'name' in err && (err as { name: string }).name === 'AbortError')
  );
}

export function describeError(err: unknown): string {
  if (err instanceof GraphError) {
    return `Graph ${err.status}${err.code ? ` ${err.code}` : ''}: ${err.message}`;
  }
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
