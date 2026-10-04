import { type App, ButtonComponent, Modal, Setting, setIcon } from "obsidian";
import { t as tr } from "../i18n";
import { ObsiApi } from "../api/client";
import { obsidianHttp } from "../api/httpObsidian";
import { STARTER_RULES, STARTER_RULES_ALLOW } from "../ai/rules";
import type { VaultInfo } from "../api/types";
import { type DeviceAdder, parseDeviceAdder } from "../deviceAdder";
import { checkVaultPassword, connectProblem, normalizeServerUrl } from "../onboarding";
import { callout, choiceCard, choiceGroup, errorText, textField } from "./kit";
import { isConfigured } from "../settings";
import { FakeFsObsiServer } from "../sync/fsObsiServer";
import { readDeviceAdderQr } from "./qrTransfer";
import type ObsiSyncPlugin from "../main";

type Step = "welcome" | "server" | "vault" | "password" | "ai" | "import" | "finish";
type AiChoice = "off" | "ticked" | "all_but_private";
/** syncing → ok/failed for a full setup; "folders" = connection only; "review" = import over an old setup */
type FinishState = "syncing" | "ok" | "failed" | "folders" | "review";

interface PrimaryAction {
  label: string;
  busyLabel?: string;
  disabled?: boolean;
  run: () => unknown;
}

/**
 * Welcome window: a short guided setup shown once on first install and from the "Set up" command.
 * New connection: server → server vault → encryption password → AI access → first sync.
 * Or: copy the setup from another device. Either way it ends with a ready, synced vault.
 */
export class SetupModal extends Modal {
  private step: Step = "welcome";
  private serverUrl: string;
  private token: string;
  private meName = "";
  private vaults: VaultInfo[] = [];
  private aiAvailable = true;
  private vaultId = "";
  private vaultHasData: boolean | undefined;
  private password = "";
  private passwordRepeat = "";
  private ai: AiChoice = "off";
  private deviceAdderText = "";
  private finish: FinishState = "syncing";
  private finishError = "";
  /** AI rules mode after setup, for the summary; undefined = AI off */
  private aiMode: "allow_by_default" | "deny_by_default" | undefined;
  private primary: (() => void) | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(
    app: App,
    private plugin: ObsiSyncPlugin,
    start?: "import"
  ) {
    super(app);
    if (start) this.step = start;
    this.serverUrl = plugin.settings.serverUrl;
    this.token = plugin.settings.deviceToken;
    const root = plugin.settings.mounts.find((m) => m.path === "");
    if (root) {
      this.vaultId = root.vaultId;
      this.password = root.password;
      this.passwordRepeat = root.password;
    }
  }

