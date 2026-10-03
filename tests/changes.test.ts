import { expect } from "chai";
import { decideChange, extractFrontmatterText, isSafeRelPath } from "../src/ai/changes";

const base = { allowed: true, ownedByThisVault: true };

describe("pending changes: decision logic", () => {
  it("update applies when local sha == base_version", () => {
    const r = decideChange({
      ...base,
      change: { op: "update", path: "n.md", base_version: "h1" },
      local: { exists: true, sha: "h1" },
    });
    expect(r).to.deep.include({ action: "apply", status: "applied" });
  });
  it("update with different local sha is a conflict", () => {
    const r = decideChange({
      ...base,
      change: { op: "update", path: "n.md", base_version: "h1" },
      local: { exists: true, sha: "h2" },
    });
    expect(r).to.deep.include({ action: "ack_only", status: "conflict" });
  });
  it("update of a missing file is a conflict", () => {
    const r = decideChange({
      ...base,
      change: { op: "update", path: "n.md", base_version: "h1" },
      local: { exists: false },
    });
    expect(r.status).to.equal("conflict");
  });
  it("create applies only when file is absent", () => {
    const c = { op: "create" as const, path: "d/n.md", base_version: null };
    expect(decideChange({ ...base, change: c, local: { exists: false } }).status).to.equal("applied");
    expect(decideChange({ ...base, change: c, local: { exists: true, sha: "x" } }).status).to.equal("conflict");
  });
  it("disallowed path is rejected, before conflict checks", () => {
    const r = decideChange({
      change: { op: "update", path: "n.md", base_version: "h1" },
      local: { exists: true, sha: "other" },
      allowed: false,
      ownedByThisVault: true,
    });
    expect(r).to.deep.include({ action: "ack_only", status: "rejected" });
  });
  it("path owned by another mounted vault is rejected", () => {
    const r = decideChange({
      change: { op: "create", path: "n.md", base_version: null },
      local: { exists: false },
      allowed: true,
      ownedByThisVault: false,
    });
    expect(r.status).to.equal("rejected");
  });
  it("unsafe and non-note paths are rejected", () => {
    for (const p of ["../x.md", "/abs.md", ".obsidian/x.md", "a/.hidden/x.md", "a//b.md", "img.png"]) {
      const r = decideChange({
        ...base,
        change: { op: "create", path: p, base_version: null },
        local: { exists: false },
      });
      expect(r.status, p).to.equal("rejected");
    }
    expect(isSafeRelPath("a/b.md")).to.equal(true);
  });
  it("extracts frontmatter text", () => {
    expect(extractFrontmatterText("---\nprivate: true\n---\nbody")).to.equal("private: true");
    expect(extractFrontmatterText("no fm")).to.equal(undefined);
  });
});
