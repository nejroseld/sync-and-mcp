import { expect } from "chai";
import {
  type RuleBase,
  type RulesConfig,
  RuleMatcherRegistry,
  computeAllowedPaths,
  defaultRegistry,
  evaluateNote,
  NEW_NOTE_DECISION_HOLD_MS,
  decisionHoldRemainingMs,
  folderMatcher,
  normalizeTags,
  parseRulesJson,
  serializeRules,
} from "../src/ai/rules";

const cfg = (mode: RulesConfig["mode"], rules: RuleBase[]): RulesConfig => ({
  version: 1,
  mode,
  rules,
});
const folder = (id: string, effect: "include" | "exclude", path: string): RuleBase => ({
  id,
  type: "folder",
  effect,
  path,
});
const prop = (
  id: string,
  effect: "include" | "exclude",
  key: string,
  op: string,
  value?: unknown
): RuleBase => ({ id, type: "property", effect, key, op, value });

const ev = (c: RulesConfig, path: string, fm?: Record<string, unknown>) =>
  evaluateNote(c, defaultRegistry(), { path, frontmatter: fm });

describe("rules: notes", () => {
  it("mode decides when no rule matches", () => {
    expect(ev(cfg("allow_by_default", []), "a.md")).to.equal(true);
    expect(ev(cfg("deny_by_default", []), "a.md")).to.equal(false);
  });

  it("default mode is only used when nothing matches", () => {
    const deny = cfg("deny_by_default", [folder("r1", "include", "Projects")]);
    expect(ev(deny, "Projects/a.md")).to.equal(true);
    expect(ev(deny, "Other/a.md")).to.equal(false);
    const allow = cfg("allow_by_default", [folder("r1", "exclude", "Secret")]);
    expect(ev(allow, "Secret/a.md")).to.equal(false);
    expect(ev(allow, "Other/a.md")).to.equal(true);
  });

  it("include rule beats deny mode; exclude beats allow mode", () => {
    expect(ev(cfg("deny_by_default", [folder("a", "include", "A")]), "A/x.md")).to.equal(true);
    expect(ev(cfg("allow_by_default", [folder("a", "exclude", "A")]), "A/x.md")).to.equal(false);
  });

  it("exclude beats include (folder vs folder)", () => {
    const c = cfg("deny_by_default", [
      folder("r1", "include", "Projects"),
      folder("r2", "exclude", "Projects/Secret"),
    ]);
    expect(ev(c, "Projects/ok.md")).to.equal(true);
    expect(ev(c, "Projects/Secret/x.md")).to.equal(false);
    expect(ev(c, "Projects/Secret/deep/x.md")).to.equal(false);
  });

  it("order of rules does not matter", () => {
    const c = cfg("deny_by_default", [
      folder("r2", "exclude", "Projects/Secret"),
      folder("r1", "include", "Projects"),
    ]);
    expect(ev(c, "Projects/Secret/x.md")).to.equal(false);
  });

  it("exclude beats include regardless of rule type: property exclude vs folder include", () => {
    const c = cfg("deny_by_default", [
      folder("r1", "include", "Projects"),
      prop("r3", "exclude", "private", "equals", true),
    ]);
    expect(ev(c, "Projects/a.md", { private: true })).to.equal(false);
    expect(ev(c, "Projects/a.md", { private: false })).to.equal(true);
    expect(ev(c, "Projects/a.md")).to.equal(true);
  });

  it("exclude beats include regardless of rule type: folder exclude vs property include", () => {
    const c = cfg("deny_by_default", [
      folder("r2", "exclude", "Projects/Secret"),
      prop("r4", "include", "tags", "contains", "ai"),
    ]);
    expect(ev(c, "Projects/Secret/a.md", { tags: ["ai"] })).to.equal(false);
    expect(ev(c, "Elsewhere/a.md", { tags: ["ai"] })).to.equal(true);
    expect(ev(c, "Elsewhere/a.md", { tags: ["other"] })).to.equal(false);
  });

  it("allow_by_default: property include has no effect over exclude either", () => {
    const c = cfg("allow_by_default", [
      prop("a", "include", "publish", "equals", true),
      folder("b", "exclude", "Diary"),
    ]);
    expect(ev(c, "Diary/x.md", { publish: true })).to.equal(false);
  });

  it("folder rule matches the folder itself and everything inside, not siblings with same prefix", () => {
    const c = cfg("deny_by_default", [folder("r", "include", "Proj")]);
    expect(ev(c, "Proj/a.md")).to.equal(true);
    expect(ev(c, "Projects/a.md")).to.equal(false);
    expect(ev(c, "Proj.md")).to.equal(false);
  });

  it("folder rule can point inside a nested mount (unified tree) and with slashes", () => {
    const c = cfg("deny_by_default", [folder("r", "include", "/Work/Client/")]);
    expect(ev(c, "Work/Client/a.md")).to.equal(true);
    expect(ev(c, "Work/Other/a.md")).to.equal(false);
  });

  it("empty folder path matches the whole vault", () => {
    const c = cfg("deny_by_default", [folder("r", "include", "")]);
    expect(ev(c, "any/where.md")).to.equal(true);
  });
});

