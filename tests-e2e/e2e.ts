/**
 * End-to-end check: real Python server + plugin sync/AI/applier code.
 * Run: OBSI_SERVER_DIR=/path/to/obsi-server npm run e2e
 * Defaults to a sibling server checkout. Needs python3 with fastapi/uvicorn/httpx.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strict as assert } from "node:assert";
import { ObsiApi } from "../src/api/client";
import { fetchHttp } from "../src/api/http";
import { decideChange } from "../src/ai/changes";
import { computePublishDiff, groupAllowedByMount, kindOf, relPathFor, sha256Hex } from "../src/ai/publish";
import { computeAllowedPaths, type RulesConfig } from "../src/ai/rules";
import { runMountSync } from "../src/sync/runMount";
import { MemoryPrevSyncStore } from "../src/sync/syncDb";
import { MemFs, buf, str } from "../tests/helpers/memFs";

const SERVER_DIR = resolve(process.env.OBSI_SERVER_DIR ?? resolve(__dirname, "../../server"));
if (!existsSync(join(SERVER_DIR, "obsi_server", "__main__.py"))) {
  throw new Error(`Server checkout not found at ${SERVER_DIR}; set OBSI_SERVER_DIR to the server repository`);
}
const PORT = 18000 + Math.floor(Math.random() * 1000);
const EMB_PORT = PORT + 1000;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = "zebra-launch-codes";

const procs: ChildProcess[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// deterministic bag-of-words embedder speaking the OpenAI /embeddings API
const EMBEDDER = `
import json, hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        inp = body['input']; inp = [inp] if isinstance(inp, str) else inp
        data = []
        for i, t in enumerate(inp):
            v = [0.0] * 64
            for w in t.lower().split():
                v[int(hashlib.md5(w.encode()).hexdigest(), 16) % 64] += 1.0
            data.append({'index': i, 'embedding': v, 'object': 'embedding'})
        out = json.dumps({'data': data, 'model': body['model'], 'object': 'list'}).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(out))); self.end_headers(); self.wfile.write(out)
HTTPServer(('127.0.0.1', ${EMB_PORT}), H).serve_forever()
`;

const mcp = async (token: string, method: string, params: unknown = {}, id = 1) => {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return { status: res.status, body: res.status === 200 ? ((await res.json()) as any) : undefined };
};
const tool = async (token: string, name: string, args: unknown) => {
  const r = await mcp(token, "tools/call", { name, arguments: args });
  assert.equal(r.status, 200);
  const res = r.body.result;
  return { isError: !!res.isError, data: res.structuredContent, text: res.content[0].text as string };
};

const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), "obsi-e2e-"));
  const env = { ...process.env, OBSI_DATA_DIR: dataDir, OBSI_PORT: String(PORT), OBSI_HOST: "127.0.0.1" };
  const adminTok = JSON.parse(
    execFileSync("python3", ["-m", "obsi_server", "admin", "create-token", "--kind", "admin", "--name", "e2e"], {
      cwd: SERVER_DIR, env, encoding: "utf8",
    }).replace(/^[^{]*/, "")
  ).token as string;
  procs.push(spawn("python3", ["-c", EMBEDDER], { stdio: "inherit" }));
  procs.push(spawn("python3", ["-m", "obsi_server", "serve"], { cwd: SERVER_DIR, env, stdio: ["ignore", "ignore", "inherit"] }));
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/api/v1/health`)).ok) break; } catch {}
    if (i > 50) throw new Error("server did not start");
    await sleep(200);
  }

  // ---- admin: vaults, tokens, embeddings
  const admin = new ObsiApi(BASE, adminTok, fetchHttp);
  const post = async (p: string, body: unknown, method = "POST") =>
    JSON.parse(str((await admin.raw(method as any, p, { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } })).body));
  const personal = (await post("/admin/vaults", { name: "Personal" })).id as string;
  const work = (await post("/admin/vaults", { name: "Work" })).id as string;
  const other = (await post("/admin/vaults", { name: "Other" })).id as string;
  const devTok = (await post("/admin/tokens", { name: "laptop", kind: "device", grants: { [personal]: ["read", "write"], [work]: ["read", "write"] } })).token;
  const mcpTok = (await post("/admin/tokens", { name: "claude", kind: "mcp", grants: { [personal]: ["list", "search", "read", "write"], [work]: ["list", "search", "read"] } })).token;
  await post("/admin/settings", { embedding: { base_url: `http://127.0.0.1:${EMB_PORT}/v1`, api_key: "x", model: "bow-64" } }, "PUT");
  for (const v of [personal, work]) await post(`/admin/vaults/${v}`, { rag: { enabled: true } }, "PATCH");

  // ---- device A: full vault, Work mounted at "Work"
  const rules: RulesConfig = {
    version: 1,
    mode: "deny_by_default",
    rules: [
      { id: "r1", type: "folder", effect: "include", path: "Projects" },
      { id: "r2", type: "folder", effect: "exclude", path: "Projects/Secret" },
      { id: "r3", type: "property", effect: "exclude", key: "private", op: "equals", value: true },
      { id: "r4", type: "property", effect: "include", key: "tags", op: "contains", value: "ai" },
    ],
  } as RulesConfig;
  const t0 = 1_700_000_000_000;
  const fm: Record<string, Record<string, unknown>> = {
    "Projects/private.md": { private: true },
    "Work/meeting.md": { tags: ["ai"] },
  };
  const A = new MemFs("local", {
    ".obsi/ai-rules.json": { content: JSON.stringify(rules), mtime: t0 },
    "journal.md": { content: `dear diary ${SECRET}`, mtime: t0 },
    "Projects/idea.md": { content: "# Idea\nBuild a rocket garden.\n![[diagram.png]]\n", mtime: t0 },
    "Projects/diagram.png": { content: "PNGDATA", mtime: t0 },
    "Projects/private.md": { content: `---\nprivate: true\n---\nrocket ${SECRET}`, mtime: t0 },
    "Projects/Secret/plan.md": { content: `rocket ${SECRET}`, mtime: t0 },
    "Work/meeting.md": { content: "---\ntags: [ai]\n---\nQuarterly rocket budget meeting.", mtime: t0 },
    "Work/hr.md": { content: `salary ${SECRET}`, mtime: t0 },
  });
  const mounts = [
    { path: "", vaultId: personal, password: "pw-personal" },
    { path: "Work", vaultId: work, password: "pw-work" },
  ];
  const device = new ObsiApi(BASE, devTok, fetchHttp);
  const dbA = new MemoryPrevSyncStore();
  const syncAll = async (fs: MemFs, db: MemoryPrevSyncStore, ms = mounts) => {
    for (const m of [...ms].reverse()) {
      const r = await runMountSync({
        api: device, vaultId: m.vaultId, mountPath: m.path, allMountPaths: ms.map((x) => x.path),
        password: m.password, method: "rclone-base64", fsLocalWhole: fs, db,
        settings: { protectModifyPercentage: -1 } as any, configDir: ".obsidian", trigger: "manual",
      });
      if (!r.ok) throw r.error;
    }
  };
  await syncAll(A, dbA);

  // E2EE: no plaintext names or contents in server storage blobs
  for (const f of filesUnder(join(dataDir, "vaults"))) {
    const s = readFileSync(f).toString("latin1");
    assert(!s.includes(SECRET) && !s.includes("rocket"), `plaintext leaked in ${f}`);
  }
  console.log("ok  sync A -> server is encrypted");

  // device B gets everything; Work files live in the Work vault only
  const B = new MemFs("local");
  const dbB = new MemoryPrevSyncStore();
  await syncAll(B, dbB);
  assert.equal(B.text("Work/hr.md"), `salary ${SECRET}`);
  assert.equal(B.text("Projects/idea.md"), A.text("Projects/idea.md"));
  assert.equal(B.text(".obsi/ai-rules.json"), JSON.stringify(rules));
  // Personal vault with Work's password-less view: sync Personal alone must not see Work files
  const lonely = new MemFs("local");
  await syncAll(lonely, new MemoryPrevSyncStore(), [mounts[0]]);
  assert(!lonely.keys().some((k) => k.startsWith("Work")), "Work leaked into parent vault");
  console.log("ok  sync B, nested vault isolated from parent");

  // ---- publish AI Available from A
  const publish = async (fs: MemFs) => {
    const files = fs.files();
    const allowed = computeAllowedPaths(rules, {
      files,
      frontmatter: (p) => fm[p],
      resolvedLinks: { "Projects/idea.md": { "Projects/diagram.png": 1 } },
    });
    const grouped = groupAllowedByMount(allowed, mounts);
    for (const m of mounts) {
      const paths = grouped.get(m) ?? [];
      const desired = await Promise.all(paths.map(async (p) => {
        const content = buf(fs.text(p));
        return { relPath: relPathFor(p, m.path), vaultPath: p, version: await sha256Hex(content), mtime: t0, size: content.byteLength, kind: kindOf(p) };
      }));
      const diff = computePublishDiff(desired, await device.aiManifest(m.vaultId));
      for (const d of diff.put) await device.aiPut(m.vaultId, d.relPath, buf(fs.text(d.vaultPath)), Date.now());
      for (const p of diff.del) await device.aiDelete(m.vaultId, p);
    }
    return [...allowed].sort();
  };
  const allowed = await publish(A);
  assert.deepEqual(allowed, ["Projects/diagram.png", "Projects/idea.md", "Work/meeting.md"]);
  console.log("ok  publish:", allowed.join(", "));

  // ---- MCP
  const init = await mcp(mcpTok, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  assert.equal(init.body.result.protocolVersion, "2025-06-18");
  const vaults = await tool(mcpTok, "list_vaults", {});
  assert.deepEqual(vaults.data.result.map((v: any) => v.name).sort(), ["Personal", "Work"]);
  await sleep(1500); // let the embedding worker run
  for (const mode of ["text", "semantic", "hybrid"]) {
    const s = await tool(mcpTok, "search", { query: "rocket", mode, limit: 20 });
    const hits = s.data.result.map((h: any) => `${h.vault === work ? "Work/" : ""}${h.path}`).sort();
    assert(!s.text.includes(SECRET), `${mode} search leaked secret`);
    assert.deepEqual([...new Set(hits)], ["Projects/idea.md", "Work/meeting.md"], `${mode}: ${hits}`);
    assert(s.data.result[0].version && s.data.result[0].snippet !== undefined);
    assert(!s.data.note, `${mode} fell back: ${s.data.note}`);
  }
  console.log("ok  search text/semantic/hybrid returns only AI Available");
  assert((await tool(mcpTok, "read_note", { vault: personal, path: "Projects/Secret/plan.md" })).isError);
  assert((await tool(mcpTok, "read_note", { vault: personal, path: "journal.md" })).isError);
  assert((await tool(mcpTok, "read_note", { vault: other, path: "x.md" })).isError);
  const idea = await tool(mcpTok, "read_note", { vault: "Personal", path: "Projects/idea.md", start_line: 2, end_line: 2 });
  assert.equal(idea.data.content, "Build a rocket garden.\n");
  assert((await tool(mcpTok, "write_note", { vault: work, path: "Work/x.md", content: "x", base_version: null })).isError, "write without grant");
  console.log("ok  read checks grants + AI Available");

  // ---- MCP write -> pending change -> applier on device A -> sync -> B
  const stale = await tool(mcpTok, "write_note", { vault: personal, path: "Projects/idea.md", content: "x", base_version: "0".repeat(64) });
  assert(stale.isError && stale.text.includes("conflict"));
  const newText = "# Idea\nBuild a rocket garden. Edited by AI.\n![[diagram.png]]\n";
  const w = await tool(mcpTok, "write_note", { vault: personal, path: "Projects/idea.md", content: newText, base_version: idea.data.version });
  assert(!w.isError, w.text);
  const created = await tool(mcpTok, "write_note", { vault: personal, path: "journal.md", content: "overwrite!", base_version: null });
  assert(!created.isError, "server cannot know journal.md exists; client must catch it");

  for (const ch of await device.pendingChanges(personal)) {
    const exists = A.keys().includes(ch.path);
    const local = { exists, sha: exists ? await sha256Hex(buf(A.text(ch.path))) : undefined };
    const ok = computeAllowedPaths(rules, { files: [...A.files(), ch.path], frontmatter: (p) => fm[p], resolvedLinks: {} }).has(ch.path);
    const dec = decideChange({ change: ch, local, allowed: ok, ownedByThisVault: true } as any);
    if (dec.action === "apply") A.putRaw(ch.path, ch.content, Date.now());
    await device.ackChange(personal, ch.id, dec.status, dec.message, dec.action === "apply" ? await sha256Hex(buf(ch.content)) : undefined);
  }
  assert.equal(A.text("journal.md"), `dear diary ${SECRET}`);
  const st1 = await tool(mcpTok, "get_change_status", { change_id: w.data.change_id });
  const st2 = await tool(mcpTok, "get_change_status", { change_id: created.data.change_id });
  assert.equal(st1.data.status, "applied");
  assert.notEqual(st2.data.status, "applied");
  await syncAll(A, dbA);
  await syncAll(B, dbB);
  assert.equal(B.text("Projects/idea.md"), newText);
  await publish(A);
  const idea2 = await tool(mcpTok, "read_note", { vault: personal, path: "Projects/idea.md" });
  assert.equal(idea2.data.content, newText);
  console.log(`ok  MCP write applied & synced; create over hidden note -> ${st2.data.status}`);

  // ---- rule change removes data from AI Available and the index
  fm["Work/meeting.md"] = { tags: ["ai"], private: true };
  await publish(A);
  const s = await tool(mcpTok, "search", { query: "quarterly budget", mode: "hybrid" });
  assert(!s.data.result.some((h: any) => h.vault === work), JSON.stringify(s.data.result));
  assert((await tool(mcpTok, "read_note", { vault: work, path: "meeting.md" })).isError);
  console.log("ok  newly-private note removed from AI Available + index");

  // ---- revoke
  const toks = JSON.parse(str((await admin.raw("GET", "/admin/tokens")).body)).tokens;
  await post(`/admin/tokens/${toks.find((t: any) => t.name === "claude").id}/revoke`, {});
  assert.equal((await mcp(mcpTok, "tools/list")).status, 401);
  console.log("ok  revoked MCP token rejected");
  console.log("\nE2E PASSED");
}

main()
  .catch((e) => {
    console.error("E2E FAILED:", e);
    process.exitCode = 1;
  })
  .finally(() => procs.forEach((p) => p.kill()));