  onOpen() {
    this.modalEl.addClass("obsi-sync-setup");
    this.contentEl.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing || (e.target as HTMLElement).tagName === "TEXTAREA") return;
      if ((e.target as HTMLElement).tagName === "BUTTON") return;
      e.preventDefault();
      this.primary?.();
    });
    this.render();
  }

  onClose() {
    this.unsubscribe?.();
    this.contentEl.empty();
    if (!this.plugin.settings.onboardingDone) {
      this.plugin.settings.onboardingDone = true;
      void this.plugin.saveSettings();
    }
  }

  private go(step: Step) {
    this.step = step;
    this.render();
  }

  private render() {
    this.contentEl.empty();
    this.titleEl.empty();
    this.primary = undefined;
    switch (this.step) {
      case "welcome": return this.renderWelcome();
      case "server": return this.renderServer();
      case "vault": return this.renderVault();
      case "password": return this.renderPassword();
      case "ai": return this.renderAi();
      case "import": return this.renderImport();
      case "finish": return this.renderFinish();
    }
  }

  // ---------- building blocks ----------

  /** Step header: progress for the new-connection path, a title and an optional lead text. */
  private header(title: string, lead?: string) {
    const order: Step[] = ["server", "vault", "password", ...(this.aiAvailable ? ["ai" as Step] : [])];
    const index = order.indexOf(this.step);
    if (index >= 0) {
      const progress = this.contentEl.createDiv({ cls: "obsi-sync-setup-progress" });
      const bar = progress.createDiv({ cls: "obsi-sync-setup-progress-bar" });
      order.forEach((_, i) => bar.createDiv({ cls: i <= index ? "is-done" : "" }));
      progress.createSpan({ text: tr("Step {n} of {total}", { n: index + 1, total: order.length }) });
    }
    this.contentEl.createEl("h2", { cls: "obsi-sync-setup-title", text: title });
    if (lead) this.contentEl.createEl("p", { cls: "obsi-sync-setup-lead", text: lead });
  }

  /** Footer with Back on the left and the main action on the right; Enter triggers the main action. */
  private footer(back: (() => void) | undefined, primary: PrimaryAction | undefined, secondary?: { label: string; run: () => void }) {
    const bar = this.contentEl.createDiv({ cls: "obsi-sync-setup-footer" });
    if (back) new ButtonComponent(bar).setButtonText(tr("Back")).onClick(back).buttonEl.addClass("obsi-sync-setup-back");
    bar.createDiv({ cls: "obsi-sync-setup-spacer" });
    if (secondary) new ButtonComponent(bar).setButtonText(secondary.label).onClick(secondary.run);
    if (!primary) return;
    const b = new ButtonComponent(bar).setButtonText(primary.label).setCta().setDisabled(!!primary.disabled);
    let busy = false;
    const run = async () => {
      if (busy || primary.disabled) return;
      busy = true;
      b.setDisabled(true);
      if (primary.busyLabel) b.setButtonText(primary.busyLabel);
      try {
        await primary.run();
      } finally {
        busy = false;
        if (b.buttonEl.isConnected) b.setDisabled(false).setButtonText(primary.label);
      }
    };
    b.onClick(() => void run());
    this.primary = () => void run();
    return b;
  }

  // ---------- steps ----------

  private renderWelcome() {
    const el = this.contentEl;
    const hero = el.createDiv({ cls: "obsi-sync-setup-hero" });
    setIcon(hero.createDiv({ cls: "obsi-sync-setup-hero-icon" }), "refresh-cw");
    hero.createEl("h2", { cls: "obsi-sync-setup-title", text: tr("Welcome to Obsi Sync") });
    hero.createEl("p", { cls: "obsi-sync-setup-lead", text: tr("Keep this vault in sync across all your devices, privately.") });

    const features = el.createDiv({ cls: "obsi-sync-setup-features" });
    const feature = (icon: string, title: string, desc: string) => {
      const f = features.createDiv({ cls: "obsi-sync-setup-feature" });
      setIcon(f.createSpan({ cls: "obsi-sync-setup-feature-icon" }), icon);
      const text = f.createDiv();
      text.createDiv({ cls: "obsi-sync-setup-feature-title", text: title });
      text.createDiv({ cls: "obsi-sync-setup-feature-desc", text: desc });
    };
    feature("lock", tr("End-to-end encrypted"), tr("Notes are encrypted on this device. The server only stores ciphertext."));
    feature("refresh-cw", tr("Automatic"), tr("Changes sync when you save, on startup and every few minutes."));
    feature("sparkles", tr("AI access if you want it"), tr("Optionally let AI assistants read only the notes you choose."));

    el.createDiv({ cls: "obsi-sync-setup-section", text: tr("How do you want to start?") });
    const cards = el.createDiv({ cls: "obsi-ui-choices" });
    choiceCard(cards, {
      icon: "server",
      title: tr("Connect to my server"),
      desc: tr("I have a server address and a device token."),
      onClick: () => this.go("server"),
    });
    choiceCard(cards, {
      icon: "smartphone",
      title: tr("Copy setup from another device"),
      desc: tr("Obsi Sync already works on another device. Use its QR code or setup text."),
      onClick: () => this.go("import"),
    });

    const later = el.createDiv({ cls: "obsi-sync-setup-later" });
    const skip = later.createEl("button", { cls: "obsi-sync-setup-link", text: tr("Not now") });
    skip.addEventListener("click", () => this.close());
    later.createSpan({ text: tr("You can come back any time with the “Obsi Sync: Set up” command.") });
  }

  private renderServer() {
    this.header(
      tr("Connect to your server"),
      tr("You get the address and a device token from whoever runs your Obsi server. On a self-hosted server they are in server/data/TOKENS.txt.")
    );
    const form = this.contentEl.createDiv({ cls: "obsi-sync-setup-form" });
    const { input: urlInput } = textField(form, {
      name: tr("Server address"),
      value: this.serverUrl,
      placeholder: "https://obsi.example.com",
      onChange: (v) => (this.serverUrl = v),
    });
    textField(form, {
      name: tr("Device token"),
      value: this.token,
      secret: true,
      onChange: (v) => (this.token = v.trim()),
    });
    const errorBox = this.contentEl.createDiv();
    window.setTimeout(() => urlInput.focus(), 0);

    this.footer(() => this.go("welcome"), {
      label: tr("Continue"),
      busyLabel: tr("Connecting..."),
      run: async () => {
        errorBox.empty();
        const url = normalizeServerUrl(this.serverUrl);
        if (!url) return void callout(errorBox, "error", tr("Enter the server address."));
        if (!this.token) return void callout(errorBox, "error", tr("Enter the device token."));
        this.serverUrl = url;
        urlInput.value = url;
        try {
          const api = new ObsiApi(url, this.token, obsidianHttp);
          const me = await api.me();
          this.vaults = await api.listVaults();
          this.meName = me.name;
          this.aiAvailable = await api.health().then((h) => h.features?.ai !== false, () => true);
        } catch (e) {
          const problem = connectProblem(e);
          const detail = errorText(e);
          callout(errorBox, "error", {
            bad_url: tr("No Obsi server answered at this address. Check the address and the port."),
            unreachable: tr("Can't reach the server. Check the address and your internet connection."),
            bad_token: tr("The server didn't accept this token. Copy it again, without extra spaces."),
            server_error: tr("The server returned an error: {error}", { error: detail }),
          }[problem]);
          return;
        }
        if (!this.vaults.some((v) => v.id === this.vaultId)) this.vaultId = this.vaults[0]?.id ?? "";
        this.go("vault");
      },
    });
  }

  private renderVault() {
    this.header(
      tr("Choose a server vault"),
      tr("Connected as “{name}”. This whole Obsidian vault will be kept in sync with the server vault you choose.", { name: this.meName })
    );
    const noVaults = this.vaults.length === 0;
    if (noVaults) {
      callout(this.contentEl, "warning", tr("This token doesn't have access to any vault yet. Ask the server admin to grant one, then try again."));
    } else {
      const group = choiceGroup(this.contentEl, tr("Server vault"));
      for (const v of this.vaults) {
        choiceCard(group, {
          icon: "archive",
          title: v.name,
          desc: v.id,
          selected: v.id === this.vaultId,
          onClick: () => {
            if (this.vaultId !== v.id) this.vaultHasData = undefined;
            this.vaultId = v.id;
            this.render();
          },
        });
      }
      const alt = this.contentEl.createDiv({ cls: "obsi-sync-setup-later" });
      alt.createSpan({ text: tr("Want to sync only some folders?") });
      const link = alt.createEl("button", { cls: "obsi-sync-setup-link", text: tr("Save the connection and choose folders in settings") });
      link.addEventListener("click", async () => {
        await this.saveConnection(false);
        this.finish = "folders";
        this.go("finish");
      });
    }
    this.footer(() => this.go("server"), {
      label: tr("Continue"),
      busyLabel: tr("Checking the vault..."),
      disabled: noVaults,
      run: async () => {
        if (this.vaultHasData === undefined) {
          try {
            this.vaultHasData = (await this.api().listFiles(this.vaultId)).length > 0;
          } catch {
            this.vaultHasData = undefined; // unknown: ask for a password without checking it
          }
        }
        this.go("password");
      },
    });
  }

  private renderPassword() {
    const isNew = this.vaultHasData === false;
    const vaultName = this.vaultName();
    if (isNew) {
      this.header(
        tr("Create an encryption password"),
        tr("“{vault}” is empty, so this device starts it. Notes are encrypted with this password before they leave the device.", { vault: vaultName })
      );
    } else if (this.vaultHasData) {
      this.header(
        tr("Enter your encryption password"),
        tr("“{vault}” already has notes from another device. Enter the same password you used there.", { vault: vaultName })
      );
    } else {
      this.header(
        tr("Encryption password"),
        tr("Notes are encrypted with this password before they leave the device. Use the same password on every device of “{vault}”.", { vault: vaultName })
      );
    }
    const form = this.contentEl.createDiv({ cls: "obsi-sync-setup-form" });
    const { input: first } = textField(form, { name: tr("Password"), value: this.password, secret: true, onChange: (v) => (this.password = v) });
    if (isNew) {
      textField(form, { name: tr("Repeat password"), value: this.passwordRepeat, secret: true, onChange: (v) => (this.passwordRepeat = v) });
    }
    window.setTimeout(() => first.focus(), 0);
    callout(
      this.contentEl,
      "warning",
      tr("Keep this password safe. You will need it on every other device, and nobody, not even the server admin, can recover it."),
      "key"
    );
    const errorBox = this.contentEl.createDiv();

    this.footer(() => this.go("vault"), {
      label: tr("Continue"),
      busyLabel: tr("Checking..."),
      run: async () => {
        errorBox.empty();
        if (this.password === "") return void callout(errorBox, "error", tr("Enter a password."));
        if (isNew && this.password !== this.passwordRepeat) return void callout(errorBox, "error", tr("The passwords don't match."));
        if (this.vaultHasData) {
          try {
            const check = await checkVaultPassword(new FakeFsObsiServer(this.api(), this.vaultId), this.password);
            if (check === "mismatch") {
              return void callout(errorBox, "error", tr("This password doesn't match the notes in this vault. Check for typos and the keyboard layout."));
            }
          } catch {
            // offline: the first sync checks the password again
          }
        }
        if (this.aiAvailable) this.go("ai");
        else await this.completeSetup();
      },
    });
  }

  private renderAi() {
    this.header(
      tr("AI access"),
      tr("Should AI assistants (MCP) be able to read some of your notes? Shared notes are stored on the server unencrypted; everything else stays end-to-end encrypted. You can change this later in settings.")
    );
    const group = choiceGroup(this.contentEl, tr("AI access"));
    const option = (value: AiChoice, icon: string, title: string, desc: string) =>
      choiceCard(group, { icon, title, desc, selected: this.ai === value, onClick: () => { this.ai = value; this.render(); } });
    option("off", "lock", tr("Keep everything private"), tr("AI can't read any notes."));
    option("ticked", "check-square", tr("Only notes I mark"), tr("New notes get an “ai” checkbox. Tick it to share a note with AI."));
    option("all_but_private", "eye", tr("All notes except private ones"), tr("New notes get a “private” checkbox. Tick it to hide a note from AI."));
    if (this.ai !== "off") {
      this.contentEl.createEl("p", { cls: "obsi-sync-setup-note", text: tr("If another device has already set up AI rules for this vault, they are kept.") });
    }
    this.footer(() => this.go("password"), { label: tr("Finish setup"), run: () => this.completeSetup() });
  }

  private renderImport() {
    this.header(
      tr("Copy setup from another device"),
      tr("On the other device open Settings → Obsi Sync → Devices and press “Show QR code”. Then scan it or paste its setup text (device-adder) here.")
    );
    const el = this.contentEl;
    const scan = el.createDiv({ cls: "obsi-sync-setup-scan" });
    const status = el.createDiv({ attr: { role: "status" } });
    let parsed: DeviceAdder | undefined;
    let connectButton: ButtonComponent | undefined;

    const textArea = el.createEl("textarea", { cls: "obsi-sync-device-adder-text" });
    textArea.rows = 5;
    textArea.placeholder = tr("…or paste the setup text here");
    textArea.setAttribute("aria-label", tr("Device-adder text"));
    textArea.value = this.deviceAdderText;
    el.insertBefore(textArea, status);

    const validate = () => {
      status.empty();
      parsed = undefined;
      const text = this.deviceAdderText.trim();
      if (text !== "") {
        try {
          parsed = parseDeviceAdder(text);
          callout(status, "success", tr("Ready to connect. Server: {server}; vaults: {vaults}", {
            server: parsed.serverUrl,
            vaults: parsed.mounts.map((m) => m.vaultName || m.vaultId).join(", "),
          }));
          if (isConfigured(this.plugin.settings)) {
            callout(status, "warning", tr("Import replaces this device's server address, device token and vault mounts. Existing local files are not deleted."));
          }
        } catch (e) {
          callout(status, "error", tr("This is not valid Obsi Sync setup text: {error}", { error: errorText(e) }));
        }
      }
      connectButton?.setDisabled(!parsed);
    };
    textArea.addEventListener("input", () => {
      this.deviceAdderText = textArea.value;
      validate();
    });

    const imageButton = (label: string, icon: string, capture: boolean) => {
      const input = scan.createEl("input", { type: "file", attr: { accept: "image/*" } });
      input.hidden = true;
      if (capture) input.setAttribute("capture", "environment");
      input.addEventListener("change", async () => {
        const file = input.files?.[0];
        input.value = "";
        if (!file) return;
        status.empty();
        callout(status, "info", tr("Reading QR image..."));
        try {
          this.deviceAdderText = await readDeviceAdderQr(file);
          textArea.value = this.deviceAdderText;
          validate();
        } catch (e) {
          status.empty();
          callout(status, "error", tr("Could not read QR: {error}", { error: errorText(e) }));
        }
      });
      const button = scan.createEl("button", { cls: "obsi-sync-setup-scan-button" });
      setIcon(button.createSpan(), icon);
      button.createSpan({ text: label });
      button.addEventListener("click", () => input.click());
    };
    imageButton(tr("Scan QR with camera"), "camera", true);
    imageButton(tr("Choose QR image"), "image", false);

    el.createEl("p", {
      cls: "obsi-sync-setup-note",
      text: tr("A device-adder contains a live device token and encryption passwords. Import only one you trust."),
    });

    connectButton = this.footer(() => this.go("welcome"), {
      label: tr("Connect this device"),
      busyLabel: tr("Connecting..."),
      run: async () => {
        if (!parsed) return;
        await this.importAdder(parsed);
      },
    });
    validate();
  }

  private renderFinish() {
    const el = this.contentEl;
    const hero = el.createDiv({ cls: "obsi-sync-setup-hero" });
    const icon = hero.createDiv({ cls: "obsi-sync-setup-hero-icon" });
    const s = this.plugin.settings;

    if (this.finish === "syncing") {
      icon.addClass("is-spinning");
      setIcon(icon, "loader");
      hero.createEl("h2", { cls: "obsi-sync-setup-title", text: tr("Setting up your vault...") });
      hero.createEl("p", { cls: "obsi-sync-setup-lead", text: tr("Running the first sync. Large vaults can take a few minutes; you can close this window, sync continues in the background.") });
      const bar = el.createDiv({ cls: "obsi-sync-setup-meter" });
      const fill = bar.createDiv();
      const text = el.createDiv({ cls: "obsi-sync-setup-note", attr: { role: "status" } });
      this.unsubscribe?.();
      this.unsubscribe = this.plugin.syncManager.subscribe((status, progress) => {
        text.setText(status);
        if (progress && progress.total > 0) {
          bar.addClass("is-determinate");
          fill.style.width = `${Math.round((progress.done / progress.total) * 100)}%`;
        }
      });
      this.footer(undefined, undefined, { label: tr("Hide"), run: () => this.close() });
      return;
    }

    if (this.finish === "failed") {
      icon.addClass("is-error");
      setIcon(icon, "alert-triangle");
      hero.createEl("h2", { cls: "obsi-sync-setup-title", text: tr("Connected, but the first sync didn't finish") });
      hero.createEl("p", { cls: "obsi-sync-setup-lead", text: tr("Your settings are saved and Obsi Sync will retry automatically. You can also try again now.") });
      if (this.finishError) callout(el, "error", this.finishError);
      this.footer(undefined, { label: tr("Try again"), busyLabel: tr("Syncing..."), run: () => this.runFirstSync() }, { label: tr("Close"), run: () => this.close() });
      return;
    }

    icon.addClass("is-success");
    setIcon(icon, "check-circle");

    if (this.finish === "folders") {
      hero.createEl("h2", { cls: "obsi-sync-setup-title", text: tr("Connection saved") });
      hero.createEl("p", { cls: "obsi-sync-setup-lead", text: tr("Now choose which folders of this vault to sync, and with which server vaults.") });
      this.footer(undefined, { label: tr("Choose folders"), run: () => { this.close(); this.plugin.openSettings("folders"); } }, { label: tr("Close"), run: () => this.close() });
      return;
    }

    if (this.finish === "review") {
      hero.createEl("h2", { cls: "obsi-sync-setup-title", text: tr("Connection imported") });
      hero.createEl("p", { cls: "obsi-sync-setup-lead", text: tr("This device had its own setup before, so nothing has been synced yet. Check the vault mounts, then run the first sync.") });
      this.footer(
        undefined,
        { label: tr("Sync now"), run: () => this.runFirstSync() },
        { label: tr("Open vault mounts"), run: () => { this.close(); this.plugin.openSettings("folders"); } }
      );
      return;
    }

    const names = s.mounts.map((m) => m.vaultName || m.vaultId).join(", ");
    hero.createEl("h2", { cls: "obsi-sync-setup-title", text: tr("You're all set!") });
    hero.createEl("p", { cls: "obsi-sync-setup-lead", text: tr("This vault is synced with “{vault}” and end-to-end encrypted.", { vault: names }) });
    el.createDiv({ cls: "obsi-sync-setup-section", text: tr("What happens next") });
    const tips = el.createDiv({ cls: "obsi-sync-setup-features" });
    const tip = (iconName: string, text: string) => {
      const f = tips.createDiv({ cls: "obsi-sync-setup-feature" });
      setIcon(f.createSpan({ cls: "obsi-sync-setup-feature-icon" }), iconName);
      f.createDiv({ cls: "obsi-sync-setup-feature-desc", text });
    };
    tip("refresh-cw", s.autoSyncMinutes > 0
      ? tr("Sync runs on its own: when you save, when Obsidian starts and every {n} min.", { n: s.autoSyncMinutes })
      : tr("Sync runs on its own when you save and when Obsidian starts."));
    tip("mouse-pointer-click", tr("The status bar shows the sync state. To sync right away, click the sync icon in the left ribbon."));
    if (this.aiMode) {
      tip("sparkles", this.aiMode === "allow_by_default"
        ? tr("AI can read all notes except those with “private” ticked.")
        : tr("AI can read only the notes allowed by the AI rules, for example with “ai” ticked."));
    }
    tip("smartphone", tr("To add another device, open Settings → Obsi Sync → Devices and scan the QR code there."));
    this.footer(
      undefined,
      { label: tr("Start using"), run: () => this.close() },
      { label: tr("Open settings"), run: () => { this.close(); this.plugin.openSettings(); } }
    );
  }

  // ---------- actions ----------

  private api() {
    return new ObsiApi(this.serverUrl, this.token, obsidianHttp);
  }

  private vaultName() {
    return this.vaults.find((v) => v.id === this.vaultId)?.name ?? this.vaultId;
  }

  private async saveConnection(createRootMount: boolean) {
    const s = this.plugin.settings;
    s.serverUrl = this.serverUrl;
    s.deviceToken = this.token;
    if (createRootMount) {
      const root = { path: "", vaultId: this.vaultId, vaultName: this.vaultName(), password: this.password, encryptionMethod: "rclone-base64" as const };
      const i = s.mounts.findIndex((m) => m.path === "");
      if (i >= 0) s.mounts[i] = { ...s.mounts[i], ...root };
      else s.mounts.unshift(root);
    }
    s.onboardingDone = true;
    await this.plugin.saveSettings();
    await this.plugin.refreshMe();
    this.plugin.updateStatus();
  }

  private async completeSetup() {
    await this.saveConnection(true);
    await this.runFirstSync();
  }

  private async importAdder(data: DeviceAdder) {
    const s = this.plugin.settings;
    const wasConfigured = isConfigured(s);
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
    this.ai = "off"; // AI rules travel with the vault itself
    await this.plugin.saveSettings();
    this.plugin.me = undefined;
    this.plugin.vaults = [];
    await this.plugin.refreshMe();
    this.plugin.updateStatus();
    if (wasConfigured) {
      this.finish = "review";
      this.go("finish");
    } else {
      await this.runFirstSync();
    }
  }

  /** Rules are created only after a successful first sync, so rules from another device win. */
  private async runFirstSync() {
    this.finish = "syncing";
    this.step = "finish";
    this.render();
    // a sync started by a save in the meantime would make this call a no-op; wait for it first
    while (this.plugin.syncManager.running) await new Promise((r) => window.setTimeout(r, 500));
    const synced = await this.plugin.syncManager.syncAll("auto_once_init");
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (!synced) {
      const errors = [...this.plugin.syncManager.status.values()].filter((x) => x.lastError).map((x) => `${x.path || "/"}: ${x.lastError}`);
      this.finishError = errors.length ? errors.join("; ") : tr("Sync could not start. Check the connection in settings.");
      this.finish = "failed";
    } else {
      if (this.ai !== "off") {
        let rules = await this.plugin.rules.load(true);
        if (rules === null) {
          await this.plugin.rules.save(structuredClone(this.ai === "ticked" ? STARTER_RULES : STARTER_RULES_ALLOW));
          rules = await this.plugin.rules.load(true);
        }
        this.aiMode = rules?.config.mode;
        this.plugin.settings.aiEnabled = true;
        await this.plugin.saveSettings();
        this.plugin.publisher.schedule();
      }
      this.finish = "ok";
    }
    if (this.step === "finish") this.render();
  }
}
