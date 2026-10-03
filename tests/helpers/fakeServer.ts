import type { HttpClient, HttpRequest, HttpResponse } from "../../src/api/http";

interface StoredFile {
  content: ArrayBuffer;
  mtime_cli: number;
  ctime_cli: number;
  mtime_svr: number;
}

const te = new TextEncoder();
const json = (status: number, obj: unknown): HttpResponse => ({
  status,
  headers: { "content-type": "application/json" },
  body: te.encode(JSON.stringify(obj)).buffer as ArrayBuffer,
});
const empty = (status: number, headers: Record<string, string> = {}): HttpResponse => ({
  status,
  headers,
  body: new ArrayBuffer(0),
});

/** Tiny in-process implementation of the storage + AI + changes parts of docs/API.md */
export class FakeServer {
  vaults = new Map<string, Map<string, StoredFile>>();
  ai = new Map<string, Map<string, { version: string; mtime: number; size: number; kind: string; content: ArrayBuffer }>>();
  changes = new Map<string, any[]>();
  acks: any[] = [];
  clock = 5_000_000;
  requests: string[] = [];
  token = "tok";

  constructor(public vaultIds: string[]) {
    for (const v of vaultIds) {
      this.vaults.set(v, new Map());
      this.ai.set(v, new Map());
      this.changes.set(v, []);
    }
  }

  http: HttpClient = async (req: HttpRequest) => {
    const u = new URL(req.url);
    this.requests.push(`${req.method} ${u.pathname}`);
    if (req.headers?.Authorization !== `Bearer ${this.token}`) {
      return json(401, { error: { code: "unauthorized", message: "bad token" } });
    }
    const m = /^\/api\/v1\/vaults\/([^/]+)\/(.*)$/.exec(u.pathname);
    if (!m) return json(404, { error: { code: "not_found", message: u.pathname } });
    const vid = m[1];
    const rest = m[2];
    const files = this.vaults.get(vid);
    if (!files) return json(404, { error: { code: "no_vault", message: vid } });

    if (rest === "files" && req.method === "GET") {
      return json(200, {
        files: [...files.entries()].map(([key, f]) => ({
          key,
          size: f.content.byteLength,
          mtime_cli: f.mtime_cli,
          ctime_cli: f.ctime_cli,
          mtime_svr: f.mtime_svr,
          etag: "x",
        })),
      });
    }
    if (rest.startsWith("files/")) {
      const key = decodeURIComponent(rest.slice("files/".length));
      if (req.method === "PUT") {
        const f: StoredFile = {
          content: (req.body as ArrayBuffer).slice(0),
          mtime_cli: Number(req.headers?.["X-Mtime-Cli"]),
          ctime_cli: Number(req.headers?.["X-Ctime-Cli"]),
          mtime_svr: ++this.clock,
        };
        files.set(key, f);
        return json(200, {
          key,
          size: f.content.byteLength,
          mtime_cli: f.mtime_cli,
          ctime_cli: f.ctime_cli,
          mtime_svr: f.mtime_svr,
          etag: "x",
        });
      }
      const f = files.get(key);
      if (req.method === "DELETE") {
        files.delete(key);
        return empty(204);
      }
      if (!f) return json(404, { error: { code: "not_found", message: key } });
      const headers = {
        etag: "x",
        "x-mtime-cli": String(f.mtime_cli),
        "x-ctime-cli": String(f.ctime_cli),
        "x-mtime-svr": String(f.mtime_svr),
        "content-length": String(f.content.byteLength),
      };
      if (req.method === "HEAD") return empty(200, headers);
      return { status: 200, headers, body: f.content.slice(0) };
    }
    if (rest === "ai/manifest") {
      return json(200, {
        files: [...this.ai.get(vid)!.entries()].map(([path, f]) => ({
          path,
          version: f.version,
          mtime: f.mtime,
          size: f.size,
          kind: f.kind,
        })),
      });
    }
    if (rest.startsWith("ai/files/")) {
      const path = decodeURIComponent(rest.slice("ai/files/".length));
      const store = this.ai.get(vid)!;
      if (req.method === "PUT") {
        const body = req.body as ArrayBuffer;
        const digest = await crypto.subtle.digest("SHA-256", body);
        const version = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
        const mtime = Number(req.headers?.["X-Mtime"]);
        const ex = store.get(path);
        if (ex && ex.version !== version && ex.mtime > mtime) {
          return json(409, { error: { code: "stale_publish", message: "stale" } });
        }
        const obj = { version, mtime, size: body.byteLength, kind: path.endsWith(".md") ? "note" : "attachment", content: body };
        store.set(path, obj);
        return json(200, { path, version, mtime, size: obj.size, kind: obj.kind });
      }
      if (req.method === "DELETE") {
        store.delete(path);
        return empty(204);
      }
    }
    if (rest === "ai/clear" && req.method === "POST") {
      this.ai.get(vid)!.clear();
      return empty(204);
    }
    if (rest.startsWith("changes") && req.method === "GET") {
      return json(200, { changes: this.changes.get(vid)!.filter((c) => c.status === "pending") });
    }
    const ack = /^changes\/([^/]+)\/ack$/.exec(rest);
    if (ack && req.method === "POST") {
      const c = this.changes.get(vid)!.find((x) => x.id === ack[1]);
      if (!c || c.status !== "pending") return json(409, { error: { code: "not_pending", message: "" } });
      const body = JSON.parse(req.body as string);
      c.status = body.status;
      this.acks.push({ vid, id: c.id, ...body });
      return json(200, c);
    }
    return json(404, { error: { code: "not_found", message: rest } });
  };
}
