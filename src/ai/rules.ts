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
  /** insert this property, unticked, into every new note (checkbox rules only) */
  addToNewNotes?: boolean;
}

export interface RulesConfig {
  version: number;
  mode: AiMode;
  rules: RuleBase[];
  /**
   * False turns AI access off for every device of this vault.
   * Missing on older files means on: the file was written by turning access on.
   */
  enabled?: boolean;
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
  private m = new Map<string, RuleMatcher<RuleBase>>();
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

/** How long a new note with the default unticked private checkbox stays unpublished. */
export const NEW_NOTE_DECISION_HOLD_MS = 10 * 60 * 1000;

/**
 * Notes: all matching rules collected; any exclude => denied (privacy beats everything,
 * regardless of rule type). A new note whose private checkbox is still the default
 * `false` is withheld for a short window, then published on its own. Otherwise any
 * include => allowed; else the default mode.
 */
export const evaluateNote = (
  config: RulesConfig,
  registry: RuleMatcherRegistry,
  note: {
    path: string;
    frontmatter?: Record<string, unknown>;
    inlineTags?: string[];
    ctime?: number;
    now?: number;
  },
  holdMs = NEW_NOTE_DECISION_HOLD_MS
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
  if (
    note.ctime !== undefined &&
    note.now !== undefined &&
    noteDecisionPending(config, note.frontmatter, { ctime: note.ctime, now: note.now }, holdMs)
  ) {
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
  /** creation time, ms epoch. With `now`, withholds a new note still at `private: false`. */
  ctime?: (path: string) => number | undefined;
  /** evaluation time, ms epoch. Defaults to Date.now() when `ctime` is set. */
  now?: number;
}

export interface NoteClock {
  ctime: number;
  now: number;
}

const sameBoolean = (value: unknown, expected: boolean) => {
  if (typeof value === "boolean") return value === expected;
  if (typeof value === "string") return lc(value) === String(expected);
  return false;
};

/** Exclude checkboxes stamped onto new notes as the sharing default (private: false). */
const decisionHoldRules = (config: RulesConfig): PropertyRule[] =>
  config.rules.filter(
    (r): r is PropertyRule => r.addToNewNotes === true && r.effect === "exclude" && isCheckboxRule(r)
  );

/**
 * True while a new note still has the automatic "not private" value, so the user can
 * tick the checkbox before the note publishes itself. After the window, `false` publishes.
 * Ticking private is an exclude and is handled before this. Notes without a clock,
 * and the opt-in `ai` preset, are unchanged.
 */
export const noteDecisionPending = (
  config: RulesConfig,
  frontmatter: Record<string, unknown> | undefined,
  clock: NoteClock | undefined,
  holdMs = NEW_NOTE_DECISION_HOLD_MS
): boolean => {
  if (!(holdMs > 0)) return false;
  const rules = decisionHoldRules(config);
  if (rules.length === 0 || !clock) return false;
  if (!Number.isFinite(clock.ctime) || !Number.isFinite(clock.now)) return false;
  const age = clock.now - clock.ctime;
  if (!Number.isFinite(age) || age >= holdMs) return false;
  return rules.some((r) => {
    const found = findKey(frontmatter, r.key);
    if (!found || found.value === undefined || found.value === null) return true;
    return sameBoolean(found.value, !r.value);
  });
};

/**
 * Milliseconds until the soonest withheld note publishes itself.
 * Undefined when nothing is waiting on the private-checkbox pause.
 */
export const decisionHoldRemainingMs = (
  config: RulesConfig,
  snapshot: Pick<VaultSnapshot, "files" | "frontmatter" | "ctime" | "now">,
  holdMs = NEW_NOTE_DECISION_HOLD_MS
): number | undefined => {
  if (!(holdMs > 0) || !snapshot.ctime) return undefined;
  const now = snapshot.now ?? Date.now();
  let soonest: number | undefined;
  for (const p of snapshot.files) {
    if (!isNotePath(p)) continue;
    const ctime = snapshot.ctime(p);
    if (ctime === undefined || !Number.isFinite(ctime)) continue;
    if (!noteDecisionPending(config, snapshot.frontmatter(p), { ctime, now }, holdMs)) continue;
    const left = holdMs - (now - ctime);
    if (soonest === undefined || left < soonest) soonest = left;
  }
  return soonest;
};

/**
 * Whole-vault evaluation. Returns the set of allowed vault paths (notes + attachments).
 * Attachment allowed <=> referenced by an allowed note AND not hit by an applicable exclude rule.
 */
export const computeAllowedPaths = (
  config: RulesConfig,
  snapshot: VaultSnapshot,
  registry: RuleMatcherRegistry = defaultRegistry(),
  holdMs = NEW_NOTE_DECISION_HOLD_MS
): Set<string> => {
  const allowed = new Set<string>();
  const fileSet = new Set(snapshot.files);
  const allowedNotes: string[] = [];
  for (const p of snapshot.files) {
    if (!isNotePath(p)) continue;
    if (
      evaluateNote(
        config,
        registry,
        {
          path: p,
          frontmatter: snapshot.frontmatter(p),
          inlineTags: snapshot.inlineTags?.(p),
          ctime: snapshot.ctime?.(p),
          now: snapshot.ctime ? (snapshot.now ?? Date.now()) : undefined,
        },
        holdMs
      )
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

/** Starter rules: nothing is shared until the note's `ai` checkbox is ticked. */
export const STARTER_RULES: RulesConfig = {
  version: 1,
  mode: "deny_by_default",
  rules: [
    { id: "r1", type: "property", effect: "include", key: "ai", op: "equals", value: true, addToNewNotes: true },
  ],
};

/** Starter rules, opposite preset: everything is shared except notes with `private` ticked. */
export const STARTER_RULES_ALLOW: RulesConfig = {
  version: 1,
  mode: "allow_by_default",
  rules: [
    { id: "r1", type: "property", effect: "exclude", key: "private", op: "equals", value: true, addToNewNotes: true },
  ],
};

export type RulesPreset = "ticked" | "all_but_private" | "custom";

/** Which starter preset a rules file still matches (ids and the new-note flag aside), or "custom". */
export const rulesPreset = (config: RulesConfig): RulesPreset => {
  const same = (preset: RulesConfig) => {
    if (config.mode !== preset.mode || config.rules.length !== preset.rules.length) return false;
    return config.rules.every((r, i) => {
      const p = preset.rules[i];
      if (p === undefined) return false;
      return r.type === p.type && r.effect === p.effect && r.key === p.key && r.op === p.op && r.value === p.value;
    });
  };
  if (same(STARTER_RULES)) return "ticked";
  if (same(STARTER_RULES_ALLOW)) return "all_but_private";
  return "custom";
};

/** A property rule that can be shown as a checkbox: `key equals true|false`. */
export const isCheckboxRule = (r: RuleBase): r is PropertyRule =>
  r.type === "property" && r.op === "equals" && typeof r.value === "boolean" && typeof r.key === "string" && r.key.trim() !== "";

/**
 * Properties to put into a new note: for each checkbox rule marked addToNewNotes, the key with the
 * value that does NOT trigger the rule, so ticking the checkbox applies it. First rule per key wins.
 */
export const newNoteProperties = (config: RulesConfig): Record<string, boolean> => {
  const res: Record<string, boolean> = {};
  for (const r of config.rules) {
    if (r.addToNewNotes === true && isCheckboxRule(r) && !(r.key.trim() in res)) {
      res[r.key.trim()] = !r.value;
    }
  }
  return res;
};

export const RULES_FILE_PATH = ".obsi/ai-rules.json";

/** Shared on/off switch. A file that predates the field stays on. */
export const rulesAccessEnabled = (config: RulesConfig) => config.enabled !== false;

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
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `JSON.parse` is typed as `any`; this only erases that so the value is checked below. */
const parseJson = (text: string): unknown => JSON.parse(text) as unknown;

const isEffect = (v: unknown): v is Effect => v === "include" || v === "exclude";

export const parseRulesJson = (text: string): ParsedRules => {
  const errors: string[] = [];
  let raw: unknown;
  try {
    raw = parseJson(text);
  } catch (e) {
    return { config: { ...DEFAULT_RULES, rules: [] }, errors: [`invalid JSON: ${e}`] };
  }
  const rec = isRecord(raw) ? raw : undefined;
  const modeValue = rec?.mode;
  const mode: AiMode =
    modeValue === "allow_by_default" || modeValue === "deny_by_default"
      ? modeValue
      : "deny_by_default";
  if (modeValue !== mode) {
    errors.push(`unknown mode ${JSON.stringify(modeValue)}, using deny_by_default`);
  }
  const rules: RuleBase[] = [];
  const seen = new Set<string>();
  const list = rec !== undefined && Array.isArray(rec.rules) ? rec.rules : [];
  for (const [i, item] of list.entries()) {
    if (!isRecord(item) || typeof item.type !== "string" || !isEffect(item.effect)) {
      errors.push(`rule #${i} is malformed and was dropped`);
      continue;
    }
    let id = typeof item.id === "string" && item.id !== "" ? item.id : `r${i + 1}`;
    while (seen.has(id)) id = `${id}_`;
    seen.add(id);
    const rule: RuleBase = { ...item, id, type: item.type, effect: item.effect };
    const bad = validateRule(rule);
    if (bad !== undefined) {
      errors.push(`rule ${id}: ${bad}`);
    }
    rules.push(rule);
  }
  return { config: { version: 1, mode, rules, enabled: rec?.enabled !== false }, errors };
};

export const serializeRules = (c: RulesConfig) =>
  `${JSON.stringify({ version: c.version ?? 1, mode: c.mode, rules: c.rules, enabled: c.enabled !== false }, null, 2)}\n`;
