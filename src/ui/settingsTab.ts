import { type App, Notice, PluginSettingTab, Setting } from "obsidian";
import {
  STARTER_RULES,
  isCheckboxRule,
  type FolderRule,
  type PropertyRule,
  type RuleBase,
  type RulesConfig,
} from "../ai/rules";
import type { TokenInfo, TokenKind } from "../api/types";
import type ObsiSyncPlugin from "../main";
import {
  type MountConfig,
  exportMounts,
  isConfigured,
  parseMountsImport,
  validateMounts,
} from "../settings";
import { normalizeMountPath } from "../sync/mounts";

const fmtTime = (t?: number) => (t ? new Date(t).toLocaleString() : "never");

export class ObsiSettingTab extends PluginSettingTab {
  private rulesDraft: RulesConfig | null | undefined;
  private rulesErrors: string[] = [];
  private tokens: TokenInfo[] = [];
  private newTokenText = "";
  private importText = "";
  private tokenForm: { name: string; kind: TokenKind; grants: Record<string, Set<string>> } = {
    name: "",
    kind: "device",
    grants: {},
  };

  constructor(
    app: App,
    private plugin: ObsiSyncPlugin
  ) {
    super(app, plugin);
  }

  private async save() {
    await this.plugin.saveSettings();
    this.plugin.updateStatus();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("obsi-sync-settings");
    if (!isConfigured(this.plugin.settings)) {
      new Setting(containerEl)
        .setName("Not set up yet")
        .setDesc("Nothing is synced until a server and a vault are connected. Everything below is optional.")
        .addButton((b) => b.setButtonText("Set up").setCta().onClick(() => this.plugin.openSetup()));
    }
    this.sectionConnection(containerEl);
    this.sectionSync(containerEl);
    this.sectionMounts(containerEl);
    this.sectionAi(containerEl);
    this.sectionAdmin(containerEl);
    void this.loadRules();
  }