describe("rules: property matcher", () => {
  const one = (r: RuleBase, fm?: Record<string, unknown>) =>
    ev(cfg("deny_by_default", [{ ...r, effect: "include" }]), "a.md", fm);

  it("exists", () => {
    expect(one(prop("r", "include", "status", "exists"), { status: "x" })).to.equal(true);
    expect(one(prop("r", "include", "status", "exists"), { other: 1 })).to.equal(false);
    expect(one(prop("r", "include", "status", "exists"), { status: null })).to.equal(false);
    expect(one(prop("r", "include", "status", "exists"))).to.equal(false);
  });
  it("keys are case-insensitive", () => {
    expect(one(prop("r", "include", "Private", "equals", true), { PRIVATE: true })).to.equal(true);
  });
  it("equals: booleans, strings, numbers", () => {
    expect(one(prop("r", "include", "p", "equals", true), { p: true })).to.equal(true);
    expect(one(prop("r", "include", "p", "equals", true), { p: false })).to.equal(false);
    expect(one(prop("r", "include", "p", "equals", "Draft"), { p: "draft" })).to.equal(true);
    expect(one(prop("r", "include", "p", "equals", 3), { p: 3 })).to.equal(true);
    expect(one(prop("r", "include", "p", "equals", 3), { p: 4 })).to.equal(false);
  });
  it("contains: lists and strings", () => {
    expect(one(prop("r", "include", "p", "contains", "b"), { p: ["a", "b"] })).to.equal(true);
    expect(one(prop("r", "include", "p", "contains", "z"), { p: ["a", "b"] })).to.equal(false);
    expect(one(prop("r", "include", "p", "contains", "ell"), { p: "Hello" })).to.equal(true);
    expect(one(prop("r", "include", "p", "contains", "x"), { p: 5 })).to.equal(false);
  });
  it("tags accept #tag and tag, lists and strings, nested tags", () => {
    const r = prop("r", "include", "tags", "contains", "ai");
    expect(one(r, { tags: ["#ai"] })).to.equal(true);
    expect(one(r, { tags: ["ai"] })).to.equal(true);
    expect(one(r, { tags: "ai, work" })).to.equal(true);
    expect(one(r, { tags: "#work #ai" })).to.equal(true);
    expect(one(r, { tags: ["ai/deep"] })).to.equal(true);
    expect(one(r, { tags: ["aim"] })).to.equal(false);
    expect(one(prop("r", "include", "tags", "contains", "#ai"), { tags: ["ai"] })).to.equal(true);
    expect(normalizeTags(["#A", "b c"])).to.deep.equal(["a", "b", "c"]);
  });
  it("inline #tags count for tags rules", () => {
    const c = cfg("allow_by_default", [prop("r", "exclude", "tags", "contains", "private")]);
    expect(evaluateNote(c, defaultRegistry(), { path: "a.md", inlineTags: ["#private"] })).to.equal(false);
  });
});

