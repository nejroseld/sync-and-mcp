/**
 * AI Available rules engine (docs/ARCHITECTURE.md, "AI Available -> Правила / Вычисление").
 * Pure logic, no Obsidian dependency.
 */

export type AiMode = "allow_by_default" | "deny_by_default";
export type FileKind = "note" | "attachment";
export type Effect = "include" | "exclude";

export interface RuleBase {
  id: string;
  type: string;
  effect: Effect;
  [extra: string]: unknown;
}

export interface FolderRule extends RuleBase {
  type: "folder";
  path: string;
}

export type PropertyOp = "exists" | "equals" | "contains";

export interface PropertyRule extends RuleBase {
  type: "property";
  key: string;
  op: PropertyOp;
  value?: unknown;
}

export interface RulesConfig {
  version: number;
  mode: AiMode;
  rules: RuleBase[];
}

export interface MatchContext<R extends RuleBase = RuleBase> {
  rule: R;
  /** vault-absolute path, no leading slash */
  path: string;
  kind: FileKind;
  /** parsed frontmatter of the note (notes only) */
  frontmatter?: Record<string, unknown>;
  /** inline #tags found in the note body (optional, notes only) */
  inlineTags?: string[];
}

export interface RuleMatcher<R extends RuleBase = RuleBase> {
  type: string;
  appliesTo(kind: FileKind): boolean;
  matches(ctx: MatchContext<R>): boolean;
}

// ---------------------------------------------------------------- registry

export class RuleMatcherRegistry {
  private m = new Map<string, RuleMatcher<any>>();
  register<R extends RuleBase>(matcher: RuleMatcher<R>) {
    this.m.set(matcher.type, matcher);
  }
  get(type: string): RuleMatcher | undefined {
    return this.m.get(type);
  }
  types() {
    return [...this.m.keys()];
  }
}

// ---------------------------------------------------------------- helpers

export const normalizeVaultPath = (p: string) =>
  p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");

const lc = (x: unknown) => String(x).trim().toLowerCase();

const isPrimitive = (x: unknown) =>
  typeof x === "string" || typeof x === "number" || typeof x === "boolean";

const findKey = (fm: Record<string, unknown> | undefined, key: string) => {
  if (fm === undefined || fm === null) {
    return undefined;
  }
  const k = key.trim().toLowerCase();
  for (const name of Object.keys(fm)) {
    if (name.toLowerCase() === k) {
      return { name, value: fm[name] };
    }
  }
  return undefined;
};

