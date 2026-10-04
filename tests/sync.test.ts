import { expect } from "chai";
import { ObsiApi } from "../src/api/client";
import type { CipherMethodType } from "../src/sync/baseTypes";
import { FakeFsEncrypt } from "../src/sync/fsEncrypt";
import { FakeFsSubtree } from "../src/sync/fsSubtree";
import { ownPluginDataIgnorePattern, runMountSync } from "../src/sync/runMount";
import { type SyncSettings, syncer } from "../src/sync/sync";
import { MemoryPrevSyncStore } from "../src/sync/syncDb";
import { FakeServer } from "./helpers/fakeServer";
import { MemFs, buf } from "./helpers/memFs";

const PASSWORD = "correct horse";

interface Device {
  local: MemFs;
  db: MemoryPrevSyncStore;
}
const device = (init: ConstructorParameters<typeof MemFs>[1] = {}): Device => ({
  local: new MemFs("local", init),
  db: new MemoryPrevSyncStore(),
});

const doSync = async (
  d: Device,
  remote: MemFs,
  opts: { password?: string; method?: CipherMethodType; settings?: SyncSettings } = {}
) => {
  const enc = new FakeFsEncrypt(remote, opts.password ?? PASSWORD, opts.method ?? "rclone-base64");
  const res = await syncer(d.local, remote, enc, d.db, "manual", "v_test", ".obsidian", {
    protectModifyPercentage: -1,
    ...opts.settings,
  });
  if (!res.ok) throw res.error;
  return res;
};

