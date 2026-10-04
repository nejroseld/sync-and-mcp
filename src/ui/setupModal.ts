import { type App, type ButtonComponent, Modal, Notice, Setting } from "obsidian";
import { t as tr } from "../i18n";
import { ObsiApi } from "../api/client";
import { obsidianHttp } from "../api/httpObsidian";
import { STARTER_RULES, STARTER_RULES_ALLOW } from "../ai/rules";
import type { VaultInfo } from "../api/types";
import { parseDeviceAdder } from "../deviceAdder";
import { isConfigured } from "../settings";
import { readDeviceAdderQr } from "./qrTransfer";
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
  private autoMount = false;
  private ai: "off" | "ticked" | "all_but_private" = "off";
  private deviceAdderText = "";

  constructor(
    app: App,
    private plugin: ObsiSyncPlugin
  ) {
    super(app);
    this.serverUrl = plugin.settings.serverUrl;
    this.token = plugin.settings.deviceToken;
  }

  onOpen() {
    this.titleEl.setText(tr("Obsi Sync"));
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
      text: tr("End-to-end encrypted sync of this vault between your devices. Optionally, notes you choose can be made available to AI (MCP)."),
    });
    el.createEl("p", {
      cls: "setting-item-description",
      text: tr("Nothing happens until you connect a server. You can skip this and set it up later: Settings → Obsi Sync, or the “Obsi Sync: Set up” command."),
    });
    new Setting(el)
      .addButton((b) =>
        b.setButtonText(tr("Not now")).onClick(() => {
          this.close();
        })
      )
      .addButton((b) =>
        b
          .setButtonText(tr("Connect a server"))
          .setCta()
          .onClick(() => this.renderConnect())
      );
    new Setting(el)
      .setName(tr("Already connected on another device?"))
      .setDesc(tr("Paste a device-adder or choose a QR image to set up this vault."))
      .addButton((b) => b.setButtonText(tr("Add from another device")).onClick(() => this.renderDeviceAdderImport()));
  }

  private renderDeviceAdderImport() {
    const el = this.contentEl;
    el.empty();
    el.createEl("p", {
      cls: "setting-item-description",
      text: tr("A device-adder contains a live device token and encryption passwords. Import only one you trust."),
    });
    const textArea = el.createEl("textarea", { cls: "obsi-sync-device-adder-text" });
    textArea.rows = 5;
    textArea.placeholder = tr("Paste device-adder text here");
    textArea.setAttribute("aria-label", tr("Device-adder text"));
    textArea.value = this.deviceAdderText;
    textArea.addEventListener("input", () => {
      this.deviceAdderText = textArea.value;
      review.empty();
      status.setText("");
    });
    const status = el.createEl("p", { cls: "setting-item-description", attr: { role: "status" } });
    const review = el.createDiv();
    const decode = async (file: File | undefined) => {
      if (!file) return;
      status.setText(tr("Reading QR image..."));
      review.empty();
      try {
        this.deviceAdderText = await readDeviceAdderQr(file);
        textArea.value = this.deviceAdderText;
        status.setText(tr("QR read. Review the connection before importing."));
        showReview();
      } catch (e) {
        status.setText(tr("Could not read QR: {error}", { error: String(e) }));
      }
    };
    const addImageButton = (label: string, capture: boolean) => {
      const input = el.createEl("input", { type: "file", attr: { accept: "image/*" } });
      input.hidden = true;
      if (capture) input.setAttribute("capture", "environment");
      input.addEventListener("change", () => {
        void decode(input.files?.[0]);
        input.value = "";
      });
      return (b: ButtonComponent) => b.setButtonText(tr(label)).onClick(() => input.click());
    };
    new Setting(el)
      .addButton(addImageButton("Choose QR image", false))
      .addButton(addImageButton("Capture QR", true));
    const showReview = () => {
      review.empty();
      try {
        const data = parseDeviceAdder(this.deviceAdderText.trim());
        status.setText(tr("Device-adder is valid. Review before importing."));
        review.createEl("p", { text: tr("Server: {server}; vaults: {vaults}", {
          server: data.serverUrl,
          vaults: data.mounts.map((m) => m.vaultName || m.vaultId).join(", "),
        }) });
        if (isConfigured(this.plugin.settings)) {
          review.createEl("p", { cls: "obsi-sync-warning", text: tr("Import replaces this device's server address, device token and vault mounts. Existing local files are not deleted.") });
        }
        new Setting(review).addButton((b) => b.setButtonText(tr("Import connection")).setCta().onClick(async () => {
          try {
            const s = this.plugin.settings;
            const previous = JSON.stringify([s.serverUrl, s.deviceToken, s.mounts]);
            const next = JSON.stringify([data.serverUrl, data.deviceToken, data.mounts]);
            if (previous !== next) {
              for (const id of new Set([...s.mounts, ...data.mounts].map((m) => m.vaultId))) {
                if (id) await this.plugin.syncManager.clearHistory(id);
              }
            }
            s.serverUrl = data.serverUrl;
            s.deviceToken = data.deviceToken;
            s.mounts = data.mounts;
            s.onboardingDone = true;
            await this.plugin.saveSettings();
            this.plugin.me = undefined;
            this.plugin.vaults = [];
            await this.plugin.refreshMe();
            this.plugin.updateStatus();
            this.close();
            new Notice(tr("Connection imported. Review the vault contents, then run sync from Settings → Obsi Sync."));
          } catch (e) {
            status.setText(tr("Import failed: {error}", { error: String(e) }));
          }
        }));
      } catch (e) {
        status.setText(tr("Invalid device-adder: {error}", { error: String(e) }));
      }
    };
    new Setting(el)
      .addButton((b) => b.setButtonText(tr("Review device-adder")).onClick(showReview))
      .addButton((b) => b.setButtonText(tr("Back")).onClick(() => this.renderIntro()));
  }

  private renderConnect() {
    const el = this.contentEl;
    el.empty();
    el.createEl("p", {
      cls: "setting-item-description",
      text: tr("Server URL and device token come from your server admin (or server/data/TOKENS.txt)."),
    });
    new Setting(el).setName(tr("Server URL")).addText((t) =>
      t
        .setPlaceholder(tr("http://127.0.0.1:8766"))
        .setValue(this.serverUrl)
        .onChange((v) => (this.serverUrl = v.trim()))
    );
    new Setting(el).setName(tr("Device token")).addText((t) => {
      t.inputEl.type = "password";
      t.setValue(this.token).onChange((v) => (this.token = v.trim()));
    });
    const status = el.createEl("p", { cls: "setting-item-description" });
    const rest = el.createDiv();
    new Setting(el).addButton((b) =>
      b.setButtonText(tr("Check connection")).onClick(async () => {
        status.setText(tr("Checking..."));
        rest.empty();
        try {
          const api = new ObsiApi(this.serverUrl, this.token, obsidianHttp);
          const me = await api.me();
          this.vaults = await api.listVaults();
          status.setText(tr("Connected as “{name}”. {count} vault(s) available.", { name: me.name, count: this.vaults.length }));
          this.renderVaultStep(rest);
        } catch (e) {
          status.setText(tr("Could not connect: {error}", { error: String(e instanceof Error ? e.message : e) }));
        }
      })
    );
    el.appendChild(rest); // keep the vault step below the button
  }

  private renderVaultStep(el: HTMLElement) {
    if (this.vaults.length === 0) {
      el.createEl("p", { text: tr("This token has no vaults. Ask the admin to grant one.") });
      return;
    }
    this.vaultId = this.vaults[0].id;
    let saveButton: HTMLButtonElement | undefined;
    const updateSaveLabel = (enabled: boolean) => {
      if (saveButton) saveButton.textContent = enabled ? tr("Save and sync") : tr("Save connection");
    };
    new Setting(el)
      .setName(tr("Server vault"))
      .setDesc(tr("Choose the server vault to connect to."))
      .addDropdown((d) => {
        for (const v of this.vaults) d.addOption(v.id, v.name);
        d.setValue(this.vaultId).onChange((v) => (this.vaultId = v));
      });
    new Setting(el)
      .setName(tr("Automatically sync this entire Obsidian vault"))
      .setDesc(tr("Creates a root mount for this vault, so all its files sync with the selected server vault."))
      .addToggle((t) =>
        t.setValue(this.autoMount).onChange((v) => {
          this.autoMount = v;
          passwordSetting.settingEl.toggle(v);
          aiSetting.settingEl.toggle(v);
          updateSaveLabel(v);
        })
      );
    const passwordSetting = new Setting(el)
      .setName(tr("Encryption password"))
      .setDesc(tr("Required when automatic sync is enabled. Use the same password on every device."))
      .addText((t) => {
        t.inputEl.type = "password";
        t.onChange((v) => (this.password = v));
      });
    const aiSetting = new Setting(el)
      .setName(tr("AI access (optional)"))
      .setDesc(
        tr("Lets AI clients (MCP) read the notes you allow. Those notes are stored on the server unencrypted; the rest stays end-to-end encrypted. New notes get a checkbox property to decide per note. Rules already synced from another device are kept.")
      )
      .addDropdown((d) =>
        d
          .addOption("off", tr("Off"))
          .addOption("ticked", tr("Only notes with “ai” ticked"))
          .addOption("all_but_private", tr("All notes except “private” ticked"))
          .setValue(this.ai)
          .onChange((v) => (this.ai = v as typeof this.ai))
      );
    passwordSetting.settingEl.toggle(this.autoMount);
    aiSetting.settingEl.toggle(this.autoMount);
    new Setting(el).addButton((b) => {
      saveButton = b.buttonEl;
      b
        .setButtonText(this.autoMount ? tr("Save and sync") : tr("Save connection"))
        .setCta()
        .onClick(async () => {
          if (this.autoMount && this.password === "") {
            new Notice(tr("Set an encryption password"));
            return;
          }
          await this.save(this.autoMount);
          this.close();
          if (!this.autoMount) {
            new Notice(tr("Obsi Sync: server connection saved. Add a vault mount in Settings → Obsi Sync → Vault mounts to start syncing."));
            return;
          }
          new Notice(tr(this.ai === "off" ? "Obsi Sync: connected. AI access is off (can be enabled in settings)." : "Obsi Sync: connected, AI access on."));
          void this.firstSync();
        });
    });
  }

  /** Rules are created only after the first sync, so rules from another device win. */
  private async firstSync() {
    const synced = await this.plugin.syncManager.syncAll("manual");
    if (this.ai === "off") return;
    if (!synced) {
      new Notice(tr("Obsi Sync: first sync failed, AI access not enabled yet. Enable it in settings once sync works."));
      return;
    }
    if ((await this.plugin.rules.load(true)) === null) {
      await this.plugin.rules.save(structuredClone(this.ai === "ticked" ? STARTER_RULES : STARTER_RULES_ALLOW));
    }
    this.plugin.settings.aiEnabled = true;
    await this.plugin.saveSettings();
    this.plugin.publisher.schedule();
  }

  private async save(createRootMount: boolean) {
    const s = this.plugin.settings;
    const vault = this.vaults.find((v) => v.id === this.vaultId);
    s.serverUrl = this.serverUrl;
    s.deviceToken = this.token;
    if (createRootMount) {
      const root = { path: "", vaultId: this.vaultId, vaultName: vault?.name, password: this.password, encryptionMethod: "rclone-base64" as const };
      const i = s.mounts.findIndex((m) => m.path === "");
      if (i >= 0) s.mounts[i] = { ...s.mounts[i], ...root };
      else s.mounts.unshift(root);
    }
    s.onboardingDone = true;
    await this.plugin.saveSettings();
    await this.plugin.refreshMe();
    this.plugin.updateStatus();
  }
}