  // ------------------------------------------------------------ connection
  private sectionConnection(el: HTMLElement) {
    const s = this.plugin.settings;
    new Setting(el).setName("Connection").setHeading();
    new Setting(el)
      .setName("Server URL")
      .setDesc("For example https://notes.example.com")
      .addText((t) =>
        t.setValue(s.serverUrl).onChange(async (v) => {
          s.serverUrl = v.trim();
          await this.save();
        })
      );
    new Setting(el)
      .setName("Device token")
      .setDesc("Token of kind 'device' with read/write grants on your vaults.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(s.deviceToken).onChange(async (v) => {
          s.deviceToken = v.trim();
          await this.save();
        });
      });
    const info = el.createDiv({ cls: "obsi-sync-info" });
    new Setting(el)
      .setName("Test connection")
      .setDesc("Calls /api/v1/me and lists the vaults this token can access.")
      .addButton((b) =>
        b.setButtonText("Test").onClick(async () => {
          info.setText("Testing...");
          try {
            const api = this.plugin.getApi();
            if (!api) throw Error("server URL and device token are required");
            const h = await api.health();
            const me = await api.me();
            this.plugin.me = me;
            this.plugin.vaults = await api.listVaults();
            const grants = Object.entries(me.grants)
              .map(([v, ops]) => `${v}: ${ops.join("/")}`)
              .join("; ");
            info.setText(
              `OK. Server ${h.version}. Token "${me.name}" (${me.kind}). Grants: ${grants || "none"}`
            );
            if (me.kind !== "device") {
              info.appendText(" Warning: this is not a device token.");
            }
          } catch (e) {
            info.setText(`Failed: ${e}`);
          }
        })
      );
  }

  // ------------------------------------------------------------ sync
  private sectionSync(el: HTMLElement) {
    const s = this.plugin.settings;
    new Setting(el).setName("Sync").setHeading();
    new Setting(el).setName("Sync enabled").addToggle((t) =>
      t.setValue(s.syncEnabled).onChange(async (v) => {
        s.syncEnabled = v;
        await this.save();
      })
    );
    new Setting(el).setName("Sync on startup").addToggle((t) =>
      t.setValue(s.syncOnStartup).onChange(async (v) => {
        s.syncOnStartup = v;
        await this.save();
      })
    );
    new Setting(el)
      .setName("Auto-sync interval (minutes)")
      .setDesc("0 disables periodic sync.")
      .addText((t) =>
        t.setValue(String(s.autoSyncMinutes)).onChange(async (v) => {
          s.autoSyncMinutes = Math.max(0, Number.parseInt(v) || 0);
          await this.save();
        })
      );
    new Setting(el)
      .setName("Conflict strategy")
      .setDesc("When both sides changed a file.")
      .addDropdown((d) =>
        d
          .addOption("keep_newer", "Keep newer")
          .addOption("keep_larger", "Keep larger")
          .setValue(s.conflictAction)
          .onChange(async (v) => {
            s.conflictAction = v === "keep_larger" ? "keep_larger" : "keep_newer";
            await this.save();
          })
      );
    new Setting(el)
      .setName("Sync Obsidian config folder")
      .setDesc("Root mount only. Plugin settings (including tokens/passwords) would be uploaded encrypted.")
      .addToggle((t) =>
        t.setValue(s.syncConfigDir).onChange(async (v) => {
          s.syncConfigDir = v;
          await this.save();
        })
      );
    new Setting(el)
      .setName("Safety limit (%)")
      .setDesc("Abort a sync that would modify/delete this share of files (only with 10+ files). -1 disables.")
      .addText((t) =>
        t.setValue(String(s.protectModifyPercentage)).onChange(async (v) => {
          const n = Number.parseInt(v);
          s.protectModifyPercentage = Number.isNaN(n) ? 50 : n;
          await this.save();
        })
      );
    new Setting(el).setName("Show status bar").addToggle((t) =>
      t.setValue(s.statusBar).onChange(async (v) => {
        s.statusBar = v;
        await this.save();
      })
    );
    new Setting(el).setName("Sync now").addButton((b) =>
      b
        .setButtonText("Sync")
        .setCta()
        .onClick(() => void this.plugin.syncManager.syncAll("manual"))
    );
  }

  // ------------------------------------------------------------ mounts
  private sectionMounts(el: HTMLElement) {
    const s = this.plugin.settings;
    new Setting(el).setName("Vault mounts").setHeading();
    el.createEl("p", {
      cls: "setting-item-description",
      text:
        "Each mount syncs one folder of this Obsidian vault with one server vault, with its own password. " +
        "An empty folder means the whole vault. Nested mounts are excluded from their parent.",
    });
    new Setting(el)
      .setName("Refresh vault list")
      .addButton((b) =>
        b.setButtonText("Refresh").onClick(async () => {
          await this.plugin.refreshMe();
          this.display();
        })
      );

    const problems = validateMounts(s.mounts);
    for (const p of problems) el.createEl("p", { text: p, cls: "obsi-sync-error" });

    s.mounts.forEach((m, idx) => {
      const box = el.createDiv({ cls: "obsi-sync-mount" });
      const st = this.plugin.syncManager.status.get(m.vaultId);
      new Setting(box)
        .setName(`Mount ${idx + 1}`)
        .setDesc(
          st
            ? `Last OK: ${fmtTime(st.lastOk)}${st.lastError ? ` | Error: ${st.lastError}` : ""}`
            : "Not synced yet"
        )
        .addExtraButton((b) =>
          b
            .setIcon("trash")
            .setTooltip("Remove mount (does not delete any data)")
            .onClick(async () => {
              s.mounts.splice(idx, 1);
              await this.save();
              this.display();
            })
        );
      new Setting(box)
        .setName("Folder")
        .setDesc("Path in this vault, empty = vault root")
        .addText((t) =>
          t.setPlaceholder("(root)").setValue(m.path).onChange(async (v) => {
            m.path = normalizeMountPath(v);
            await this.save();
          })
        );
      new Setting(box).setName("Server vault").addDropdown((d) => {
        d.addOption("", "(choose)");
        const known = new Set<string>();
        for (const v of this.plugin.vaults) {
          d.addOption(v.id, `${v.name} (${v.id})`);
          known.add(v.id);
        }
        if (m.vaultId && !known.has(m.vaultId)) d.addOption(m.vaultId, m.vaultName ?? m.vaultId);
        d.setValue(m.vaultId).onChange(async (v) => {
          m.vaultId = v;
          m.vaultName = this.plugin.vaults.find((x) => x.id === v)?.name;
          await this.save();
        });
      });
      new Setting(box)
        .setName("Password")
        .setDesc("Encrypts this vault end-to-end. Stored only on this device. Lost password = lost data.")
        .addText((t) => {
          t.inputEl.type = "password";
          t.setValue(m.password).onChange(async (v) => {
            m.password = v;
            await this.save();
          });
        });
      new Setting(box).setName("Encryption method").addDropdown((d) =>
        d
          .addOption("rclone-base64", "rclone (recommended)")
          .addOption("openssl-base64", "openssl")
          .setValue(m.encryptionMethod)
          .onChange(async (v) => {
            m.encryptionMethod = v === "openssl-base64" ? "openssl-base64" : "rclone-base64";
            await this.save();
          })
      );
      new Setting(box)
        .setName("Forget sync history")
        .setDesc("Use after changing the password or when switching to a different server vault.")
        .addButton((b) =>
          b.setButtonText("Reset").onClick(async () => {
            if (m.vaultId) await this.plugin.syncManager.clearHistory(m.vaultId);
            new Notice("Sync history of this mount cleared");
          })
        );
    });

    new Setting(el).addButton((b) =>
      b.setButtonText("Add mount").onClick(async () => {
        const m: MountConfig = {
          path: "",
          vaultId: "",
          password: "",
          encryptionMethod: "rclone-base64",
        };
        // suggest the first free path: root if there is no root yet
        if (s.mounts.some((x) => x.path === "")) m.path = "New folder";
        s.mounts.push(m);
        await this.save();
        this.display();
      })
    );

    new Setting(el)
      .setName("Export / import mounts")
      .setDesc("JSON without passwords and tokens, for configuring another device.")
      .addButton((b) =>
        b.setButtonText("Copy export").onClick(async () => {
          await navigator.clipboard.writeText(exportMounts(s));
          new Notice("Mount config copied to clipboard");
        })
      );
    new Setting(el)
      .addTextArea((t) => {
        t.setPlaceholder("Paste exported JSON here");
        t.inputEl.rows = 4;
        t.onChange((v) => (this.importText = v));
      })
      .addButton((b) =>
        b.setButtonText("Import").onClick(async () => {
          try {
            const imp = parseMountsImport(this.importText);
            if (imp.serverUrl && !s.serverUrl) s.serverUrl = imp.serverUrl;
            for (const m of imp.mounts) {
              if (!s.mounts.some((x) => x.vaultId === m.vaultId)) s.mounts.push(m);
            }
            await this.save();
            new Notice("Imported. Now enter the passwords of the mounts.");
            this.display();
          } catch (e) {
            new Notice(`Import failed: ${e}`);
          }
        })
      );
  }

  // ------------------------------------------------------------ AI
  private async loadRules() {
    const p = await this.plugin.rules.load(true);
    this.rulesDraft = p === null ? null : p.config;
    this.rulesErrors = p?.errors ?? [];
    this.renderRules();
  }

  private rulesEl: HTMLElement | undefined;

  private sectionAi(el: HTMLElement) {
    const s = this.plugin.settings;
    new Setting(el).setName("AI Available").setHeading();
    el.createEl("p", {
      cls: "setting-item-description",
      text:
        "Publishes the notes allowed by your rules (plaintext) to the server so MCP clients can read them. " +
        "Only devices that have .obsi/ai-rules.json in the root mount publish.",
    });
    new Setting(el).setName("AI Available enabled").addToggle((t) =>
      t.setValue(s.aiEnabled).onChange(async (v) => {
        s.aiEnabled = v;
        await this.save();
        if (v) this.plugin.publisher.schedule();
        else this.plugin.publisher.stop();
      })
    );
    new Setting(el)
      .setName("Clear published data")
      .setDesc("Removes everything this device published for all mounted vaults (/ai/clear). Do this after disabling.")
      .addButton((b) =>
        b
          .setButtonText("Clear")
          .setWarning()
          .onClick(async () => {
            try {
              const errs = await this.plugin.publisher.clearPublished(s.mounts);
              new Notice(errs.length ? `Clear errors: ${errs.join("; ")}` : "Published data cleared");
            } catch (e) {
              new Notice(`Clear failed: ${e}`);
            }
          })
      );
    new Setting(el).setName("Publish now").addButton((b) =>
      b.onClick(async () => {
        const r = await this.plugin.publisher.runNow();
        new Notice(
          r.skipped
            ? `Not published: ${r.skipped}`
            : r.perVault
                .map((v) => `${v.vaultId}: +${v.put} -${v.deleted}${v.error ? ` ERR ${v.error}` : ""}`)
                .join("\n") || "Nothing to do"
        );
      }).setButtonText("Publish")
    );
    new Setting(el)
      .setName("Max file size to publish (MB)")
      .addText((t) =>
        t.setValue(String(s.aiMaxFileMB)).onChange(async (v) => {
          s.aiMaxFileMB = Math.max(1, Number.parseFloat(v) || 25);
          await this.save();
        })
      );
    new Setting(el)
      .setName("Poll pending MCP changes (minutes)")
      .setDesc("0 = only after sync / on command")
      .addText((t) =>
        t.setValue(String(s.changesPollMinutes)).onChange(async (v) => {
          s.changesPollMinutes = Math.max(0, Number.parseInt(v) || 0);
          await this.save();
        })
      );
    this.rulesEl = el.createDiv({ cls: "obsi-sync-rules" });
    this.renderRules();
  }

  private renderRules() {
    const el = this.rulesEl;
    if (!el) return;
    el.empty();
    const draft = this.rulesDraft;
    if (draft === undefined) {
      el.setText("Loading rules...");
      return;
    }
    if (draft === null) {
      new Setting(el)
        .setName("No rules file")
        .setDesc(
          "This device does not publish. Create .obsi/ai-rules.json (synced to other devices of the root vault). " +
            "Starts with: nothing is shared unless the note's “ai” checkbox is ticked; new notes get the checkbox."
        )
        .addButton((b) =>
          b.setButtonText("Create").onClick(async () => {
            await this.plugin.rules.save(structuredClone(STARTER_RULES));
            await this.loadRules();
          })
        );
      return;
    }
    for (const e of this.rulesErrors) el.createEl("p", { text: e, cls: "obsi-sync-error" });

    new Setting(el)
      .setName("Default mode")
      .setDesc("Applies only when no rule matches. Exclude always beats include.")
      .addDropdown((d) =>
        d
          .addOption("deny_by_default", "Deny by default")
          .addOption("allow_by_default", "Allow by default")
          .setValue(draft.mode)
          .onChange((v) => {
            draft.mode = v === "allow_by_default" ? "allow_by_default" : "deny_by_default";
          })
      );

    draft.rules.forEach((r, idx) => {
      const row = new Setting(el).setName(`Rule ${r.id}`);
      row.addDropdown((d) =>
        d
          .addOption("include", "include")
          .addOption("exclude", "exclude")
          .setValue(r.effect)
          .onChange((v) => {
            r.effect = v === "exclude" ? "exclude" : "include";
          })
      );
      if (r.type === "folder") {
        const fr = r as FolderRule;
        row.addText((t) =>
          t.setPlaceholder("folder path").setValue(String(fr.path ?? "")).onChange((v) => {
            fr.path = v.trim().replace(/^\/+|\/+$/g, "");
          })
        );
      } else if (r.type === "property") {
        const pr = r as PropertyRule;
        row.addText((t) =>
          t.setPlaceholder("key").setValue(String(pr.key ?? "")).onChange((v) => {
            pr.key = v.trim();
          })
        );
        row.addDropdown((d) =>
          d
            .addOption("exists", "exists")
            .addOption("equals", "equals")
            .addOption("contains", "contains")
            .setValue(String(pr.op))
            .onChange((v) => {
              pr.op = v as PropertyRule["op"];
            })
        );
        row.addText((t) =>
          t
            .setPlaceholder("value (true/false/number/text)")
            .setValue(pr.value === undefined ? "" : String(pr.value))
            .onChange((v) => {
              pr.value = parseValue(v);
            })
        );
        if (isCheckboxRule(pr)) {
          row.setDesc(`New notes get “${pr.key}: ${!pr.value}” (toggle on the right) — tick it in the note to apply the rule.`);
          row.addToggle((t) =>
            t
              .setTooltip("Add to new notes")
              .setValue(pr.addToNewNotes === true)
              .onChange((v) => {
                pr.addToNewNotes = v;
              })
          );
        }
      } else {
        row.setDesc(`Unknown rule type "${r.type}" (kept as is)`);
      }
      row.addExtraButton((b) =>
        b.setIcon("trash").onClick(() => {
          draft.rules.splice(idx, 1);
          this.renderRules();
        })
      );
    });

    const nextId = () => {
      let n = draft.rules.length + 1;
      while (draft.rules.some((r) => r.id === `r${n}`)) n++;
      return `r${n}`;
    };
    new Setting(el)
      .addButton((b) =>
        b.setButtonText("Add folder rule").onClick(() => {
          draft.rules.push({ id: nextId(), type: "folder", effect: "include", path: "" } as RuleBase);
          this.renderRules();
        })
      )
      .addButton((b) =>
        b.setButtonText("Add property rule").onClick(() => {
          draft.rules.push({
            id: nextId(),
            type: "property",
            effect: "exclude",
            key: "private",
            op: "equals",
            value: true,
          } as RuleBase);
          this.renderRules();
        })
      )
      .addButton((b) =>
        b
          .setButtonText("Save rules")
          .setCta()
          .onClick(async () => {
            await this.plugin.rules.save(draft);
            new Notice("Rules saved to .obsi/ai-rules.json");
            await this.loadRules();
          })
      );
  }

  // ------------------------------------------------------------ admin
  private sectionAdmin(el: HTMLElement) {
    const s = this.plugin.settings;
    const details = el.createEl("details");
    details.createEl("summary", { text: "Admin (vaults, tokens, embeddings)" });
    const body = details.createDiv();
    new Setting(body)
      .setName("Admin token")
      .setDesc("Optional. Used only from this settings page; stored in this device's plugin data.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(s.adminToken).onChange(async (v) => {
          s.adminToken = v.trim();
          await this.save();
        });
      });

    const api = () => {
      const a = this.plugin.getAdminApi();
      if (!a) new Notice("Set server URL and admin token first");
      return a;
    };

    // vaults
    let newVaultName = "";
    new Setting(body)
      .setName("Create vault")
      .addText((t) => t.setPlaceholder("Name").onChange((v) => (newVaultName = v)))
      .addButton((b) =>
        b.setButtonText("Create").onClick(async () => {
          const a = api();
          if (!a || newVaultName.trim() === "") return;
          try {
            const v = await a.createVault(newVaultName.trim());
            new Notice(`Vault created: ${v.id}`);
            this.plugin.vaults = await a.listVaults();
            this.display();
          } catch (e) {
            new Notice(`Failed: ${e}`);
          }
        })
      );
    new Setting(body).setName("Load admin data").addButton((b) =>
      b.setButtonText("Load").onClick(async () => {
        const a = api();
        if (!a) return;
        try {
          this.plugin.vaults = await a.listVaults();
          this.tokens = await a.listTokens();
          this.display();
          (this.containerEl.querySelector("details") as HTMLDetailsElement | null)?.setAttribute("open", "");
        } catch (e) {
          new Notice(`Failed: ${e}`);
        }
      })
    );

    for (const v of this.plugin.vaults) {
      new Setting(body)
        .setName(`${v.name} (${v.id})`)
        .setDesc("RAG (semantic index) for this vault")
        .addToggle((t) =>
          t.setValue(v.rag?.enabled ?? false).onChange(async (on) => {
            const a = api();
            if (!a) return;
            try {
              await a.patchVault(v.id, { rag: { enabled: on } });
              v.rag = { ...(v.rag ?? { enabled: on }), enabled: on };
            } catch (e) {
              new Notice(`Failed: ${e}`);
            }
          })
        );
    }

    // embedding
    const emb = { base_url: "", api_key: "", model: "" };
    new Setting(body)
      .setName("Embedding settings")
      .setDesc("OpenAI-compatible API used by the server for semantic search.")
      .addButton((b) =>
        b.setButtonText("Load").onClick(async () => {
          const a = api();
          if (!a) return;
          try {
            const r = (await a.getAdminSettings()).embedding ?? {};
            emb.base_url = r.base_url ?? "";
            emb.model = r.model ?? "";
            new Notice(`Current: ${emb.base_url || "(none)"} / ${emb.model || "(none)"}`);
          } catch (e) {
            new Notice(`Failed: ${e}`);
          }
        })
      );
    new Setting(body).setName("Base URL").addText((t) => t.setPlaceholder("http://localhost:11434/v1").onChange((v) => (emb.base_url = v.trim())));
    new Setting(body).setName("API key").addText((t) => { t.inputEl.type = "password"; t.onChange((v) => (emb.api_key = v.trim())); });
    new Setting(body)
      .setName("Model")
      .addText((t) => t.setPlaceholder("nomic-embed-text").onChange((v) => (emb.model = v.trim())))
      .addButton((b) =>
        b.setButtonText("Save").onClick(async () => {
          const a = api();
          if (!a) return;
          try {
            await a.putAdminSettings({ embedding: { ...emb } });
            new Notice("Embedding settings saved (changing model/base URL rebuilds indexes)");
          } catch (e) {
            new Notice(`Failed: ${e}`);
          }
        })
      );

    // tokens
    new Setting(body).setName("Create token").setHeading();
    new Setting(body)
      .setName("Name")
      .addText((t) => t.setPlaceholder("phone / claude").setValue(this.tokenForm.name).onChange((v) => (this.tokenForm.name = v)));
    new Setting(body).setName("Kind").addDropdown((d) =>
      d
        .addOption("device", "device (sync, read/write)")
        .addOption("mcp", "mcp (list/search/read/write)")
        .addOption("admin", "admin")
        .setValue(this.tokenForm.kind)
        .onChange((v) => {
          this.tokenForm.kind = v as TokenKind;
          this.tokenForm.grants = {};
          this.display();
        })
    );
    if (this.tokenForm.kind !== "admin") {
      const ops = this.tokenForm.kind === "device" ? ["read", "write"] : ["list", "search", "read", "write"];
      for (const v of this.plugin.vaults) {
        const set = (this.tokenForm.grants[v.id] ??= new Set());
        const row = new Setting(body).setName(`Grants on ${v.name}`).setDesc(v.id);
        for (const op of ops) {
          row.addToggle((t) => {
            t.setTooltip(op).setValue(set.has(op)).onChange((on) => {
              if (on) set.add(op);
              else set.delete(op);
            });
          });
        }
        row.setDesc(`${v.id}  (toggles in order: ${ops.join(", ")})`);
      }
    }
    new Setting(body).addButton((b) =>
      b.setButtonText("Create token").onClick(async () => {
        const a = api();
        if (!a || this.tokenForm.name.trim() === "") {
          new Notice("Name is required");
          return;
        }
        const grants: Record<string, string[]> = {};
        for (const [vid, set] of Object.entries(this.tokenForm.grants)) {
          if (set.size > 0) grants[vid] = [...set];
        }
        try {
          const t = await a.createToken(this.tokenForm.name.trim(), this.tokenForm.kind, grants);
          this.newTokenText = `${t.name}: ${t.token}`;
          this.tokens = await a.listTokens();
          this.display();
        } catch (e) {
          new Notice(`Failed: ${e}`);
        }
      })
    );
    if (this.newTokenText) {
      const box = body.createDiv({ cls: "obsi-sync-newtoken" });
      box.createEl("p", { text: "Copy this token now, it is shown only once:" });
      box.createEl("code", { text: this.newTokenText });
      new Setting(box).addButton((b) =>
        b.setButtonText("Copy").onClick(async () => {
          await navigator.clipboard.writeText(this.newTokenText.split(": ").slice(1).join(": "));
          new Notice("Token copied");
        })
      ).addButton((b) => b.setButtonText("Hide").onClick(() => { this.newTokenText = ""; this.display(); }));
    }

    new Setting(body).setName("Tokens").setHeading();
    for (const t of this.tokens) {
      const grants = Object.entries(t.grants ?? {})
        .map(([v, ops]) => `${v}: ${ops.join("/")}`)
        .join("; ");
      const row = new Setting(body)
        .setName(`${t.name} [${t.kind}]${t.revoked_at ? " (revoked)" : ""}`)
        .setDesc(`${t.id} | ${grants || "no grants"} | last used ${fmtTime(t.last_used_at ?? undefined)}`);
      if (!t.revoked_at) {
        row.addButton((b) =>
          b
            .setButtonText("Revoke")
            .setWarning()
            .onClick(async () => {
              const a = api();
              if (!a) return;
              try {
                await a.revokeToken(t.id);
                this.tokens = await a.listTokens();
                this.display();
              } catch (e) {
                new Notice(`Failed: ${e}`);
              }
            })
        );
      }
    }
  }
}

const parseValue = (v: string): unknown => {
  const t = v.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t !== "" && !Number.isNaN(Number(t))) return Number(t);
  return t;
};