describe("forked syncer through FakeFsEncrypt (rclone-base64)", () => {
  it("first sync uploads encrypted data; second device downloads it", async () => {
    const remote = new MemFs("remote");
    const a = device({ "a.md": "hello", "dir/b.md": { content: "bee", mtime: 2000 } });
    await doSync(a, remote);

    // remote holds only opaque names and ciphertext
    const rkeys = remote.keys();
    expect(rkeys.length).to.equal(3); // a.md, dir/, dir/b.md
    for (const k of rkeys) {
      expect(k).to.not.include("a.md");
      expect(k).to.not.include("dir");
      expect(k).to.not.include("b.md");
    }
    for (const k of remote.files()) {
      expect(remote.text(k)).to.not.include("hello");
    }

    const b = device();
    await doSync(b, remote);
    expect(b.local.text("a.md")).to.equal("hello");
    expect(b.local.text("dir/b.md")).to.equal("bee");
    expect(b.local.nodes.get("dir/b.md")!.mtime).to.equal(2000);
  });

  it("modify propagates both ways", async () => {
    const remote = new MemFs("remote");
    const a = device({ "n.md": "v1" });
    const b = device();
    await doSync(a, remote);
    await doSync(b, remote);

    a.local.putRaw("n.md", "v2 from A", 5000);
    await doSync(a, remote);
    await doSync(b, remote);
    expect(b.local.text("n.md")).to.equal("v2 from A");

    b.local.putRaw("n.md", "v3 from B", 6000);
    await doSync(b, remote);
    await doSync(a, remote);
    expect(a.local.text("n.md")).to.equal("v3 from B");
  });

  it("create and delete propagate (delete does not resurrect)", async () => {
    const remote = new MemFs("remote");
    const a = device({ "keep.md": "k", "kill.md": "x" });
    const b = device();
    await doSync(a, remote);
    await doSync(b, remote);
    expect(b.local.files()).to.deep.equal(["keep.md", "kill.md"]);

    a.local.nodes.delete("kill.md");
    a.local.putRaw("new.md", "n", 3000);
    await doSync(a, remote);
    await doSync(b, remote);
    expect(b.local.files()).to.deep.equal(["keep.md", "new.md"]);
    await doSync(a, remote);
    expect(a.local.files()).to.deep.equal(["keep.md", "new.md"]);
    expect(remote.files().length).to.equal(2);
  });

  it("rename (move into a new folder) arrives as delete + create with content intact", async () => {
    const remote = new MemFs("remote");
    const a = device({ "old.md": { content: "body", mtime: 1500 } });
    const b = device();
    await doSync(a, remote);
    await doSync(b, remote);

    await a.local.rename("old.md", "moved/new.md");
    a.local.nodes.set("moved/", { content: new ArrayBuffer(0), mtime: 0, ctime: 0, mtimeSvr: 0 });
    await doSync(a, remote);
    await doSync(b, remote);
    expect(b.local.text("new.md")).to.equal(undefined);
    expect(b.local.text("old.md")).to.equal(undefined);
    expect(b.local.text("moved/new.md")).to.equal("body");
  });

  it("conflict keep_newer: the locally newer side wins and then reaches the other device", async () => {
    const remote = new MemFs("remote");
    const a = device({ "c.md": { content: "base", mtime: 1000 } });
    const b = device();
    await doSync(a, remote);
    await doSync(b, remote);

    a.local.putRaw("c.md", "A edit", 2000);
    b.local.putRaw("c.md", "B edit (newer)", 3000);
    await doSync(a, remote); // A pushes
    await doSync(b, remote); // both modified: B newer -> keep local
    expect(remote.files().length).to.equal(1);
    await doSync(a, remote);
    expect(a.local.text("c.md")).to.equal("B edit (newer)");
    expect(b.local.text("c.md")).to.equal("B edit (newer)");
  });

  it("conflict keep_newer: remote newer than local -> local is overwritten", async () => {
    const remote = new MemFs("remote");
    const a = device({ "c.md": { content: "base", mtime: 1000 } });
    const b = device();
    await doSync(a, remote);
    await doSync(b, remote);

    a.local.putRaw("c.md", "A edit (newer)", 9000);
    b.local.putRaw("c.md", "B edit (older)", 2000);
    await doSync(a, remote);
    await doSync(b, remote);
    expect(b.local.text("c.md")).to.equal("A edit (newer)");
  });

  it("conflict keep_larger", async () => {
    const remote = new MemFs("remote");
    const a = device({ "c.md": { content: "base", mtime: 1000 } });
    const b = device();
    const settings: SyncSettings = { conflictAction: "keep_larger" };
    await doSync(a, remote, { settings });
    await doSync(b, remote, { settings });

    a.local.putRaw("c.md", "short", 9000); // newer but smaller
    b.local.putRaw("c.md", "a much longer text from B", 2000);
    await doSync(a, remote, { settings });
    await doSync(b, remote, { settings });
    expect(b.local.text("c.md")).to.equal("a much longer text from B");
    await doSync(a, remote, { settings });
    expect(a.local.text("c.md")).to.equal("a much longer text from B");
  });

  it("both sides create the same path: keep_newer decides", async () => {
    const remote = new MemFs("remote");
    const a = device({ "same.md": { content: "from A", mtime: 1000 } });
    const b = device({ "same.md": { content: "from B", mtime: 2000 } });
    await doSync(a, remote);
    await doSync(b, remote);
    await doSync(a, remote);
    expect(a.local.text("same.md")).to.equal("from B");
  });

  it("wrong password is detected and nothing is changed", async () => {
    const remote = new MemFs("remote");
    const a = device({ "a.md": "secret" });
    await doSync(a, remote);
    const evil = device();
    const enc = new FakeFsEncrypt(remote, "wrong", "rclone-base64");
    const res = await syncer(evil.local, remote, enc, evil.db, "manual", "v", ".obsidian", {});
    expect(res.ok).to.equal(false);
    expect(evil.local.files()).to.deep.equal([]);
  });

  it("dot-folders are skipped except allowedHiddenDirs (.obsi)", async () => {
    const remote = new MemFs("remote");
    const a = device({
      "n.md": "n",
      ".obsi/ai-rules.json": '{"version":1}',
      ".hidden/x.md": "no",
      ".obsidian/app.json": "{}",
    });
    const b = device();
    const settings: SyncSettings = { allowedHiddenDirs: [".obsi"] };
    await doSync(a, remote, { settings });
    await doSync(b, remote, { settings });
    expect(b.local.files()).to.deep.equal([".obsi/ai-rules.json", "n.md"]);
    expect(b.local.text(".obsi/ai-rules.json")).to.equal('{"version":1}');
  });

  it("prev-sync state is per vault: another stateId starts from scratch", async () => {
    const remote = new MemFs("remote");
    const a = device({ "a.md": "x" });
    await doSync(a, remote);
    expect((await a.db.getAll("v_test")).length).to.be.greaterThan(0);
    expect((await a.db.getAll("v_other")).length).to.equal(0);
  });
});

