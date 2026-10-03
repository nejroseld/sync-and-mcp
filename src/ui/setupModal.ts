import { type App, Modal, Notice, Setting } from "obsidian";
import { ObsiApi } from "../api/client";
import { obsidianHttp } from "../api/httpObsidian";
import { STARTER_RULES, STARTER_RULES_ALLOW } from "../ai/rules";
import type { VaultInfo } from "../api/types";
import type ObsiSyncPlugin from "../main";

/**
 * Welcome window: shown once on first install, and from the "Set up" command.
 * Either connects the whole vault to one server vault in a single screen, or gets out of the way.
 */
export class SetupModal extends Modal {
  private serverUrl: string;
  private token: string;
  private vaults: VaultInfo[] = [];
  private vaultId = "";
  private password = "";
  private ai: "off" | "ticked" | "all_but_private" = "off";

  constructor(
    app: App,
    private plugin: ObsiSyncPlugin
  ) {
    super(app);
    this.serverUrl = plugin.settings.serverUrl;
    this.token = plugin.settings.deviceToken;
  }

  onOpen() {
    this.titleEl.setText("Obsi Sync");
    this.renderIntro();
  }

  onClose() {
    this.contentEl.empty();
    if (!this.plugin.settings.onboardingDone) {
      this.plugin.settings.onboardingDone = true;
      void this.plugin.saveSettings();
    }
  }

  private renderIntro() {
    const el = this.contentEl;
    el.empty();
    el.createEl("p", {
      text: "End-to-end encrypted sync of this vault between your devices. Optionally, notes you choose can be made available to AI (MCP).",
    });
    el.createEl("p", {
      cls: "setting-item-description",
      text: "Nothing happens until you connect a server. You can skip this and set it up later: Settings → Obsi Sync, or the “Obsi Sync: Set up” command.",
    });
    new Setting(el)
      .addButton((b) =>
        b.setButtonText("Not now").onClick(() => {
          this.close();
        })
      )
      .addButton((b) =>
        b
          .setButtonText("Connect a server")
          .setCta()
          .onClick(() => this.renderConnect())
      );
  }

  private renderConnect() {
    const el = this.contentEl;
    el.empty();
    el.createEl("p", {
      cls: "setting-item-description",
      text: "Server URL and device token come from your server admin (or server/data/TOKENS.txt).",
    });
    new Setting(el).setName("Server URL").addText((t) =>
      t
        .setPlaceholder("http://127.0.0.1:8766")
        .setValue(this.serverUrl)
        .onChange((v) => (this.serverUrl = v.trim()))
    );
    new Setting(el).setName("Device token").addText((t) => {
      t.inputEl.type = "password";
      t.setValue(this.token).onChange((v) => (this.token = v.trim()));
    });
    const status = el.createEl("p", { cls: "setting-item-description" });
    const rest = el.createDiv();
    new Setting(el).addButton((b) =>
      b.setButtonText("Check connection").onClick(async () => {
        status.setText("Checking...");
        rest.empty();
        try {
          const api = new ObsiApi(this.serverUrl, this.token, obsidianHttp);
          const me = await api.me();
          this.vaults = await api.listVaults();
          status.setText(`Connected as “${me.name}”. ${this.vaults.length} vault(s) available.`);
          this.renderVaultStep(rest);
        } catch (e) {
          status.setText(`Could not connect: ${e instanceof Error ? e.message : e}`);
        }
      })
    );
    el.appendChild(rest); // keep the vault step below the button
  }

  private renderVaultStep(el: HTMLElement) {
    if (this.vaults.length === 0) {
      el.createEl("p", { text: "This token has no vaults. Ask the admin to grant one." });
      return;
    }
    this.vaultId = this.vaults[0].id;
    new Setting(el)
      .setName("Server vault")
      .setDesc("Synced with this whole Obsidian vault.")
      .addDropdown((d) => {
        for (const v of this.vaults) d.addOption(v.id, v.name);
        d.setValue(this.vaultId).onChange((v) => (this.vaultId = v));
      });
    new Setting(el)
      .setName("Encryption password")
      .setDesc("Use the same password on every device. The server never sees it and cannot recover it.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.onChange((v) => (this.password = v));
      });
    new Setting(el)
      .setName("AI access (optional)")
      .setDesc(
        "Lets AI clients (MCP) read the notes you allow. Those notes are stored on the server unencrypted; the rest stays end-to-end encrypted. " +
          "New notes get a checkbox property to decide per note. Rules already synced from another device are kept."
      )
      .addDropdown((d) =>
        d
          .addOption("off", "Off")
          .addOption("ticked", "Only notes with “ai” ticked")
          .addOption("all_but_private", "All notes except “private” ticked")
          .setValue(this.ai)
          .onChange((v) => (this.ai = v as typeof this.ai))
      );
    new Setting(el).addButton((b) =>
      b
        .setButtonText("Save and sync")
        .setCta()
        .onClick(async () => {
          if (this.password === "") {
            new Notice("Set an encryption password");
            return;
          }
          await this.save();
          this.close();
          new Notice(
            this.ai === "off"
              ? "Obsi Sync: connected. AI access is off (can be enabled in settings)."
              : "Obsi Sync: connected, AI access on."
          );
          void this.firstSync();
        })
    );
  }

  /** Rules are created only after the first sync, so rules from another device win. */
  private async firstSync() {
    const synced = await this.plugin.syncManager.syncAll("manual");
    if (this.ai === "off") return;
    if (!synced) {
      new Notice("Obsi Sync: first sync failed, AI access not enabled yet. Enable it in settings once sync works.");
      return;
    }
    if ((await this.plugin.rules.load(true)) === null) {
      await this.plugin.rules.save(structuredClone(this.ai === "ticked" ? STARTER_RULES : STARTER_RULES_ALLOW));
    }
    this.plugin.settings.aiEnabled = true;
    await this.plugin.saveSettings();
    this.plugin.publisher.schedule();
  }

  private async save() {
    const s = this.plugin.settings;
    const vault = this.vaults.find((v) => v.id === this.vaultId);
    s.serverUrl = this.serverUrl;
    s.deviceToken = this.token;
    const root = { path: "", vaultId: this.vaultId, vaultName: vault?.name, password: this.password, encryptionMethod: "rclone-base64" as const };
    const i = s.mounts.findIndex((m) => m.path === "");
    if (i >= 0) s.mounts[i] = { ...s.mounts[i], ...root };
    else s.mounts.unshift(root);
    s.onboardingDone = true;
    await this.plugin.saveSettings();
    await this.plugin.refreshMe();
    this.plugin.updateStatus();
  }
}
