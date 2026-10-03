import { expect } from "chai";
import { FakeFsSubtree } from "../src/sync/fsSubtree";
import {
  findOwningMount,
  ignorePatternsForNestedMounts,
  nestedMountPrefixes,
  normalizeMountPath,
  toRelPath,
  toVaultPath,
} from "../src/sync/mounts";
import { MemFs } from "./helpers/memFs";

describe("mounts: path helpers", () => {
  it("normalizes", () => {
    expect(normalizeMountPath("/a/b/")).to.equal("a/b");
    expect(normalizeMountPath("/")).to.equal("");
    expect(normalizeMountPath("")).to.equal("");
  });
  it("nested prefixes: only strictly nested, shortest only", () => {
    const all = ["", "Work", "Work/Client", "Work/Client/Deep", "Personal"];
    expect(nestedMountPrefixes("", all)).to.deep.equal(["Work", "Personal"]);
    expect(nestedMountPrefixes("Work", all)).to.deep.equal(["Work/Client"]);
    expect(nestedMountPrefixes("Work/Client/Deep", all)).to.deep.equal([]);
    expect(nestedMountPrefixes("Wor", ["Wor", "Work"])).to.deep.equal([]);
  });
  it("owning mount is the deepest one", () => {
    const m = [
      { path: "", vaultId: "root" },
      { path: "Work", vaultId: "w" },
      { path: "Work/Client", vaultId: "c" },
    ];
    expect(findOwningMount("a.md", m)?.vaultId).to.equal("root");
    expect(findOwningMount("Work/a.md", m)?.vaultId).to.equal("w");
    expect(findOwningMount("Work/Client/a.md", m)?.vaultId).to.equal("c");
    expect(findOwningMount("Workshop/a.md", m)?.vaultId).to.equal("root");
    expect(findOwningMount("a.md", m.slice(1))).to.equal(undefined);
  });
  it("path <-> rel path", () => {
    expect(toRelPath("Work/a/b.md", "Work")).to.equal("a/b.md");
    expect(toRelPath("Other/a.md", "Work")).to.equal(undefined);
    expect(toRelPath("Workshop/a.md", "Work")).to.equal(undefined);
    expect(toRelPath("a.md", "")).to.equal("a.md");
    expect(toVaultPath("a/b.md", "Work")).to.equal("Work/a/b.md");
    expect(toVaultPath("a/b.md", "")).to.equal("a/b.md");
  });
  it("ignore patterns are relative to the mount and escape regex chars", () => {
    expect(ignorePatternsForNestedMounts("", ["", "My.Work"])).to.deep.equal(["^My\\.Work(/|$)"]);
    expect(ignorePatternsForNestedMounts("Work", ["Work", "Work/Client"])).to.deep.equal(["^Client(/|$)"]);
  });
});

describe("FakeFsSubtree", () => {
  const mk = () =>
    new MemFs("local", {
      "root.md": "r",
      ".obsi/ai-rules.json": "{}",
      "Work/w.md": "w",
      "Work/sub/s.md": "s",
      "Work/Client/c.md": "c",
      "Work/Client/deep/d.md": "d",
      "Workshop/x.md": "x",
    });

  it("root subtree excludes nested mounts and keeps hidden .obsi", async () => {
    const fs = new FakeFsSubtree(mk(), "", ["Work", "Work/Client"]);
    const keys = (await fs.walk()).map((e) => e.key).sort();
    expect(keys).to.include("root.md");
    expect(keys).to.include(".obsi/ai-rules.json");
    expect(keys).to.include("Workshop/x.md");
    expect(keys.filter((k) => k!.startsWith("Work/"))).to.deep.equal([]);
    expect(keys).to.not.include("Work/");
  });

  it("mount subtree maps keys to relative and hides its own nested mount", async () => {
    const fs = new FakeFsSubtree(mk(), "Work", ["Work/Client"]);
    const keys = (await fs.walk()).map((e) => e.key).sort();
    expect(keys).to.deep.equal(["sub/", "sub/s.md", "w.md"]);
    const e = await fs.stat("w.md");
    expect(e.key).to.equal("w.md");
    expect(e.keyRaw).to.equal("w.md");
  });

  it("writes land under the prefix; nested mounts are protected", async () => {
    const inner = mk();
    const fs = new FakeFsSubtree(inner, "Work", ["Work/Client"]);
    await fs.writeFile("new/n.md", new TextEncoder().encode("n").buffer as ArrayBuffer, 5, 5);
    expect(inner.text("Work/new/n.md")).to.equal("n");
    await fs.rm("w.md");
    expect(inner.nodes.has("Work/w.md")).to.equal(false);
    let err: unknown;
    try {
      await fs.rm("Client/c.md");
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(Error);
    expect(inner.nodes.has("Work/Client/c.md")).to.equal(true);
    let err2: unknown;
    try {
      await fs.readFile("../root.md");
    } catch (e) {
      err2 = e;
    }
    expect(err2).to.be.instanceOf(Error);
  });
});