describe("nested mounts through subtree + ignorePaths", () => {
  it("two mounts sync independently with different passwords and keep each other's files apart", async () => {
    const server = new FakeServer(["v_root", "v_work"]);
    const api = new ObsiApi("http://srv", "tok", server.http);
    const dev = device({
      "root.md": "R",
      "Work/w.md": "W",
      "Work/sub/deep.md": "D",
      ".obsi/ai-rules.json": "{}",
    });
    const all = ["", "Work"];
    const common = {
      api,
      allMountPaths: all,
      fsLocalWhole: dev.local,
      db: dev.db,
      configDir: ".obsidian",
      trigger: "manual" as const,
      settings: { protectModifyPercentage: -1, allowedHiddenDirs: [] as string[] },
    };
    const r1 = await runMountSync({
      ...common,
      vaultId: "v_root",
      mountPath: "",
      password: "pw-root",
      method: "rclone-base64",
      settings: { ...common.settings, allowedHiddenDirs: [".obsi"] },
    });
    expect(r1.ok, String(r1.error)).to.equal(true);
    const r2 = await runMountSync({
      ...common,
      vaultId: "v_work",
      mountPath: "Work",
      password: "pw-work",
      method: "rclone-base64",
    });
    expect(r2.ok, String(r2.error)).to.equal(true);

    // server: root vault has no Work files, work vault has no root files
    const rootKeys = [...server.vaults.get("v_root")!.keys()];
    const workKeys = [...server.vaults.get("v_work")!.keys()];
    expect(rootKeys.length).to.equal(3); // root.md, .obsi/, .obsi/ai-rules.json
    expect(workKeys.length).to.equal(3); // w.md, sub/, sub/deep.md

    // a second device with only the sub-vault as its root (untrusted device)
    const untrusted = device();
    const r3 = await runMountSync({
      ...common,
      allMountPaths: [""],
      fsLocalWhole: untrusted.local,
      db: untrusted.db,
      vaultId: "v_work",
      mountPath: "",
      password: "pw-work",
      method: "rclone-base64",
    });
    expect(r3.ok, String(r3.error)).to.equal(true);
    expect(untrusted.local.files()).to.deep.equal(["sub/deep.md", "w.md"]);
    // it cannot decrypt the root vault with the work password
    const bad = await runMountSync({
      ...common,
      allMountPaths: [""],
      fsLocalWhole: untrusted.local,
      db: untrusted.db,
      vaultId: "v_root",
      mountPath: "",
      password: "pw-work",
      method: "rclone-base64",
    });
    expect(bad.ok).to.equal(false);

    // change in the untrusted device flows back to the full device's Work folder
    untrusted.local.putRaw("w.md", "W2", 9999);
    await runMountSync({
      ...common,
      allMountPaths: [""],
      fsLocalWhole: untrusted.local,
      db: untrusted.db,
      vaultId: "v_work",
      mountPath: "",
      password: "pw-work",
      method: "rclone-base64",
    });
    await runMountSync({ ...common, vaultId: "v_work", mountPath: "Work", password: "pw-work", method: "rclone-base64" });
    expect(dev.local.text("Work/w.md")).to.equal("W2");
    expect(dev.local.text("root.md")).to.equal("R");
  });

  it("a folder that later becomes a mount is not deleted from the parent's remote", async () => {
    const server = new FakeServer(["v_root", "v_work"]);
    const api = new ObsiApi("http://srv", "tok", server.http);
    const dev = device({ "root.md": "R", "Work/w.md": "W" });
    const base = {
      api,
      fsLocalWhole: dev.local,
      db: dev.db,
      configDir: ".obsidian",
      trigger: "manual" as const,
      settings: { protectModifyPercentage: -1 },
      vaultId: "v_root",
      mountPath: "",
      password: "pw",
      method: "rclone-base64" as const,
    };
    // first, no nested mount: Work/ goes to the root vault
    expect((await runMountSync({ ...base, allMountPaths: [""] })).ok).to.equal(true);
    const before = server.vaults.get("v_root")!.size;
    expect(before).to.equal(3); // root.md, Work/, Work/w.md
    // now Work becomes its own mount; syncing the root must not touch Work in remote
    expect((await runMountSync({ ...base, allMountPaths: ["", "Work"] })).ok).to.equal(true);
    expect(server.vaults.get("v_root")!.size).to.equal(before);
    expect(dev.local.text("Work/w.md")).to.equal("W");
  });
});

