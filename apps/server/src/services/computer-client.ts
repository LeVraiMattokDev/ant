import type {
  BrowserRequest,
  BrowserResponse,
  BrowserTargetInfo,
  ComputerHealth,
  ExecRequest,
  ExecResponse,
  FileEditRequest,
  FileEntry,
  FileReadRequest,
  FileReadResponse,
  FileWriteRequest,
} from '@ant/shared';

export class ComputerError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
  }
}

/** HTTP client for the `computer` service RPC. */
export class ComputerClient {
  constructor(private readonly baseUrl: string, private readonly token: string | undefined) {}

  get configured(): boolean {
    return Boolean(this.token);
  }

  private async call<T>(path: string, body: unknown, timeoutMs = 60_000): Promise<T> {
    if (!this.token) throw new ComputerError('COMPUTER_RPC_TOKEN non configuré : l’ordinateur des agents est désactivé.');
    let res: Response;
    try {
      res = await fetch(new URL(path, this.baseUrl), {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new ComputerError(`Ordinateur injoignable : ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {
        // keep raw text
      }
      throw new ComputerError(message || `Erreur ${res.status}`, res.status);
    }
    return JSON.parse(text) as T;
  }

  health(): Promise<ComputerHealth> {
    return this.call('/health', undefined, 5_000);
  }

  exec(req: ExecRequest): Promise<ExecResponse> {
    return this.call('/exec', req, ((req.timeoutSec ?? 120) + 15) * 1000);
  }

  readFile(req: FileReadRequest): Promise<FileReadResponse> {
    return this.call('/files/read', req);
  }

  writeFile(req: FileWriteRequest): Promise<{ path: string; size: number }> {
    return this.call('/files/write', req);
  }

  editFile(req: FileEditRequest): Promise<{ path: string; replacements: number }> {
    return this.call('/files/edit', req);
  }

  listFiles(path?: string): Promise<FileEntry[]> {
    return this.call('/files/list', { path });
  }

  browser(req: BrowserRequest): Promise<BrowserResponse> {
    return this.call('/browser', req, 90_000);
  }

  /** Label, screenshot and `pin` of the element designated by `pin` (an earlier inspect), `ref` or `selector`. */
  inspect(req: Pick<BrowserRequest, 'ref' | 'selector' | 'pin'>): Promise<BrowserTargetInfo & { screenshotPng?: string }> {
    return this.call('/browser/inspect', req, 30_000);
  }

  /**
   * Streams a file of /workspace. `headersTimeoutMs` bounds only the wait for the response headers: the body is
   * then read at the pace of the consumer (a browser download with backpressure), however long that takes.
   */
  async download(path: string, headersTimeoutMs = 120_000): Promise<Response> {
    if (!this.token) throw new ComputerError('Ordinateur non configuré.');
    const url = new URL('/files/download', this.baseUrl);
    url.searchParams.set('path', path);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`pas de réponse de l’ordinateur après ${Math.round(headersTimeoutMs / 1000)} s`)), headersTimeoutMs);
    try {
      return await fetch(url, { headers: { authorization: `Bearer ${this.token}` }, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** WebSocket URL for VNC / terminal bridges (token passed as header by the proxy). */
  wsUrl(path: '/vnc' | '/terminal'): string {
    const url = new URL(path, this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }

  get authHeader(): string {
    return `Bearer ${this.token ?? ''}`;
  }
}
