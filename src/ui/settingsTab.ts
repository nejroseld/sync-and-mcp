import { type App, Notice, PluginSettingTab, Setting } from "obsidian";
import { t as tr } from "../i18n";
import {
  STARTER_RULES,
  isCheckboxRule,
  type FolderRule,
  type PropertyRule,
  type RuleBase,
  type RulesConfig,
} from "../ai/rules";
import type { TokenInfo, TokenKind } from "../api/types";
import { createDeviceAdder } from "../deviceAdder";
import type ObsiSyncPlugin from "../main";
import {
  type MountConfig,
  exportMounts,
  isConfigured,
  parseMountsImport,
  validateMounts,
} from "../settings";
import { normalizeMountPath } from "../sync/mounts";
import { deviceAdderQrUrl } from "./qrTransfer";

const fmtTime = (value?: number) => (value ? new Date(value).toLocaleString() : tr("never"));

export class ObsiSettingTab extends PluginSettingTab {
  private activeSection = "connection";
  private devClicks = 0;
  private devUnlocked = false;
  private displayVersion = 0;
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
    const displayVersion = ++this.displayVersion;
    containerEl.empty();
    containerEl.addClass("obsi-sync-settings");
    if (!isConfigured(this.plugin.settings)) {
      new Setting(containerEl)
        .setName(tr("Not set up yet"))
        .setDesc(tr("Nothing is synced until a server and a vault are connected. Everything below is optional."))
        .addButton((b) => b.setButtonText(tr("Set up")).setCta().onClick(() => this.plugin.openSetup()));
    }
    const sections: Array<[string, string, (el: HTMLElement) => void]> = [
      ["connection", "Connection", (el) => this.sectionConnection(el)],
      ["sync", "Sync", (el) => this.sectionSync(el)],
      ["mounts", "Vault mounts", (el) => this.sectionMounts(el)],
      ["device-adder", "Add another device", (el) => this.sectionDeviceAdder(el)],
      ["ai", "AI", (el) => this.sectionAi(el)],
      ["admin", "Admin", (el) => this.sectionAdmin(el)],
    ];
    if (this.devUnlocked) sections.push(["dev", "Dev", (el) => this.sectionDev(el)]);
    const nav = containerEl.createDiv({ cls: "obsi-sync-settings-tabs" });
    nav.setAttribute("role", "tablist");
    nav.setAttribute("aria-label", tr("Settings sections"));
    const panels: HTMLElement[] = [];
    const selectSection = (id: string) => {
      this.activeSection = id;
      for (const button of Array.from(nav.querySelectorAll<HTMLButtonElement>("[role=tab]"))) {
        const selected = button.dataset.section === id;
        button.setAttribute("aria-selected", String(selected));
        button.tabIndex = selected ? 0 : -1;
      }
      for (const panel of panels) {
        const selected = panel.dataset.section === id;
        panel.hidden = !selected;
        panel.setAttribute("aria-hidden", String(!selected));
        if (panel.dataset.section === "device-adder") {
          panel.empty();
          if (selected) this.sectionDeviceAdder(panel);
        }
      }
    };
    for (const [id, label, render] of sections) {
      const button = nav.createEl("button", { text: tr(label), cls: "obsi-sync-settings-tab" });
      button.type = "button";
      button.setAttribute("role", "tab");
      button.dataset.section = id;
      const panel = containerEl.createDiv({ cls: "obsi-sync-settings-panel" });
      panel.id = `obsi-sync-settings-${id}`;
      panel.dataset.section = id;
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", button.id = `obsi-sync-tab-${id}`);
      panels.push(panel);
      if (id !== "device-adder") render(panel);
      button.addEventListener("click", () => selectSection(id));
      button.addEventListener("keydown", (event) => {
        const buttons = Array.from(nav.querySelectorAll<HTMLButtonElement>("[role=tab]"));
        const index = buttons.indexOf(button);
        let next = -1;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % buttons.length;
        if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index + buttons.length - 1) % buttons.length;
        if (event.key === "Home") next = 0;
        if (event.key === "End") next = buttons.length - 1;
        if (next >= 0) {
          event.preventDefault();
          buttons[next].focus();
          selectSection(buttons[next].dataset.section ?? "connection");
        }
      });
    }
    selectSection(this.activeSection);
    void this.loadRules(displayVersion);
  }

  // ------------------------------------------------------------ connection
  private sectionConnection(el: HTMLElement) {
    const s = this.plugin.settings;
    new Setting(el).setName(tr("Connection")).setHeading();
    new Setting(el)
      .setName(tr("Server URL"))
      .setDesc(tr("For example https://notes.example.com"))
      .addText((t) =>
        t.setValue(s.serverUrl).onChange(async (v) => {
          s.serverUrl = v.trim();
          await this.save();
        })
      );
    new Setting(el)
      .setName(tr("Device token"))
      .setDesc(tr("Token of kind 'device' with read/write grants on your vaults."))
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(s.deviceToken).onChange(async (v) => {
          s.deviceToken = v.trim();
          await this.save();
        });
      });
    const info = el.createDiv({ cls: "obsi-sync-info" });
    new Setting(el)
      .setName(tr("Test connection"))
      .setDesc(tr("Calls /api/v1/me and lists the vaults this token can access."))
      .addButton((b) =>
        b.setButtonText(tr("Test")).onClick(async () => {
          info.setText(tr("Testing..."));
          try {
            const api = this.plugin.getApi();
            if (!api) throw Error(tr("server URL and device token are required"));
            const h = await api.health();
            const me = await api.me();
            this.plugin.me = me;
            this.plugin.vaults = await api.listVaults();
            const grants = Object.entries(me.grants)
              .map(([v, ops]) => `${v}: ${ops.join("/")}`)
              .join("; ");
            info.setText(
              tr("Connection OK. Server {version}. Token “{name}” ({kind}). Grants: {grants}", { version: h.version, name: me.name, kind: me.kind, grants: grants || tr("none") })
            );
            if (me.kind !== "device") {
              info.appendText(` ${tr("Warning: this is not a device token.")}`);
            }
          } catch (e) {
            info.setText(tr("Failed: {error}", { error: String(e) }));
          }
        })
      );
    new Setting(el).setName(tr("Plugin version")).addButton((b) =>
      b.setButtonText(this.plugin.manifest.version).onClick(() => {
        if (this.devUnlocked) return;
        this.devClicks++;
        if (this.devClicks === 7) {
          this.devUnlocked = true;
          this.activeSection = "dev";
          this.display();
          new Notice(tr("Developer tools unlocked"));
        }
      })
    );
  }

  // ------------------------------------------------------------ sync
  private sectionSync(el: HTMLElement) {
    const s = this.plugin.settings;
    new Setting(el).setName(tr("Sync")).setHeading();
    new Setting(el).setName(tr("Sync enabled")).addToggle((t) =>
      t.setValue(s.syncEnabled).onChange(async (v) => {
        s.syncEnabled = v;
        await this.save();
      })
    );
    new Setting(el).setName(tr("Sync on save")).setDesc(tr("Sync changed notes after they are saved.")).addToggle((t) =>
      t.setValue(s.syncOnSave).onChange(async (v) => {
        s.syncOnSave = v;
        await this.save();
      })
    );
    new Setting(el).setName(tr("Sync on startup")).addToggle((t) =>
      t.setValue(s.syncOnStartup).onChange(async (v) => {
        s.syncOnStartup = v;
        await this.save();
      })
    );
    new Setting(el)
      .setName(tr("Auto-sync interval (minutes)"))
      .setDesc(tr("0 disables periodic sync."))
      .addText((t) =>
        t.setValue(String(s.autoSyncMinutes)).onChange(async (v) => {
          s.autoSyncMinutes = Math.max(0, Number.parseInt(v) || 0);
          await this.save();
        })
      );
    new Setting(el)
      .setName(tr("Conflict strategy"))
      .setDesc(tr("When both sides changed a file."))
      .addDropdown((d) =>
        d
          .addOption("keep_newer", tr("Keep newer"))
          .addOption("keep_larger", tr("Keep larger"))
          .setValue(s.conflictAction)
          .onChange(async (v) => {
            s.conflictAction = v === "keep_larger" ? "keep_larger" : "keep_newer";
            await this.save();
          })
      );
    new Setting(el)
      .setName(tr("Sync Obsidian config folder"))
      .setDesc(tr("Root mount only. Plugin settings (including tokens/passwords) would be uploaded encrypted."))
      .addToggle((t) =>
        t.setValue(s.syncConfigDir).onChange(async (v) => {
          s.syncConfigDir = v;
          await this.save();
        })
      );
    new Setting(el)
      .setName(tr("Safety limit (%)"))
      .setDesc(tr("Abort a sync that would modify/delete this share of files (only with 10+ files). -1 disables."))
      .addText((t) =>
        t.setValue(String(s.protectModifyPercentage)).onChange(async (v) => {
          const n = Number.parseInt(v);
          s.protectModifyPercentage = Number.isNaN(n) ? 50 : n;
          await this.save();
        })
      );
    new Setting(el).setName(tr("Show status bar")).addToggle((t) =>
      t.setValue(s.statusBar).onChange(async (v) => {
        s.statusBar = v;
        await this.save();
      })
    );
    new Setting(el).setName(tr("Sync now")).addButton((b) =>
      b
        .setButtonText(tr("Run sync"))
        .setCta()
        .onClick(() => void this.plugin.syncManager.syncAll("manual"))
    );
  }

  // ------------------------------------------------------------ mounts
  private sectionMounts(el: HTMLElement) {
    const s = this.plugin.settings;
    new Setting(el).setName(tr("Vault mounts")).setHeading();
    el.createEl("p", {
      cls: "setting-item-description",
      text:
        tr("Each mount syncs one folder of this Obsidian vault with one server vault, with its own password. An empty folder means the whole vault. Nested mounts are excluded from their parent."),
    });
    new Setting(el)
      .setName(tr("Refresh vault list"))
      .addButton((b) =>
        b.setButtonText(tr("Refresh")).onClick(async () => {
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
         .setName(tr("Mount {number}", { number: idx + 1 }))
        .setDesc(
          st
            ? `${tr("Last OK: {time}", { time: fmtTime(st.lastOk) })}${st.lastError ? ` | ${tr("Error: {error}", { error: st.lastError })}` : ""}`
            : tr("Not synced yet")
        )
        .addExtraButton((b) =>
          b
            .setIcon("trash")
            .setTooltip(tr("Remove mount (does not delete any data)"))
            .onClick(async () => {
              s.mounts.splice(idx, 1);
              await this.save();
              this.display();
            })
        );
      new Setting(box)
        .setName(tr("Folder"))
        .setDesc(tr("Path in this vault, empty = vault root"))
        .addText((t) =>
          t.setPlaceholder(tr("(root)")).setValue(m.path).onChange(async (v) => {
            m.path = normalizeMountPath(v);
            await this.save();
          })
        );
      new Setting(box).setName(tr("Server vault")).addDropdown((d) => {
        d.addOption("", tr("(choose)"));
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
        .setName(tr("Password"))
        .setDesc(tr("Encrypts this vault end-to-end. Stored only on this device. Lost password = lost data."))
        .addText((t) => {
          t.inputEl.type = "password";
          t.setValue(m.password).onChange(async (v) => {
            m.password = v;
            await this.save();
          });
        });
      new Setting(box)
        .setName(tr("Forget sync history"))
        .setDesc(tr("Use after changing the password or when switching to a different server vault."))
        .addButton((b) =>
          b.setButtonText(tr("Reset")).onClick(async () => {
            if (m.vaultId) await this.plugin.syncManager.clearHistory(m.vaultId);
            new Notice(tr("Sync history of this mount cleared"));
          })
        );
    });

    new Setting(el).addButton((b) =>
      b.setButtonText(tr("Add mount")).onClick(async () => {
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
      .setName(tr("Export / import mounts"))
      .setDesc(tr("JSON without passwords and tokens, for configuring another device."))
      .addButton((b) =>
        b.setButtonText(tr("Copy export")).onClick(async () => {
          await navigator.clipboard.writeText(exportMounts(s));
          new Notice(tr("Mount config copied to clipboard"));
        })
      );
    new Setting(el)
      .addTextArea((t) => {
        t.setPlaceholder(tr("Paste exported JSON here"));
        t.inputEl.rows = 4;
        t.onChange((v) => (this.importText = v));
      })
      .addButton((b) =>
        b.setButtonText(tr("Import")).onClick(async () => {
          try {
            const imp = parseMountsImport(this.importText);
            if (imp.serverUrl && !s.serverUrl) s.serverUrl = imp.serverUrl;
            for (const m of imp.mounts) {
              if (!s.mounts.some((x) => x.vaultId === m.vaultId)) s.mounts.push(m);
            }
            await this.save();
            new Notice(tr("Imported. Now enter the passwords of the mounts."));
            this.display();
          } catch (e) {
            new Notice(tr("Import failed: {error}", { error: String(e) }));
          }
        })
      );
  }

  private sectionDeviceAdder(el: HTMLElement) {
    new Setting(el).setName(tr("Add another device")).setHeading();
    el.createEl("p", {
      cls: "setting-item-description",
      text: tr("This device-adder contains the server address, device token, vault mounts and encryption passwords. The text and QR reveal these secrets to anyone who sees them. Share privately and delete saved copies after use. The same device token is reused."),
    });
    const output = el.createDiv({ cls: "obsi-sync-device-adder" });
    try {
      const payload = createDeviceAdder(this.plugin.settings);
      const textArea = output.createEl("textarea", { cls: "obsi-sync-device-adder-text" });
      textArea.value = payload;
      textArea.readOnly = true;
      textArea.setAttribute("aria-label", tr("Device-adder text"));
      textArea.rows = 5;
      const actions = output.createDiv({ cls: "obsi-sync-device-adder-actions" });
      const copy = actions.createEl("button", { text: tr("Copy device-adder") });
      copy.type = "button";
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(payload);
          new Notice(tr("Device-adder copied"));
        } catch (e) {
          new Notice(tr("Could not copy: {error}", { error: String(e) }));
        }
      });
      void deviceAdderQrUrl(payload).then((qrUrl) => {
        if (!el.isConnected || el.hidden || this.activeSection !== "device-adder") return;
        const img = output.createEl("img", { cls: "obsi-sync-device-adder-qr" });
        img.src = qrUrl;
        img.alt = tr("Device-adder QR code containing credentials");
        const download = actions.createEl("a", { text: tr("Save QR image"), attr: { href: qrUrl, download: "obsi-sync-device-adder.png" } });
        download.addClass("mod-cta");
      }).catch((e) => {
        if (!el.isConnected || el.hidden || this.activeSection !== "device-adder") return;
        output.createEl("p", { cls: "setting-item-description", text: tr("QR could not be created; use the text instead. {error}", { error: String(e) }) });
      });
    } catch (e) {
      output.createEl("p", { cls: "obsi-sync-error", text: tr("Device-adder could not be created: {error}", { error: String(e) }) });
    }
  }

  // ------------------------------------------------------------ AI
  private async loadRules(displayVersion = this.displayVersion) {
    const p = await this.plugin.rules.load(true);
    if (displayVersion !== this.displayVersion) return;
    this.rulesDraft = p === null ? null : p.config;
    this.rulesErrors = p?.errors ?? [];
    this.renderRules();
  }

  private rulesEl: HTMLElement | undefined;

  private sectionAi(el: HTMLElement) {
    const s = this.plugin.settings;
    new Setting(el).setName(tr("AI Available")).setHeading();
    el.createEl("p", {
      cls: "setting-item-description",
      text:
        tr("Publishes the notes allowed by your rules (plaintext) to the server so MCP clients can read them. Only devices that have .obsi/ai-rules.json in the root mount publish."),
    });
    new Setting(el).setName(tr("AI Available enabled")).addToggle((t) =>
      t.setValue(s.aiEnabled).onChange(async (v) => {
        s.aiEnabled = v;
        await this.save();
        if (v) this.plugin.publisher.schedule();
        else this.plugin.publisher.stop();
      })
    );
    new Setting(el)
      .setName(tr("Clear published data"))
      .setDesc(tr("Removes everything this device published for all mounted vaults (/ai/clear). Do this after disabling."))
      .addButton((b) =>
        b
          .setButtonText(tr("Clear"))
          .setWarning()
          .onClick(async () => {
            try {
              const errs = await this.plugin.publisher.clearPublished(s.mounts);
              new Notice(errs.length ? tr("Clear errors: {errors}", { errors: errs.join("; ") }) : tr("Published data cleared"));
            } catch (e) {
              new Notice(tr("Clear failed: {error}", { error: String(e) }));
            }
          })
      );
    new Setting(el).setName(tr("Publish now")).addButton((b) =>
      b.onClick(async () => {
        const r = await this.plugin.publisher.runNow();
        new Notice(
          r.skipped
            ? tr("Not published: {reason}", { reason: r.skipped })
            : r.perVault
                .map((v) => `${v.vaultId}: +${v.put} -${v.deleted}${v.error ? ` ERR ${v.error}` : ""}`)
                .join("\n") || tr("Nothing to do")
        );
      }).setButtonText(tr("Publish"))
    );
    new Setting(el)
      .setName(tr("Max file size to publish (MB)"))
      .addText((t) =>
        t.setValue(String(s.aiMaxFileMB)).onChange(async (v) => {
          s.aiMaxFileMB = Math.max(1, Number.parseFloat(v) || 25);
          await this.save();
        })
      );
    new Setting(el)
      .setName(tr("Poll pending MCP changes (minutes)"))
      .setDesc(tr("0 = only after sync / on command"))
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
      el.setText(tr("Loading rules..."));
      return;
    }
    if (draft === null) {
      new Setting(el)
        .setName(tr("No rules file"))
        .setDesc(
          tr("This device does not publish. Create .obsi/ai-rules.json (synced to other devices of the root vault). Starts with: nothing is shared unless the note's “ai” checkbox is ticked; new notes get the checkbox.")
        )
        .addButton((b) =>
          b.setButtonText(tr("Create")).onClick(async () => {
            await this.plugin.rules.save(structuredClone(STARTER_RULES));
            await this.loadRules();
          })
        );
      return;
    }
    for (const e of this.rulesErrors) el.createEl("p", { text: e, cls: "obsi-sync-error" });

    new Setting(el)
      .setName(tr("Default mode"))
      .setDesc(tr("Applies only when no rule matches. Exclude always beats include."))
      .addDropdown((d) =>
        d
          .addOption("deny_by_default", tr("Deny by default"))
          .addOption("allow_by_default", tr("Allow by default"))
          .setValue(draft.mode)
          .onChange((v) => {
            draft.mode = v === "allow_by_default" ? "allow_by_default" : "deny_by_default";
          })
      );

    draft.rules.forEach((r, idx) => {
      const row = new Setting(el) .setName(tr("Rule {id}", { id: r.id }));
      row.settingEl.addClass("obsi-sync-rule-row");
      row.addDropdown((d) =>
        d
          .addOption("include", tr("include"))
          .addOption("exclude", tr("exclude"))
          .setValue(r.effect)
          .onChange((v) => {
            r.effect = v === "exclude" ? "exclude" : "include";
          })
      );
      if (r.type === "folder") {
        const fr = r as FolderRule;
        row.addText((t) =>
          t.setPlaceholder(tr("folder path")).setValue(String(fr.path ?? "")).onChange((v) => {
            fr.path = v.trim().replace(/^\/+|\/+$/g, "");
          })
        );
      } else if (r.type === "property") {
        const pr = r as PropertyRule;
        row.addText((t) =>
          t.setPlaceholder(tr("key")).setValue(String(pr.key ?? "")).onChange((v) => {
            pr.key = v.trim();
          })
        );
        row.addDropdown((d) =>
          d
            .addOption("exists", tr("exists"))
            .addOption("equals", tr("equals"))
            .addOption("contains", tr("contains"))
            .setValue(String(pr.op))
            .onChange((v) => {
              pr.op = v as PropertyRule["op"];
            })
        );
        row.addText((t) =>
          t
            .setPlaceholder(tr("value (true/false/number/text)"))
            .setValue(pr.value === undefined ? "" : String(pr.value))
            .onChange((v) => {
              pr.value = parseValue(v);
            })
        );
        if (isCheckboxRule(pr)) {
          row.setDesc(tr("New notes get “{key}: {value}” (toggle on the right) — tick it in the note to apply the rule.", { key: pr.key, value: String(!pr.value) }));
          row.addToggle((t) =>
            t
              .setTooltip(tr("Add to new notes"))
              .setValue(pr.addToNewNotes === true)
              .onChange((v) => {
                pr.addToNewNotes = v;
              })
          );
        }
      } else {
        row.setDesc(tr("Unknown rule type “{type}” (kept as is)", { type: r.type }));
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
        b.setButtonText(tr("Add folder rule")).onClick(() => {
          draft.rules.push({ id: nextId(), type: "folder", effect: "include", path: "" } as RuleBase);
          this.renderRules();
        })
      )
      .addButton((b) =>
        b.setButtonText(tr("Add property rule")).onClick(() => {
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
          .setButtonText(tr("Save rules"))
          .setCta()
          .onClick(async () => {
            await this.plugin.rules.save(draft);
            new Notice(tr("Rules saved to .obsi/ai-rules.json"));
            await this.loadRules();
          })
      );
  }

  // ------------------------------------------------------------ admin
  private sectionAdmin(el: HTMLElement) {
    const s = this.plugin.settings;
    const body = el;
    new Setting(body).setName(tr("Admin")).setHeading();
    new Setting(body)
      .setName(tr("Admin token"))
      .setDesc(tr("Optional. Used only from this settings page; stored in this device's plugin data."))
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(s.adminToken).onChange(async (v) => {
          s.adminToken = v.trim();
          await this.save();
        });
      });

    const api = () => {
      const a = this.plugin.getAdminApi();
      if (!a) new Notice(tr("Set server URL and admin token first"));
      return a;
    };

    // vaults
    let newVaultName = "";
    new Setting(body)
      .setName(tr("Create vault"))
      .addText((t) => t.setPlaceholder(tr("Name")).onChange((v) => (newVaultName = v)))
      .addButton((b) =>
        b.setButtonText(tr("Create")).onClick(async () => {
          const a = api();
          if (!a || newVaultName.trim() === "") return;
          try {
            const v = await a.createVault(newVaultName.trim());
            new Notice(tr("Vault created: {id}", { id: v.id }));
            this.plugin.vaults = await a.listVaults();
            this.display();
          } catch (e) {
            new Notice(tr("Failed: {error}", { error: String(e) }));
          }
        })
      );
    new Setting(body).setName(tr("Load admin data")).addButton((b) =>
      b.setButtonText(tr("Load")).onClick(async () => {
        const a = api();
        if (!a) return;
        try {
          this.plugin.vaults = await a.listVaults();
          this.tokens = await a.listTokens();
          this.display();
        } catch (e) {
          new Notice(tr("Failed: {error}", { error: String(e) }));
        }
      })
    );

    for (const v of this.plugin.vaults) {
      new Setting(body)
        .setName(`${v.name} (${v.id})`)
        .setDesc(tr("RAG (semantic index) for this vault"))
        .addToggle((t) =>
          t.setValue(v.rag?.enabled ?? false).onChange(async (on) => {
            const a = api();
            if (!a) return;
            try {
              await a.patchVault(v.id, { rag: { enabled: on } });
              v.rag = { ...(v.rag ?? { enabled: on }), enabled: on };
            } catch (e) {
              new Notice(tr("Failed: {error}", { error: String(e) }));
            }
          })
        );
    }

    // embedding
    const emb = { base_url: "", api_key: "", model: "" };
    new Setting(body)
      .setName(tr("Embedding settings"))
      .setDesc(tr("OpenAI-compatible API used by the server for semantic search."))
      .addButton((b) =>
        b.setButtonText(tr("Load")).onClick(async () => {
          const a = api();
          if (!a) return;
          try {
            const r = (await a.getAdminSettings()).embedding ?? {};
            emb.base_url = r.base_url ?? "";
            emb.model = r.model ?? "";
            new Notice(tr("Current: {url} / {model}", { url: emb.base_url || tr("none"), model: emb.model || tr("none") }));
          } catch (e) {
            new Notice(tr("Failed: {error}", { error: String(e) }));
          }
        })
      );
    new Setting(body).setName(tr("Base URL")).addText((t) => t.setPlaceholder(tr("http://localhost:11434/v1")).onChange((v) => (emb.base_url = v.trim())));
    new Setting(body).setName(tr("API key")).addText((t) => { t.inputEl.type = "password"; t.onChange((v) => (emb.api_key = v.trim())); });
    new Setting(body)
      .setName(tr("Model"))
      .addText((t) => t.setPlaceholder(tr("nomic-embed-text")).onChange((v) => (emb.model = v.trim())))
      .addButton((b) =>
        b.setButtonText(tr("Save")).onClick(async () => {
          const a = api();
          if (!a) return;
          try {
            await a.putAdminSettings({ embedding: { ...emb } });
            new Notice(tr("Embedding settings saved (changing model/base URL rebuilds indexes)"));
          } catch (e) {
            new Notice(tr("Failed: {error}", { error: String(e) }));
          }
        })
      );

    // tokens
    new Setting(body).setName(tr("Create token")).setHeading();
    new Setting(body)
      .setName(tr("Name"))
      .addText((t) => t.setPlaceholder(tr("phone / claude")).setValue(this.tokenForm.name).onChange((v) => (this.tokenForm.name = v)));
    new Setting(body).setName(tr("Kind")).addDropdown((d) =>
      d
        .addOption("device", tr("device (sync, read/write)"))
        .addOption("mcp", tr("mcp (list/search/read/write)"))
        .addOption("admin", tr("admin"))
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
        const row = new Setting(body) .setName(tr("Grants on {vault}", { vault: v.name })).setDesc(v.id);
        for (const op of ops) {
          row.addToggle((t) => {
            t.setTooltip(op).setValue(set.has(op)).onChange((on) => {
              if (on) set.add(op);
              else set.delete(op);
            });
          });
        }
        row.setDesc(tr("{id} (toggles in order: {ops})", { id: v.id, ops: ops.join(", ") }));
      }
    }
    new Setting(body).addButton((b) =>
      b.setButtonText(tr("Create token")).onClick(async () => {
        const a = api();
        if (!a || this.tokenForm.name.trim() === "") {
          new Notice(tr("Name is required"));
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
          new Notice(tr("Failed: {error}", { error: String(e) }));
        }
      })
    );
    if (this.newTokenText) {
      const box = body.createDiv({ cls: "obsi-sync-newtoken" });
      box.createEl("p", { text: tr("Copy this token now, it is shown only once:") });
      box.createEl("code", { text: this.newTokenText });
      new Setting(box).addButton((b) =>
        b.setButtonText(tr("Copy")).onClick(async () => {
          await navigator.clipboard.writeText(this.newTokenText.split(": ").slice(1).join(": "));
          new Notice(tr("Token copied"));
        })
      ).addButton((b) => b.setButtonText(tr("Hide")).onClick(() => { this.newTokenText = ""; this.display(); }));
    }

    new Setting(body).setName(tr("Tokens")).setHeading();
    for (const t of this.tokens) {
      const grants = Object.entries(t.grants ?? {})
        .map(([v, ops]) => `${v}: ${ops.join("/")}`)
        .join("; ");
      const row = new Setting(body)
         .setName(`${t.name} [${t.kind}]${t.revoked_at ? ` (${tr("revoked")})` : ""}`)
         .setDesc(tr("{id} | {grants} | last used {time}", { id: t.id, grants: grants || tr("no grants"), time: fmtTime(t.last_used_at ?? undefined) }));
      if (!t.revoked_at) {
        row.addButton((b) =>
          b
            .setButtonText(tr("Revoke"))
            .setWarning()
            .onClick(async () => {
              const a = api();
              if (!a) return;
              try {
                await a.revokeToken(t.id);
                this.tokens = await a.listTokens();
                this.display();
              } catch (e) {
                new Notice(tr("Failed: {error}", { error: String(e) }));
              }
            })
        );
      }
    }
  }

  private sectionDev(el: HTMLElement) {
    new Setting(el).setName(tr("Dev")).setHeading();
    new Setting(el)
      .setName(tr("Show welcome screen"))
      .setDesc(tr("Reopens first-run setup. Saving there can update the connection and mounts."))
      .addButton((b) => b.setButtonText(tr("Show welcome screen")).onClick(() => this.plugin.openSetup()));
  }
}

const parseValue = (v: string): unknown => {
  const t = v.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t !== "" && !Number.isNaN(Number(t))) return Number(t);
  return t;
};
