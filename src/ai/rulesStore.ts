import type { App } from "obsidian";
import { mkdirpInVault } from "../sync/misc";
import {
  DEFAULT_RULES,
  type ParsedRules,
  RULES_FILE_PATH,
  type RulesConfig,
  parseRulesJson,
  serializeRules,
} from "./rules";

/** Reads/writes `.obsi/ai-rules.json` of the root mount via the vault adapter. */
export class RulesStore {
  private cached: ParsedRules | null | undefined;
  private listeners: Array<() => void> = [];
  constructor(private app: App) {}

  onChange(cb: () => void) {
    this.listeners.push(cb);
  }

  /** null if the file does not exist (device must not publish) */
  async load(force = true): Promise<ParsedRules | null> {
    if (!force && this.cached !== undefined) {
      return this.cached;
    }
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(RULES_FILE_PATH))) {
      this.cached = null;
    } else {
      try {
        this.cached = parseRulesJson(await adapter.read(RULES_FILE_PATH));
      } catch (e) {
        this.cached = {
          config: { ...DEFAULT_RULES, rules: [] },
          errors: [`cannot read rules file: ${e}`],
        };
      }
    }
    return this.cached;
  }

  async save(config: RulesConfig) {
    await mkdirpInVault(RULES_FILE_PATH, this.app.vault.adapter);
    await this.app.vault.adapter.write(RULES_FILE_PATH, serializeRules(config));
    this.cached = { config, errors: [] };
    this.emit();
  }

  /** call when the file may have changed on disk (sync, manual edit) */
  async reload() {
    const before = JSON.stringify(this.cached);
    await this.load(true);
    if (JSON.stringify(this.cached) !== before) this.emit();
  }

  private emit() {
    for (const l of this.listeners) l();
  }
}
