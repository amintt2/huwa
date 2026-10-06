// Messages between the app (host) and one extension sandbox (a sandboxed iframe inside the hidden
// WebView, see `host-page.ts`). Every message is a JSON string. The sandbox is untrusted: the app
// validates everything it receives (see `../validate.ts` and `../net.ts`).

export type PaperbackFormat = '0.8' | '0.9';

/**
 * Operations the app can ask a loaded source for. `discover` lists the source's home sections
 * (0.9 `getDiscoverSections`, 0.8 `getHomePageSections` with its first items); `discoverItems`
 * pages one section (0.9 `getDiscoverSectionItems(section, metadata)`, 0.8 `getViewMoreItems(id, metadata)`).
 */
export type SourceOp =
  | 'details'
  | 'chapters'
  | 'pages'
  | 'search'
  | 'imageHeaders'
  | 'info'
  | 'discover'
  | 'discoverItems'
  /** Page the source wants opened for a Cloudflare check (0.8 `getCloudflareBypassRequest[Async]`), `null` when none. */
  | 'cfRequest'
  /** The check passed: hands the cookies to the source (0.9 `cloudflareBypassCompleted` / `saveCloudflareBypassCookies`). */
  | 'cfDone';

export type HostToSandbox =
  | {
      t: 'load';
      /** Source id inside its repository (e.g. `MangaDex`), used to find the exported class/instance. */
      id: string;
      format: PaperbackFormat;
      code: string;
      /** Persisted `Application.getState` / state-manager values, preloaded (0.9 reads are synchronous). */
      state: Record<string, unknown>;
      secure: Record<string, unknown>;
      userAgent: string;
    }
  | { t: 'call'; cid: number; op: SourceOp; args: unknown[] }
  | { t: 'res'; rid: number; ok: boolean; v?: unknown; e?: string };

export type SandboxToHost =
  | { t: 'ready' }
  | { t: 'loaded'; ok: boolean; e?: string }
  | {
      t: 'ret';
      cid: number;
      ok: boolean;
      v?: unknown;
      e?: string;
      /** The source threw a Cloudflare error; `url` is its resolution request when it gave one. */
      cf?: { url?: string };
    }
  | { t: 'req'; rid: number; m: 'http'; a: HttpRequest }
  | { t: 'state'; secure: boolean; key: string; value: unknown }
  | { t: 'log'; level: 'log' | 'warn' | 'error'; text: string };

/** A request the extension wants the app to perform. The body travels as base64. */
export type HttpRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body64?: string;
  /** Timeout wished by the extension (ms), capped by the app. */
  timeoutMs?: number;
  /** Rate wished by the extension (requests per second), capped by the app. */
  rps?: number;
};

export type HttpCookie = { name: string; value: string; domain: string; path?: string; expires?: string };

export type HttpResponse = {
  url: string;
  status: number;
  headers: Record<string, string>;
  cookies: HttpCookie[];
  mimeType?: string;
  body64: string;
  /** The app recognized a Cloudflare challenge page (the extension only sees the status and page). */
  challenge?: boolean;
};
