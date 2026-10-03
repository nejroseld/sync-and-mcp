import { expect } from "chai";
import { computePublishDiff, groupAllowedByMount, kindOf, sha256Hex, type DesiredFile } from "../src/ai/publish";

const d = (relPath: string, version: string): DesiredFile => ({
  relPath,
  vaultPath: relPath,
  version,
  mtime: 1,
  size: 1,
  kind: "note",
});

describe("publisher diff", () => {
  it("puts new and changed, deletes extra, ignores equal", () => {
    const diff = computePublishDiff(
      [d("a.md", "1"), d("b.md", "2"), d("c.md", "3")],
      [
        { path: "a.md", version: "1" },
        { path: "b.md", version: "old" },
        { path: "gone.md", version: "9" },
      ]
    );
    expect(diff.put.map((x) => x.relPath)).to.deep.equal(["b.md", "c.md"]);
    expect(diff.del).to.deep.equal(["gone.md"]);
  });
  it("empty desired deletes everything (AI turned off by rules)", () => {
    const diff = computePublishDiff([], [{ path: "a.md", version: "1" }]);
    expect(diff.put).to.deep.equal([]);
    expect(diff.del).to.deep.equal(["a.md"]);
  });
  it("no-op when identical", () => {
    const diff = computePublishDiff([d("a.md", "1")], [{ path: "a.md", version: "1" }]);
    expect(diff).to.deep.equal({ put: [], del: [] });
  });
});

describe("publisher: grouping by mount", () => {
  it("files go to the deepest mount; files outside any mount are dropped", () => {
    const mounts = [
      { path: "", vaultId: "root" },
      { path: "Work", vaultId: "w" },
    ];
    const g = groupAllowedByMount(["a.md", "Work/b.md", "Work/x/c.md"], mounts);
    expect(g.get(mounts[0])).to.deep.equal(["a.md"]);
    expect(g.get(mounts[1])).to.deep.equal(["Work/b.md", "Work/x/c.md"]);
    const g2 = groupAllowedByMount(["a.md"], [mounts[1]]);
    expect(g2.size).to.equal(0);
  });
  it("kind and sha256", async () => {
    expect(kindOf("a.md")).to.equal("note");
    expect(kindOf("a.png")).to.equal("attachment");
    expect(await sha256Hex(new TextEncoder().encode("abc"))).to.equal(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});