describe("rules: attachments", () => {
  const files = ["N/a.md", "N/b.md", "N/img.png", "S/secret.md", "S/s.png", "N/orphan.png", "N/shared.png"];
  const links = {
    "N/a.md": { "N/img.png": 1, "N/b.md": 1 },
    "S/secret.md": { "S/s.png": 1, "N/shared.png": 1 },
    "N/b.md": { "N/shared.png": 2 },
  };
  const snap = (fm: Record<string, Record<string, unknown>> = {}) => ({
    files,
    frontmatter: (p: string) => fm[p],
    resolvedLinks: links,
  });

  it("attachment allowed iff referenced by an allowed note", () => {
    const c = cfg("deny_by_default", [folder("r", "include", "N")]);
    const allowed = computeAllowedPaths(c, snap());
    expect([...allowed].sort()).to.deep.equal(["N/a.md", "N/b.md", "N/img.png", "N/shared.png"]);
    expect(allowed.has("N/orphan.png")).to.equal(false);
  });

  it("referenced only by a denied note => not allowed", () => {
    const c = cfg("allow_by_default", [folder("r", "exclude", "S")]);
    const allowed = computeAllowedPaths(c, snap());
    expect(allowed.has("S/s.png")).to.equal(false);
    // shared.png is also referenced by allowed N/b.md
    expect(allowed.has("N/shared.png")).to.equal(true);
  });

  it("attachment hit by a folder exclude is denied even if referenced by an allowed note", () => {
    const c = cfg("allow_by_default", [folder("r", "exclude", "N/shared.png")]);
    const allowed = computeAllowedPaths(c, snap());
    expect(allowed.has("N/shared.png")).to.equal(false);
    expect(allowed.has("N/img.png")).to.equal(true);
  });

  it("property rules never apply to attachments", () => {
    // exclude by property would match every note-ish thing; attachments are not affected by it
    const c = cfg("allow_by_default", [prop("r", "exclude", "private", "equals", true)]);
    const allowed = computeAllowedPaths(c, snap({ "N/b.md": { private: true } }));
    expect(allowed.has("N/b.md")).to.equal(false);
    // img.png is referenced by N/a.md (allowed) -> allowed; shared.png via b (denied) and S/secret (allowed)
    expect(allowed.has("N/img.png")).to.equal(true);
    expect(allowed.has("N/shared.png")).to.equal(true);
  });

  it("property exclude on the only referencing note removes the attachment", () => {
    const c = cfg("allow_by_default", [prop("r", "exclude", "private", "equals", true)]);
    const allowed = computeAllowedPaths(c, snap({ "N/a.md": { private: true } }));
    expect(allowed.has("N/img.png")).to.equal(false);
  });

  it("deny mode: attachments are not allowed just by default mode", () => {
    const c = cfg("deny_by_default", []);
    expect(computeAllowedPaths(c, snap()).size).to.equal(0);
  });

  it("note -> note links do not make anything an attachment", () => {
    const c = cfg("deny_by_default", [folder("r", "include", "N/a.md")]);
    const allowed = computeAllowedPaths(c, snap());
    expect(allowed.has("N/b.md")).to.equal(false);
  });
});

describe("rules: registry and file format", () => {
  it("custom matchers can be registered", () => {
    const reg = new RuleMatcherRegistry();
    reg.register(folderMatcher);
    reg.register({
      type: "name",
      appliesTo: (k) => k === "note",
      matches: ({ rule, path }) => path.endsWith(String((rule as any).suffix)),
    });
    const c = cfg("deny_by_default", [{ id: "n", type: "name", effect: "include", suffix: "-pub.md" }]);
    expect(evaluateNote(c, reg, { path: "x-pub.md" })).to.equal(true);
    expect(evaluateNote(c, reg, { path: "x.md" })).to.equal(false);
  });

  it("unknown exclude rule fails closed, unknown include is ignored", () => {
    const reg = defaultRegistry();
    const ex = cfg("allow_by_default", [{ id: "u", type: "future", effect: "exclude" }]);
    expect(evaluateNote(ex, reg, { path: "a.md" })).to.equal(false);
    const inc = cfg("deny_by_default", [{ id: "u", type: "future", effect: "include" }]);
    expect(evaluateNote(inc, reg, { path: "a.md" })).to.equal(false);
  });

  it("parses the documented file and round-trips", () => {
    const text = JSON.stringify({
      version: 1,
      mode: "deny_by_default",
      rules: [
        { id: "r1", type: "folder", effect: "include", path: "Projects" },
        { id: "r2", type: "folder", effect: "exclude", path: "Projects/Secret" },
        { id: "r3", type: "property", effect: "exclude", key: "private", op: "equals", value: true },
        { id: "r4", type: "property", effect: "include", key: "tags", op: "contains", value: "ai" },
      ],
    });
    const p = parseRulesJson(text);
    expect(p.errors).to.deep.equal([]);
    expect(p.config.rules).to.have.length(4);
    expect(parseRulesJson(serializeRules(p.config)).config).to.deep.equal(p.config);
  });

  it("treats a rules file without enabled as AI access on, and keeps an explicit off", () => {
    const on = parseRulesJson(JSON.stringify({ version: 1, mode: "deny_by_default", rules: [] }));
    expect(on.errors).to.deep.equal([]);
    expect(on.config.enabled).to.equal(true);
    const off = parseRulesJson(JSON.stringify({ version: 1, mode: "deny_by_default", rules: [], enabled: false }));
    expect(off.config.enabled).to.equal(false);
    expect(parseRulesJson(serializeRules(off.config)).config.enabled).to.equal(false);
  });

  it("reports malformed input", () => {
    expect(parseRulesJson("{nope").errors).to.have.length(1);
    const p = parseRulesJson(
      JSON.stringify({ mode: "weird", rules: [{ type: "property", effect: "exclude", key: "x", op: "bogus" }] })
    );
    expect(p.errors.length).to.be.greaterThan(0);
    expect(p.config.mode).to.equal("deny_by_default");
  });
});

