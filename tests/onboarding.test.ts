import { expect } from "chai";
import {
  STARTER_RULES,
  STARTER_RULES_ALLOW,
  computeAllowedPaths,
  rulesPreset,
  isCheckboxRule,
  newNoteProperties,
  parseRulesJson,
  serializeRules,
  type RulesConfig,
} from "../src/ai/rules";
import { ApiError } from "../src/api/client";
import { accountProblem, checkVaultPassword, connectProblem, normalizeServerUrl, parseInvitation } from "../src/onboarding";
import { DEFAULT_SETTINGS, isConfigured, normalizeSettings, validateMounts } from "../src/settings";
import { syncer } from "../src/sync/sync";
import { FakeFsEncrypt } from "../src/sync/fsEncrypt";
import { MemoryPrevSyncStore } from "../src/sync/syncDb";
import { MemFs } from "./helpers/memFs";

describe("setup state", () => {
  it("fresh install is not configured and shows the welcome window", () => {
    const s = normalizeSettings(undefined);
    expect(isConfigured(s)).to.equal(false);
    expect(s.onboardingDone).to.equal(false);
    expect(s.syncOnSave).to.equal(true);
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

  it("keeps legacy OpenSSL mounts unsupported instead of switching their cipher", () => {
    const s = normalizeSettings({
      mounts: [{ path: "Archive", vaultId: "v_old", password: "p", encryptionMethod: "openssl-base64" }],
    });
    expect(s.mounts[0].encryptionMethod).to.equal("unknown");
    expect(isConfigured({ ...s, serverUrl: "http://x", deviceToken: "t" })).to.equal(false);
    expect(validateMounts(s.mounts).join(" ")).to.include("unsupported encryption method");
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

describe("welcome window helpers", () => {
  it("normalizes a typed server address", () => {
    expect(normalizeServerUrl("  ")).to.equal("");
    expect(normalizeServerUrl("obsi.example.com/")).to.equal("https://obsi.example.com");
    expect(normalizeServerUrl("localhost:8766")).to.equal("http://localhost:8766");
    expect(normalizeServerUrl("192.168.1.5:8766//")).to.equal("http://192.168.1.5:8766");
    expect(normalizeServerUrl("http://obsi.lan:8766/api/v1/")).to.equal("http://obsi.lan:8766");
    expect(normalizeServerUrl("HTTPS://Obsi.example.com")).to.equal("HTTPS://Obsi.example.com");
  });

  it("explains why a connection failed", () => {
    expect(connectProblem(new ApiError(401, "unauthorized", "bad token"))).to.equal("bad_token");
    expect(connectProblem(new ApiError(403, "forbidden", "no"))).to.equal("bad_token");
    expect(connectProblem(new ApiError(404, "not_found", "no"))).to.equal("bad_url");
    expect(connectProblem(new ApiError(500, "boom", "x"))).to.equal("server_error");
    expect(connectProblem(new Error("net::ERR_CONNECTION_REFUSED"))).to.equal("unreachable");
    expect(connectProblem(new TypeError("Failed to parse URL from x"))).to.equal("bad_url");
  });

  it("checks the encryption password against the server vault", async () => {
    const remote = new MemFs("remote");
    expect(await checkVaultPassword(remote, "secret")).to.equal("empty_vault");
    const local = new MemFs("local", { "a.md": "hello" });
    const res = await syncer(local, remote, new FakeFsEncrypt(remote, "secret", "rclone-base64"), new MemoryPrevSyncStore(), "manual", "v", ".obsidian", { protectModifyPercentage: -1 });
    expect(res.ok).to.equal(true);
    expect(await checkVaultPassword(remote, "secret")).to.equal("match");
    expect(await checkVaultPassword(remote, "wrong")).to.equal("mismatch");
  });
});

describe("rules presets", () => {
  it("recognizes the starter presets and treats anything else as custom", () => {
    expect(rulesPreset(STARTER_RULES)).to.equal("ticked");
    expect(rulesPreset(STARTER_RULES_ALLOW)).to.equal("all_but_private");
    const renamed = { ...STARTER_RULES, rules: [{ ...STARTER_RULES.rules[0], id: "x", addToNewNotes: false }] };
    expect(rulesPreset(renamed)).to.equal("ticked");
    expect(rulesPreset({ ...STARTER_RULES, mode: "allow_by_default" })).to.equal("custom");
    expect(rulesPreset({ ...STARTER_RULES, rules: [...STARTER_RULES.rules, { id: "f", type: "folder", effect: "include", path: "P" }] })).to.equal("custom");
  });
});

describe("invitations", () => {
  it("reads the server and the code from a forwarded message", () => {
    const text = "Obsi Sync invitation for alice\nServer: https://203-0-113-10.sslip.io/\nCode: inv_Ab-c_9\nIn Obsidian: ...";
    expect(parseInvitation(text)).to.deep.equal({ serverUrl: "https://203-0-113-10.sslip.io", code: "inv_Ab-c_9" });
  });

  it("works with Russian labels and punctuation around the address", () => {
    expect(parseInvitation("Сервер: «https://obsi.example.com». Код: inv_x1")).to.deep.equal({ serverUrl: "https://obsi.example.com", code: "inv_x1" });
  });

  it("accepts a bare code", () => {
    expect(parseInvitation("  inv_abc  ")).to.deep.equal({ serverUrl: undefined, code: "inv_abc" });
    expect(parseInvitation("legacycode")).to.deep.equal({ serverUrl: undefined, code: "legacycode" });
    expect(parseInvitation("")).to.deep.equal({ serverUrl: undefined, code: undefined });
  });

  it("maps account errors to fixable problems", () => {
    expect(accountProblem(new ApiError(401, "invalid_credentials", "x"))).to.equal("bad_credentials");
    expect(accountProblem(new ApiError(401, "invalid_invite", "x"))).to.equal("bad_invite");
    expect(accountProblem(new ApiError(409, "username_taken", "x"))).to.equal("username_taken");
    expect(accountProblem(new ApiError(404, "not_found", "x"))).to.equal(undefined);
    expect(accountProblem(new Error("network"))).to.equal(undefined);
  });
});
