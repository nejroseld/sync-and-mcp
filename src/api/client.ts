import type { HttpClient, HttpRequest } from "./http";
import type {
  AckStatus,
  EmbeddingSettings,
  ManifestFile,
  MeInfo,
  PendingChange,
  ServerFileObject,
  TokenInfo,
  TokenKind,
  VaultInfo,
} from "./types";

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(`${status} ${code}: ${message}`);
    this.status = status;
    this.code = code;
  }
}

/** percent-encode every path segment but keep "/" (and a trailing slash) */
export const encodePath = (p: string) =>
  p
    .split("/")
    .map((x) => encodeURIComponent(x))
    .join("/");

const td = new TextDecoder();

/**
 * Thin client of the obsi-mcp HTTP API v1. One instance per (server, token).
 */
export class ObsiApi {
  constructor(
    public baseUrl: string,
    public token: string,
    private http: HttpClient
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private url(p: string) {
    return `${this.baseUrl}/api/v1${p}`;
  }

  async raw(
    method: HttpRequest["method"],
    path: string,
    opts: {
      body?: ArrayBuffer | string;
      headers?: Record<string, string>;
      okStatuses?: number[];
      auth?: boolean;
    } = {}
  ) {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.auth !== false && this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    const res = await this.http({
      url: this.url(path),
      method,
      headers,
      body: opts.body,
    });
    const ok = opts.okStatuses ?? [200, 201, 204];
    if (!ok.includes(res.status)) {
      let code = "http_error";
      let message = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(td.decode(res.body));
        code = j?.error?.code ?? code;
        message = j?.error?.message ?? message;
      } catch {
        // not json
      }
      throw new ApiError(res.status, code, message);
    }
    return res;
  }

  private async json<T>(
    method: HttpRequest["method"],
    path: string,
    payload?: unknown,
    okStatuses?: number[]
  ): Promise<T> {
    const res = await this.raw(method, path, {
      body: payload === undefined ? undefined : JSON.stringify(payload),
      headers:
        payload === undefined ? undefined : { "Content-Type": "application/json" },
      okStatuses,
    });
    if (res.body.byteLength === 0) {
      return undefined as T;
    }
    return JSON.parse(td.decode(res.body)) as T;
  }

  // ---- general ----
  async health() {
    const res = await this.raw("GET", "/health", { auth: false });
    return JSON.parse(td.decode(res.body)) as {
      ok: boolean;
      version: string;
      features: { ai: boolean; mcp: boolean; rag: boolean };
    };
  }
  me() {
    return this.json<MeInfo>("GET", "/me");
  }
  async listVaults() {
    return (await this.json<{ vaults: VaultInfo[] }>("GET", "/vaults")).vaults;
  }

  // ---- admin ----
  createVault(name: string) {
    return this.json<VaultInfo>("POST", "/admin/vaults", { name });
  }
  patchVault(
    vid: string,
    patch: {
      name?: string;
      rag?: { enabled: boolean; chunk_chars?: number; chunk_overlap?: number };
    }
  ) {
    return this.json<VaultInfo>("PATCH", `/admin/vaults/${encodeURIComponent(vid)}`, patch);
  }
  async listTokens() {
    return (await this.json<{ tokens: TokenInfo[] }>("GET", "/admin/tokens")).tokens;
  }
  createToken(name: string, kind: TokenKind, grants: Record<string, string[]>) {
    return this.json<TokenInfo>("POST", "/admin/tokens", { name, kind, grants });
  }
  revokeToken(id: string) {
    return this.json<TokenInfo>(
      "POST",
      `/admin/tokens/${encodeURIComponent(id)}/revoke`
    );
  }
  getAdminSettings() {
    return this.json<{ embedding?: Partial<EmbeddingSettings> }>(
      "GET",
      "/admin/settings"
    );
  }
  putAdminSettings(s: { embedding: Partial<EmbeddingSettings> }) {
    return this.json<unknown>("PUT", "/admin/settings", s);
  }
  reindex(vid: string) {
    return this.json<unknown>(
      "POST",
      `/admin/vaults/${encodeURIComponent(vid)}/reindex`,
      undefined,
      [200, 202, 204]
    );
  }