describe("rules: decision hold before a note is marked private", () => {
  const hold = NEW_NOTE_DECISION_HOLD_MS;
  const now = 1_000_000_000_000;
  const rule: RuleBase = {
    id: "r1",
    type: "property",
    effect: "exclude",
    key: "private",
    op: "equals",
    value: true,
    addToNewNotes: true,
  };
  const c = cfg("allow_by_default", [rule]);
  const young = { ctime: now - 1000, now };

  it("withholds a new note while private is still the default false", () => {
    const reg = defaultRegistry();
    expect(evaluateNote(c, reg, { path: "a.md", frontmatter: { private: false }, ...young })).to.equal(false);
    expect(evaluateNote(c, reg, { path: "a.md", frontmatter: { private: "false" }, ...young })).to.equal(false);
    expect(evaluateNote(c, reg, { path: "a.md", ...young })).to.equal(false);
  });

  it("publishes a new note immediately when the pause is turned off", () => {
    expect(evaluateNote(c, defaultRegistry(), { path: "a.md", frontmatter: { private: false }, ...young }, 0)).to.equal(true);
  });

  it("uses the configured pause instead of the ten-minute default", () => {
    const short = 60_000;
    expect(evaluateNote(c, defaultRegistry(), { path: "a.md", frontmatter: { private: false }, ctime: now - 30_000, now }, short)).to.equal(false);
    expect(evaluateNote(c, defaultRegistry(), { path: "a.md", frontmatter: { private: false }, ctime: now - short - 1, now }, short)).to.equal(true);
  });

  it("publishes on its own after the window if private stays false", () => {
    const old = { ctime: now - hold - 1, now };
    expect(evaluateNote(c, defaultRegistry(), { path: "a.md", frontmatter: { private: false }, ...old })).to.equal(true);
    expect(evaluateNote(c, defaultRegistry(), { path: "old.md", frontmatter: { private: false } })).to.equal(true);
  });

  it("a ticked private note stays hidden without any extra toggle", () => {
    expect(evaluateNote(c, defaultRegistry(), { path: "a.md", frontmatter: { private: true }, ...young })).to.equal(false);
    expect(evaluateNote(c, defaultRegistry(), { path: "a.md", frontmatter: { private: true }, ctime: now - hold - 1, now })).to.equal(false);
  });

  it("does not delay the opt-in ai checkbox", () => {
    const ai = cfg("deny_by_default", [prop("r1", "include", "ai", "equals", true)]);
    (ai.rules[0] as RuleBase).addToNewNotes = true;
    expect(evaluateNote(ai, defaultRegistry(), { path: "a.md", frontmatter: { ai: true }, ...young })).to.equal(true);
    expect(evaluateNote(ai, defaultRegistry(), { path: "a.md", frontmatter: { ai: false }, ...young })).to.equal(false);
  });

  it("withholds a young note and its attachment, then shares it once the window has passed", () => {
    const youngAllowed = computeAllowedPaths(c, {
      files: ["new.md", "old.md", "pic.png"],
      frontmatter: () => ({ private: false }),
      resolvedLinks: { "new.md": { "pic.png": 1 } },
      ctime: (p) => (p === "new.md" ? now - 1000 : now - hold - 1),
      now,
    });
    expect(youngAllowed.has("new.md")).to.equal(false);
    expect(youngAllowed.has("pic.png")).to.equal(false);
    expect(youngAllowed.has("old.md")).to.equal(true);
    const later = computeAllowedPaths(c, {
      files: ["new.md", "pic.png"],
      frontmatter: () => ({ private: false }),
      resolvedLinks: { "new.md": { "pic.png": 1 } },
      ctime: () => now - hold - 1,
      now,
    });
    expect([...later].sort()).to.deep.equal(["new.md", "pic.png"]);
  });

  it("says when the soonest new note will publish itself", () => {
    const left = decisionHoldRemainingMs(
      c,
      {
        files: ["new.md", "old.md", "secret.md"],
        frontmatter: (p) => ({ private: p === "secret.md" }),
        ctime: (p) => (p === "old.md" ? now - hold - 1 : now - 1000),
        now,
      },
      hold
    );
    expect(left).to.equal(hold - 1000);
    expect(decisionHoldRemainingMs(c, { files: ["a.md"], frontmatter: () => ({ private: false }), ctime: () => now - 1000, now }, 0)).to.equal(undefined);
  });
});
