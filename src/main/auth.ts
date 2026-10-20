import { promises as fs } from 'node:fs';
import { safeStorage, shell } from 'electron';
import { type AccountInfo as MsalAccount, type ICachePlugin, InteractionRequiredAuthError, LogLevel, PublicClientApplication } from '@azure/msal-node';
import type { TokenProvider } from '../core/graph/client.js';
import type { Logger } from './log.js';

/**
 * Minimum delegated permissions:
 *  - Files.ReadWrite: read/write the signed-in user's own OneDrive files (not ".All", no shared/other drives)
 *  - User.Read: identify the account (stable user id / name) so Mirror never writes to a different account
 *  - offline_access: refresh tokens, so Clone works later without signing in again
 */
export const GRAPH_SCOPES = ['Files.ReadWrite', 'User.Read', 'offline_access'];
const TOKEN_SCOPES = ['Files.ReadWrite', 'User.Read'];

export interface AuthConfig {
  clientId: string;
  tenant: string;
}

export type SecureStorageKind = 'os' | 'basic' | 'unavailable';

export function describeSecureStorage(): SecureStorageKind {
  if (!safeStorage.isEncryptionAvailable()) return 'unavailable';
  if (process.platform === 'linux') {
    const backend = safeStorage.getSelectedStorageBackend();
    if (backend === 'basic_text' || backend === 'unknown') return 'basic';
  }
  return 'os';
}

const SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Mirror</title>
<style>body{font:15px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f5f5f7;color:#1d1d1f}
div{background:#fff;padding:32px 40px;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08);text-align:center}</style></head>
<body><div><h2>Signed in to Mirror</h2><p>You can close this window and return to the app.</p></div></body></html>`;
const ERROR_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Mirror</title>
<style>body{font:15px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f5f5f7;color:#1d1d1f}
div{background:#fff;padding:32px 40px;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08);text-align:center;max-width:520px}</style></head>
<body><div><h2>Sign-in failed</h2><p>Mirror could not complete the sign-in. Return to the app and try again.</p></div></body></html>`;

/**
 * Microsoft identity via MSAL Node (official library): OAuth 2.0 authorization code + PKCE through the
 * system browser with a loopback redirect (http://localhost:&lt;port&gt;). No client secret exists.
 *
 * The MSAL token cache (refresh token included) is encrypted with Electron's safeStorage, whose key
 * lives in the macOS Keychain (DPAPI on Windows, libsecret on Linux), and stored as a file in the
 * app's user-data folder. Tokens are never logged.
 */
export class AuthService implements TokenProvider {
  private pca: PublicClientApplication | undefined;
  private config: AuthConfig | undefined;
  private accountHint: string | undefined; // homeAccountId
  private cachedToken: { value: string; expiresAt: number } | undefined;

  constructor(
    private readonly cacheFile: string,
    private readonly log: Logger,
  ) {}

  configure(config: AuthConfig, homeAccountId?: string): void {
    const changed = !this.config || this.config.clientId !== config.clientId || this.config.tenant !== config.tenant;
    this.config = config;
    this.accountHint = homeAccountId;
    if (changed) {
      this.pca = undefined;
      this.cachedToken = undefined;
    }
  }

  private ensurePca(): PublicClientApplication {
    if (this.pca) return this.pca;
    if (!this.config?.clientId) throw new Error('No Application (client) ID configured. Open Settings and enter the ID from your Microsoft Entra app registration.');
    const tenant = normalizeTenant(this.config.tenant);
    const log = this.log;
    this.pca = new PublicClientApplication({
      auth: { clientId: this.config.clientId.trim(), authority: `https://login.microsoftonline.com/${tenant}` },
      cache: { cachePlugin: this.cachePlugin() },
      system: {
        loggerOptions: {
          piiLoggingEnabled: false,
          logLevel: LogLevel.Warning,
          loggerCallback: (level, message) => {
            if (level <= LogLevel.Warning) log.warn(`msal: ${message}`);
          },
        },
      },
    });
    return this.pca;
  }

  private cachePlugin(): ICachePlugin {
    const file = this.cacheFile;
    return {
      beforeCacheAccess: async (ctx) => {
        try {
          const enc = await fs.readFile(file);
          const json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(enc) : enc.toString('utf8');
          ctx.tokenCache.deserialize(json);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log.warn(`token cache unreadable; starting empty (${(err as Error).message})`);
        }
      },
      afterCacheAccess: async (ctx) => {
        if (!ctx.cacheHasChanged) return;
        const json = ctx.tokenCache.serialize();
        const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json, 'utf8');
        await fs.writeFile(file, data, { mode: 0o600 });
      },
    };
  }

  /** Interactive sign-in (system browser). Returns the MSAL account. */
  async signIn(): Promise<MsalAccount> {
    const pca = this.ensurePca();
    const result = await pca.acquireTokenInteractive({
      scopes: GRAPH_SCOPES,
      openBrowser: async (url) => {
        await shell.openExternal(url);
      },
      successTemplate: SUCCESS_HTML,
      errorTemplate: ERROR_HTML,
      prompt: 'select_account',
    });
    if (!result.account) throw new Error('Sign-in did not return an account.');
    this.accountHint = result.account.homeAccountId;
    this.cachedToken = { value: result.accessToken, expiresAt: result.expiresOn?.getTime() ?? Date.now() + 5 * 60_000 };
    this.log.info(`signed in as ${result.account.username}`);
    return result.account;
  }

  async signOut(): Promise<void> {
    if (!this.config?.clientId) return;
    try {
      const pca = this.ensurePca();
      const cache = pca.getTokenCache();
      for (const acc of await cache.getAllAccounts()) await cache.removeAccount(acc);
    } catch (err) {
      this.log.warn(`sign-out: ${(err as Error).message}`);
    }
    this.cachedToken = undefined;
    this.accountHint = undefined;
    try {
      await fs.rm(this.cacheFile, { force: true });
    } catch {
      /* ignore */
    }
  }

  async getAccount(): Promise<MsalAccount | undefined> {
    if (!this.config?.clientId) return undefined;
    const accounts = await this.ensurePca().getTokenCache().getAllAccounts();
    if (this.accountHint) return accounts.find((a) => a.homeAccountId === this.accountHint) ?? undefined;
    return accounts[0];
  }

  /** TokenProvider: silent acquisition with cached refresh token; refreshes on demand. */
  async getAccessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.cachedToken && this.cachedToken.expiresAt - Date.now() > 120_000) return this.cachedToken.value;
    const account = await this.getAccount();
    if (!account) throw new AuthRequiredError('Not signed in. Connect OneDrive first.');
    try {
      const result = await this.ensurePca().acquireTokenSilent({ account, scopes: TOKEN_SCOPES, forceRefresh });
      this.cachedToken = { value: result.accessToken, expiresAt: result.expiresOn?.getTime() ?? Date.now() + 5 * 60_000 };
      return result.accessToken;
    } catch (err) {
      if (err instanceof InteractionRequiredAuthError) {
        throw new AuthRequiredError('Your Microsoft sign-in has expired. Reconnect OneDrive and press Clone again.');
      }
      throw err;
    }
  }
}

export class AuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

export function normalizeTenant(t: string): string {
  const v = t.trim();
  if (!v) return 'organizations';
  if (['common', 'organizations', 'consumers'].includes(v)) return v;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return v;
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v)) return v; // verified domain, e.g. unige.it
  throw new Error(`Invalid tenant "${t}". Use "organizations", "common", "consumers", a tenant ID or a domain like unige.it.`);
}