  // ---- sync storage ----
  async listFiles(vid: string) {
    return (
      await this.json<{ files: ServerFileObject[] }>(
        "GET",
        `/vaults/${encodeURIComponent(vid)}/files`
      )
    ).files;
  }
  async getFile(vid: string, key: string) {
    const res = await this.raw(
      "GET",
      `/vaults/${encodeURIComponent(vid)}/files/${encodePath(key)}`
    );
    return res.body;
  }
  /** returns undefined if missing */
  async headFile(vid: string, key: string) {
    const res = await this.raw(
      "HEAD",
      `/vaults/${encodeURIComponent(vid)}/files/${encodePath(key)}`,
      { okStatuses: [200, 404] }
    );
    if (res.status === 404) {
      return undefined;
    }
    return res.headers;
  }
  putFile(
    vid: string,
    key: string,
    content: ArrayBuffer,
    mtimeCli: number,
    ctimeCli: number
  ) {
    return this.rawJson<ServerFileObject>(
      "PUT",
      `/vaults/${encodeURIComponent(vid)}/files/${encodePath(key)}`,
      content,
      {
        "Content-Type": "application/octet-stream",
        "X-Mtime-Cli": String(Math.round(mtimeCli)),
        "X-Ctime-Cli": String(Math.round(ctimeCli)),
      }
    );
  }
  async deleteFile(vid: string, key: string) {
    await this.raw(
      "DELETE",
      `/vaults/${encodeURIComponent(vid)}/files/${encodePath(key)}`,
      { okStatuses: [200, 204, 404] }
    );
  }

  private async rawJson<T>(
    method: HttpRequest["method"],
    path: string,
    body: ArrayBuffer | string,
    headers: Record<string, string>,
    okStatuses?: number[]
  ): Promise<T> {
    const res = await this.raw(method, path, { body, headers, okStatuses });
    if (res.body.byteLength === 0) {
      return undefined as T;
    }
    return JSON.parse(td.decode(res.body)) as T;
  }

  // ---- AI Available ----
  async aiManifest(vid: string) {
    return (
      await this.json<{ files: ManifestFile[] }>(
        "GET",
        `/vaults/${encodeURIComponent(vid)}/ai/manifest`
      )
    ).files;
  }
  /** returns "stale" on 409 stale_publish */
  async aiPut(
    vid: string,
    path: string,
    content: ArrayBuffer,
    mtime: number
  ): Promise<ManifestFile | "stale"> {
    try {
      return await this.rawJson<ManifestFile>(
        "PUT",
        `/vaults/${encodeURIComponent(vid)}/ai/files/${encodePath(path)}`,
        content,
        {
          "Content-Type": "application/octet-stream",
          "X-Mtime": String(Math.round(mtime)),
        }
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        return "stale";
      }
      throw e;
    }
  }
  async aiDelete(vid: string, path: string) {
    await this.raw(
      "DELETE",
      `/vaults/${encodeURIComponent(vid)}/ai/files/${encodePath(path)}`,
      { okStatuses: [200, 204, 404] }
    );
  }
  async aiClear(vid: string) {
    await this.raw("POST", `/vaults/${encodeURIComponent(vid)}/ai/clear`, {
      okStatuses: [200, 204],
    });
  }

  // ---- pending changes ----
  async pendingChanges(vid: string) {
    return (
      await this.json<{ changes: PendingChange[] }>(
        "GET",
        `/vaults/${encodeURIComponent(vid)}/changes?status=pending`
      )
    ).changes;
  }
  /** returns false when the change was already acked (409) */
  async ackChange(
    vid: string,
    id: string,
    status: AckStatus,
    message?: string,
    newVersion?: string
  ): Promise<boolean> {
    try {
      await this.json<unknown>(
        "POST",
        `/vaults/${encodeURIComponent(vid)}/changes/${encodeURIComponent(id)}/ack`,
        { status, message, new_version: newVersion }
      );
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        return false;
      }
      throw e;
    }
  }
}