/** "#a", "a", "a, #b", ["a","#b"] => ["a","b"] (lower-case, no #) */
export const normalizeTags = (v: unknown): string[] => {
  const items: string[] = [];
  const push = (x: unknown) => {
    if (x === undefined || x === null) return;
    if (Array.isArray(x)) {
      for (const y of x) push(y);
    } else if (typeof x === "string") {
      for (const part of x.split(/[,\s]+/)) {
        const t = part.replace(/^#+/, "").trim().toLowerCase();
        if (t !== "") items.push(t);
      }
    } else if (isPrimitive(x)) {
      items.push(lc(x).replace(/^#+/, ""));
    }
  };
  push(v);
  return items;
};

const isTagsKey = (key: string) => {
  const k = key.trim().toLowerCase();
  return k === "tags" || k === "tag";
};

const tagMatches = (have: string, want: string) =>
  have === want || have.startsWith(`${want}/`);

// ---------------------------------------------------------------- matchers

export const folderMatcher: RuleMatcher<FolderRule> = {
  type: "folder",
  appliesTo: () => true,
  matches: ({ rule, path }) => {
    const base = normalizeVaultPath(String(rule.path ?? ""));
    const p = normalizeVaultPath(path);
    if (base === "") {
      return true; // whole vault
    }
    return p === base || p.startsWith(`${base}/`);
  },
};

export const propertyMatcher: RuleMatcher<PropertyRule> = {
  type: "property",
  // property rules never apply to attachments
  appliesTo: (kind) => kind === "note",
  matches: ({ rule, frontmatter, inlineTags }) => {
    const key = String(rule.key ?? "");
    if (key === "") {
      return false;
    }
    const found = findKey(frontmatter, key);

    if (isTagsKey(key)) {
      const have = [
        ...normalizeTags(found?.value),
        ...(inlineTags ?? []).flatMap((t) => normalizeTags(t)),
      ];
      if (rule.op === "exists") {
        return have.length > 0;
      }
      const wants = normalizeTags(rule.value);
      if (wants.length === 0) {
        return false;
      }
      // equals / contains: every wanted tag present (single tag in practice)
      return wants.every((w) => have.some((h) => tagMatches(h, w)));
    }

    if (found === undefined || found.value === null || found.value === undefined) {
      return false;
    }
    const v = found.value;
    if (rule.op === "exists") {
      return true;
    }
    const want = rule.value;
    if (rule.op === "equals") {
      if (Array.isArray(v)) {
        return (
          Array.isArray(want) &&
          v.length === want.length &&
          v.every((x, i) => isPrimitive(x) && isPrimitive(want[i]) && lc(x) === lc(want[i]))
        );
      }
      return isPrimitive(v) && isPrimitive(want) && lc(v) === lc(want);
    }
    if (rule.op === "contains") {
      if (want === undefined || want === null || !isPrimitive(want)) {
        return false;
      }
      if (Array.isArray(v)) {
        return v.some((x) => isPrimitive(x) && lc(x) === lc(want));
      }
      if (typeof v === "string") {
        return lc(v).includes(lc(want));
      }
      return false;
    }
    return false;
  },
};

export const defaultRegistry = (): RuleMatcherRegistry => {
  const r = new RuleMatcherRegistry();
  r.register(folderMatcher);
  r.register(propertyMatcher);
  return r;
};

// ---------------------------------------------------------------- evaluation

/**
 * Rules of `kind` that match. Unknown rule types: an unknown *exclude* rule cannot be
 * evaluated, so it fails closed (counts as matching); an unknown include rule is ignored.
 */
export const matchingRules = (
  config: RulesConfig,
  registry: RuleMatcherRegistry,
  ctxBase: Omit<MatchContext, "rule">
): RuleBase[] => {
  const res: RuleBase[] = [];
  for (const rule of config.rules) {
    const matcher = registry.get(rule.type);
    if (matcher === undefined) {
      if (rule.effect === "exclude") {
        res.push(rule);
      }
      continue;
    }
    if (!matcher.appliesTo(ctxBase.kind)) {
      continue;
    }
    if (matcher.matches({ ...ctxBase, rule })) {
      res.push(rule);
    }
  }
  return res;
};

/**
 * Notes: all matching rules collected; any exclude => denied (privacy beats everything,
 * regardless of rule type); else any include => allowed; else the default mode.
 */
export const evaluateNote = (
  config: RulesConfig,
  registry: RuleMatcherRegistry,
  note: { path: string; frontmatter?: Record<string, unknown>; inlineTags?: string[] }
): boolean => {
  const matched = matchingRules(config, registry, {
    path: note.path,
    kind: "note",
    frontmatter: note.frontmatter,
    inlineTags: note.inlineTags,
  });
  if (matched.some((r) => r.effect === "exclude")) {
    return false;
  }
  if (matched.some((r) => r.effect === "include")) {
    return true;
  }
  return config.mode === "allow_by_default";
};

/** true if an exclude rule applicable to attachments matches this attachment path */
export const attachmentExcluded = (
  config: RulesConfig,
  registry: RuleMatcherRegistry,
  path: string
): boolean =>
  matchingRules(config, registry, { path, kind: "attachment" }).some(
    (r) => r.effect === "exclude"
  );

export const isNotePath = (p: string) => p.toLowerCase().endsWith(".md");

export interface VaultSnapshot {
  /** all vault file paths (vault-absolute) */
  files: string[];
  /** frontmatter by note path */
  frontmatter: (path: string) => Record<string, unknown> | undefined;
  inlineTags?: (path: string) => string[] | undefined;
  /** Obsidian metadataCache.resolvedLinks: source path -> { target path -> count } */
  resolvedLinks: Record<string, Record<string, number>>;
}

/**
 * Whole-vault evaluation. Returns the set of allowed vault paths (notes + attachments).
 * Attachment allowed <=> referenced by an allowed note AND not hit by an applicable exclude rule.
 */
export const computeAllowedPaths = (
  config: RulesConfig,
  snapshot: VaultSnapshot,
  registry: RuleMatcherRegistry = defaultRegistry()
): Set<string> => {
  const allowed = new Set<string>();
  const fileSet = new Set(snapshot.files);
  const allowedNotes: string[] = [];
  for (const p of snapshot.files) {
    if (!isNotePath(p)) continue;
    if (
      evaluateNote(config, registry, {
        path: p,
        frontmatter: snapshot.frontmatter(p),
        inlineTags: snapshot.inlineTags?.(p),
      })
    ) {
      allowed.add(p);
      allowedNotes.push(p);
    }
  }
  const attachmentCandidates = allowedAttachmentCandidates(
    allowedNotes,
    snapshot.resolvedLinks,
    fileSet
  );
  for (const a of attachmentCandidates) {
    if (!attachmentExcluded(config, registry, a)) {
      allowed.add(a);
    }
  }
  return allowed;
};

/** non-note files referenced from the given (allowed) notes */
export const allowedAttachmentCandidates = (
  allowedNotes: string[],
  resolvedLinks: Record<string, Record<string, number>>,
  existing?: Set<string>
): Set<string> => {
  const res = new Set<string>();
  for (const n of allowedNotes) {
    const targets = resolvedLinks[n];
    if (!targets) continue;
    for (const t of Object.keys(targets)) {
      if (isNotePath(t)) continue;
      if (existing && !existing.has(t)) continue;
      res.add(t);
    }
  }
  return res;
};

// ---------------------------------------------------------------- file format

export const DEFAULT_RULES: RulesConfig = {
  version: 1,
  mode: "deny_by_default",
  rules: [],
};

export const RULES_FILE_PATH = ".obsi/ai-rules.json";

export interface ParsedRules {
  config: RulesConfig;
  errors: string[];
}

export const validateRule = (r: RuleBase): string | undefined => {
  if (r.type === "folder") {
    return typeof r.path === "string" ? undefined : "folder rule needs a string path";
  }
  if (r.type === "property") {
    if (typeof r.key !== "string" || r.key.trim() === "") {
      return "property rule needs a key";
    }
    if (!["exists", "equals", "contains"].includes(String(r.op))) {
      return `property rule has unknown op ${JSON.stringify(r.op)}`;
    }
    if (r.op !== "exists" && r.value === undefined) {
      return "property rule needs a value";
    }
  }
  return undefined;
};

/**
 * Lenient parser (never throws). Malformed rules are dropped and reported in `errors`;
 * callers that publish data must treat any error as "do not publish" (fail closed).
 */
export const parseRulesJson = (text: string): ParsedRules => {
  const errors: string[] = [];
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { config: { ...DEFAULT_RULES, rules: [] }, errors: [`invalid JSON: ${e}`] };
  }
  const mode: AiMode =
    raw?.mode === "allow_by_default" || raw?.mode === "deny_by_default"
      ? raw.mode
      : "deny_by_default";
  if (raw?.mode !== mode) {
    errors.push(`unknown mode ${JSON.stringify(raw?.mode)}, using deny_by_default`);
  }
  const rules: RuleBase[] = [];
  const seen = new Set<string>();
  for (const [i, r] of (Array.isArray(raw?.rules) ? raw.rules : []).entries()) {
    if (
      !r ||
      typeof r.type !== "string" ||
      (r.effect !== "include" && r.effect !== "exclude")
    ) {
      errors.push(`rule #${i} is malformed and was dropped`);
      continue;
    }
    let id = typeof r.id === "string" && r.id !== "" ? r.id : `r${i + 1}`;
    while (seen.has(id)) id = `${id}_`;
    seen.add(id);
    const bad = validateRule(r);
    if (bad !== undefined) {
      errors.push(`rule ${id}: ${bad}`);
    }
    rules.push({ ...r, id });
  }
  return { config: { version: 1, mode, rules }, errors };
};

export const serializeRules = (c: RulesConfig) =>
  `${JSON.stringify({ version: c.version ?? 1, mode: c.mode, rules: c.rules }, null, 2)}\n`;
