import { expect } from "chai";
import {
  STARTER_RULES,
  STARTER_RULES_ALLOW,
  computeAllowedPaths,
  isCheckboxRule,
  newNoteProperties,
  parseRulesJson,
  serializeRules,
  type RulesConfig,
} from "../src/ai/rules";
import { DEFAULT_SETTINGS, isConfigured, normalizeSettings } from "../src/settings";

describe("setup state", () => {
  it("fresh install is not configured and shows the welcome window", () => {
    const s = normalizeSettings(undefined);
    expect(isConfigured(s)).to.equal(false);
    expect(s.onboardingDone).to.equal(false);
  });

  it("needs server, token and a mount with vault + password", () => {
    const base = { ...DEFAULT_SETTINGS, serverUrl: "http://x", deviceToken: "t" };
    expect(isConfigured({ ...base, mounts: [] })).to.equal(false);
    const m = { path: "", vaultId: "v_1", password: "", encryptionMethod: "rclone-base64" as const };
    expect(isConfigured({ ...base, mounts: [m] })).to.equal(false);
    expect(isConfigured({ ...base, mounts: [{ ...m, password: "p" }] })).to.equal(true);
    expect(isConfigured({ ...base, serverUrl: "", mounts: [{ ...m, password: "p" }] })).to.equal(false);
  });

  it("already configured installs skip the welcome window", () => {
    const s = normalizeSettings({
      serverUrl: "http://x",
      deviceToken: "t",
      mounts: [{ path: "", vaultId: "v_1", password: "p" }],
    });
    expect(s.onboardingDone).to.equal(true);
    expect(normalizeSettings({ onboardingDone: false }).onboardingDone).to.equal(false);
  });
});

describe("properties for new notes", () => {
  const cfg = (rules: unknown[]): RulesConfig => parseRulesJson(JSON.stringify({ version: 1, mode: "allow_by_default", rules })).config;

  it("inserts the value that does not trigger the rule", () => {
    expect(
      newNoteProperties(
        cfg([
          { id: "a", type: "property", effect: "include", key: "ai", op: "equals", value: true, addToNewNotes: true },
          { id: "b", type: "property", effect: "exclude", key: "private", op: "equals", value: true, addToNewNotes: true },
          { id: "c", type: "property", effect: "exclude", key: "public", op: "equals", value: false, addToNewNotes: true },
        ])
      )
    ).to.deep.equal({ ai: false, private: false, public: true });
  });

  it("ignores unflagged and non-checkbox rules; first rule per key wins", () => {
    const rules = [
      { id: "a", type: "property", effect: "include", key: "ai", op: "equals", value: true },
      { id: "b", type: "property", effect: "include", key: "tags", op: "contains", value: "ai", addToNewNotes: true },
      { id: "c", type: "property", effect: "exclude", key: "k", op: "exists", addToNewNotes: true },
      { id: "d", type: "property", effect: "exclude", key: "lvl", op: "equals", value: "x", addToNewNotes: true },
      { id: "e", type: "folder", effect: "include", path: "P", addToNewNotes: true },
      { id: "f", type: "property", effect: "exclude", key: "p", op: "equals", value: true, addToNewNotes: true },
      { id: "g", type: "property", effect: "include", key: "p", op: "equals", value: false, addToNewNotes: true },
    ];
    expect(newNoteProperties(cfg(rules))).to.deep.equal({ p: false });
    expect(cfg(rules).rules.filter(isCheckboxRule).map((r) => r.id)).to.deep.equal(["a", "f", "g"]);
  });

  it("flag survives the rules file round trip", () => {
    const back = parseRulesJson(serializeRules(STARTER_RULES));
    expect(back.errors).to.deep.equal([]);
    expect(newNoteProperties(back.config)).to.deep.equal({ ai: false });
  });

  it("starter rules: unticked new note is private, ticking shares it", () => {
    const fm: Record<string, Record<string, unknown>> = {
      "new.md": { ...newNoteProperties(STARTER_RULES) },
      "ticked.md": { ai: true },
      "old.md": {},
    };
    const allowed = computeAllowedPaths(STARTER_RULES, {
      files: Object.keys(fm),
      frontmatter: (p) => fm[p],
      resolvedLinks: {},
    });
    expect([...allowed]).to.deep.equal(["ticked.md"]);
  });
});

describe("allow-by-default starter preset", () => {
  it("shares everything except ticked private; new notes get private unticked", () => {
    const fm: Record<string, Record<string, unknown>> = {
      "new.md": { ...newNoteProperties(STARTER_RULES_ALLOW) },
      "secret.md": { private: true },
      "old.md": {},
    };
    expect(newNoteProperties(STARTER_RULES_ALLOW)).to.deep.equal({ private: false });
    const allowed = computeAllowedPaths(STARTER_RULES_ALLOW, { files: Object.keys(fm), frontmatter: (p) => fm[p], resolvedLinks: {} });
    expect([...allowed].sort()).to.deep.equal(["new.md", "old.md"]);
  });
});