describe("FakeFsObsiServer / API client wire format", () => {
  it("url-encodes keys, sends mtime headers and round-trips unicode names", async () => {
    const server = new FakeServer(["v1"]);
    const api = new ObsiApi("http://srv/", "tok", server.http);
    const dev = device({ "Папка/заметка #1 (copy).md": { content: "текст", mtime: 4242 } });
    const res = await runMountSync({
      api,
      vaultId: "v1",
      mountPath: "",
      allMountPaths: [""],
      password: "p",
      method: "rclone-base64",
      fsLocalWhole: dev.local,
      db: dev.db,
      settings: { protectModifyPercentage: -1 },
      configDir: ".obsidian",
      trigger: "manual",
    });
    expect(res.ok, String(res.error)).to.equal(true);
    const stored = [...server.vaults.get("v1")!.values()].filter((f) => f.content.byteLength > 0);
    expect(stored[0].mtime_cli).to.equal(4242);
    expect(server.requests.some((r) => r.startsWith("PUT /api/v1/vaults/v1/files/"))).to.equal(true);

    const dev2 = device();
    const res2 = await runMountSync({
      api,
      vaultId: "v1",
      mountPath: "",
      allMountPaths: [""],
      password: "p",
      method: "rclone-base64",
      fsLocalWhole: dev2.local,
      db: dev2.db,
      settings: { protectModifyPercentage: -1 },
      configDir: ".obsidian",
      trigger: "manual",
    });
    expect(res2.ok, String(res2.error)).to.equal(true);
    expect(dev2.local.text("Папка/заметка #1 (copy).md")).to.equal("текст");
  });

  it("a bad token / offline server yields ok=false without throwing", async () => {
    const server = new FakeServer(["v1"]);
    const api = new ObsiApi("http://srv", "WRONG", server.http);
    const dev = device({ "a.md": "x" });
    const res = await runMountSync({
      api,
      vaultId: "v1",
      mountPath: "",
      allMountPaths: [""],
      password: "p",
      method: "rclone-base64",
      fsLocalWhole: dev.local,
      db: dev.db,
      settings: {},
      configDir: ".obsidian",
      trigger: "manual",
    });
    expect(res.ok).to.equal(false);
    const offline = new ObsiApi("http://srv", "tok", async () => {
      throw new Error("network down");
    });
    const res2 = await runMountSync({
      api: offline,
      vaultId: "v1",
      mountPath: "",
      allMountPaths: [""],
      password: "p",
      method: "rclone-base64",
      fsLocalWhole: dev.local,
      db: dev.db,
      settings: {},
      configDir: ".obsidian",
      trigger: "manual",
    });
    expect(res2.ok).to.equal(false);
    expect(res2.error?.message).to.include("network down");
  });
});

describe("plugin's own data.json (per-device secrets)", () => {
  it("is never pushed nor pulled, even with config dir sync on", async () => {
    const settings: SyncSettings = {
      protectModifyPercentage: -1,
      syncConfigDir: true,
      ignorePaths: [ownPluginDataIgnorePattern(".obsidian", "obsi-sync")],
    };
    const remote = new MemFs("remote");
    const a = device({
      "n.md": "note",
      ".obsidian/app.json": "{}",
      ".obsidian/plugins/obsi-sync/main.js": "code",
      ".obsidian/plugins/obsi-sync/data.json": '{"deviceToken":"A"}',
    });
    await doSync(a, remote, { settings });

    const b = device({ ".obsidian/plugins/obsi-sync/data.json": '{"deviceToken":"B"}' });
    await doSync(b, remote, { settings });
    expect(b.local.text("n.md")).to.equal("note");
    expect(b.local.text(".obsidian/plugins/obsi-sync/main.js")).to.equal("code");
    expect(b.local.text(".obsidian/plugins/obsi-sync/data.json")).to.equal('{"deviceToken":"B"}');

    // a data.json already on the server (synced by an older build) is not pulled either
    const legacy = new MemFs("remote");
    const old = device({ ".obsidian/plugins/obsi-sync/data.json": '{"deviceToken":"OLD"}' });
    await doSync(old, legacy, { settings: { protectModifyPercentage: -1, syncConfigDir: true } });
    const c = device({ ".obsidian/plugins/obsi-sync/data.json": '{"deviceToken":"C"}' });
    await doSync(c, legacy, { settings });
    expect(c.local.text(".obsidian/plugins/obsi-sync/data.json")).to.equal('{"deviceToken":"C"}');
  });
});
