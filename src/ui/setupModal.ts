import { type App, ButtonComponent, Modal, Platform, Setting, setIcon } from "obsidian";
import { t as tr } from "../i18n";
import { ObsiApi } from "../api/client";
import { obsidianHttp } from "../api/httpObsidian";
import { STARTER_RULES, STARTER_RULES_ALLOW } from "../ai/rules";
import type { VaultInfo } from "../api/types";
import { type DeviceAdder, parseDeviceAdder } from "../deviceAdder";
import { deviceNameFromSystem } from "../deviceName";
import { MIN_ACCOUNT_PASSWORD, accountProblem, checkVaultPassword, connectProblem, normalizeServerUrl, parseInvitation } from "../onboarding";
import { button, buttonRow, callout, choiceCard, choiceGroup, details, errorText, textField } from "./kit";
import { isConfigured } from "../settings";
import { FakeFsObsiServer } from "../sync/fsObsiServer";
import { readDeviceAdderQr } from "./qrTransfer";
import type ObsiSyncPlugin from "../main";

type Step = "welcome" | "server" | "vault" | "password" | "ai" | "import" | "finish";
type AiChoice = "off" | "ticked" | "all_but_private";
type ServerAuthMode = "token" | "login" | "register";
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
  private authMode: ServerAuthMode = "login";
  private username = "";
  private accountPassword = "";
  private accountPasswordRepeat = "";
  /** server + username of the session in `token`, so going back and forth signs in only once */
  private signedInAs = "";
  private inviteCode = "";
  private meName = "";
  private hasUserAccount = false;
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
    start?: "import" | "server"
  ) {
    super(app);
    if (start) this.step = start;
    this.serverUrl = plugin.settings.serverUrl;
    this.token = plugin.settings.deviceToken;
    if (this.token && start !== "server") this.authMode = "token";
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
    hero.createEl("h2", { cls: "obsi-sync-setup-title", text: tr("Welcome to Sync and MCP") });
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
    const connect = (mode: ServerAuthMode) => {
      this.authMode = mode;
      this.go("server");
    };
    choiceCard(cards, {
      icon: "mail",
      title: tr("I have an invitation"),
      desc: tr("The server admin sent you an invitation. Create your account with it."),
      onClick: () => connect("register"),
    });
    choiceCard(cards, {
      icon: "log-in",
      title: tr("Sign in to my account"),
      desc: tr("You already have an account on a Sync and MCP server."),
      // running setup again: the saved token already works, no need to type the password
      onClick: () => connect(this.plugin.settings.deviceToken ? "token" : "login"),
    });
    choiceCard(cards, {
      icon: "smartphone",
      title: tr("Copy setup from another device"),
      desc: tr("Sync and MCP already works on another device. Use its QR code or setup text."),
      onClick: () => this.go("import"),
    });

    const later = el.createDiv({ cls: "obsi-sync-setup-later" });
    const skip = later.createEl("button", { cls: "obsi-sync-setup-link", text: tr("Not now") });
    skip.addEventListener("click", () => this.close());
    later.createSpan({ text: tr("You can come back any time with the “Sync and MCP: Set up” command.") });
  }

  private renderServer() {
    const mode = this.authMode;
    const switchMode = (next: ServerAuthMode) => { this.authMode = next; this.render(); };
    if (mode === "register") {
      this.header(tr("Create your account"), tr("Paste the invitation you received: it has the server address and a one-time code. Then choose a username and an account password."));
    } else if (mode === "login") {
      this.header(tr("Sign in to your account"), tr("Use the username and password of your account on the Sync and MCP server."));
    } else {
      this.header(tr("Connect with an access token"), tr("For a device or access token that the server admin gave you."));
    }
    const form = this.contentEl.createDiv({ cls: "obsi-sync-setup-form" });
    let urlInput!: HTMLInputElement;
    let first: HTMLElement | undefined;
    if (mode === "register") {
      // a textarea keeps the line breaks of a pasted message, so the address and the code stay apart
      const invitation = form.createEl("textarea", { cls: "obsi-sync-device-adder-text obsi-sync-invitation" });
      invitation.rows = 3;
      invitation.placeholder = tr("Paste the invitation or just the code (inv_...)");
      invitation.setAttribute("aria-label", tr("Invitation"));
      invitation.value = this.inviteCode;
      const recognized = form.createDiv({ attr: { role: "status" } });
      const read = () => {
        recognized.empty();
        const found = parseInvitation(invitation.value);
        this.inviteCode = found.code ?? "";
        if (found.serverUrl) {
          this.serverUrl = found.serverUrl;
          urlInput.value = found.serverUrl;
        }
        if (found.code) callout(recognized, "success", found.serverUrl
          ? tr("Invitation recognized: server and code are filled in.")
          : tr("Code recognized. Enter the server address below."));
      };
      invitation.addEventListener("input", read);
      first = invitation;
    }
    urlInput = textField(form, {
      name: tr("Server address"),
      value: this.serverUrl,
      placeholder: "https://obsi.example.com",
      onChange: (v) => (this.serverUrl = v),
    }).input;
    if (mode === "token") {
      textField(form, { name: tr("Access or device token"), value: this.token, secret: true, onChange: (v) => (this.token = v.trim()) });
    } else {
      textField(form, {
        name: tr("Username"),
        desc: mode === "register" ? tr("3 to 64 characters. You will use it to sign in on your other devices.") : undefined,
        value: this.username,
        onChange: (v) => (this.username = v.trim()),
      });
      textField(form, {
        name: tr("Account password"),
        desc: mode === "register" ? tr("At least {n} characters. It is not the encryption password: you will choose that one later.", { n: MIN_ACCOUNT_PASSWORD }) : undefined,
        value: this.accountPassword,
        secret: true,
        onChange: (v) => (this.accountPassword = v),
      });
      if (mode === "register") {
        textField(form, { name: tr("Repeat account password"), value: this.accountPasswordRepeat, secret: true, onChange: (v) => (this.accountPasswordRepeat = v) });
      }
    }
    const errorBox = this.contentEl.createDiv();
    const alt = this.contentEl.createDiv({ cls: "obsi-sync-setup-later" });
    const altLink = (text: string, next: ServerAuthMode) => {
      const link = alt.createEl("button", { cls: "obsi-sync-setup-link", text });
      link.addEventListener("click", () => switchMode(next));
    };
    if (mode === "register") altLink(tr("I already have an account"), "login");
    if (mode === "login") {
      altLink(tr("Create an account with an invitation"), "register");
      altLink(tr("Use an access token instead"), "token");
    }
    if (mode === "token") altLink(tr("Sign in with username and password"), "login");
    window.setTimeout(() => (first ?? urlInput).focus(), 0);

    this.footer(() => this.go("welcome"), {
      label: mode === "register" ? tr("Create account") : tr("Continue"),
      busyLabel: tr("Connecting..."),
      run: async () => {
        errorBox.empty();
        const url = normalizeServerUrl(this.serverUrl);
        if (mode === "register" && !this.inviteCode) return void callout(errorBox, "error", tr("Paste the invitation code."));
        if (!url) return void callout(errorBox, "error", tr("Enter the server address."));
        this.serverUrl = url;
        urlInput.value = url;
        if (mode !== "token") {
          if (!this.username || !this.accountPassword) return void callout(errorBox, "error", tr("Enter your username and password."));
          if (mode === "register" && this.accountPassword.length < MIN_ACCOUNT_PASSWORD) {
            return void callout(errorBox, "error", tr("The account password must be at least {n} characters.", { n: MIN_ACCOUNT_PASSWORD }));
          }
          if (mode === "register" && this.accountPassword !== this.accountPasswordRepeat) return void callout(errorBox, "error", tr("The passwords don't match."));
        } else if (!this.token) return void callout(errorBox, "error", tr("Enter an access token."));
        try {
          // Back and Continue again must not spend the invitation twice or open a new session every time
          const account = `${url}\n${this.username}`;
          if (mode !== "token" && this.signedInAs !== account) {
            const authApi = new ObsiApi(url, "", obsidianHttp);
            const auth = mode === "register"
              ? await authApi.register(this.inviteCode, this.username, this.accountPassword)
              : await authApi.login(this.username, this.accountPassword);
            this.token = auth.token;
            this.signedInAs = account;
          }
          const api = new ObsiApi(url, this.token, obsidianHttp);
          const me = await api.me();
          this.vaults = await api.listVaults();
          this.hasUserAccount = me.kind === "device" && me.user != null;
          this.meName = me.user?.username ?? me.name;
          this.aiAvailable = await api.health().then((h) => h.features?.ai !== false, () => true);
        } catch (e) {
          const account = accountProblem(e);
          if (account) {
            callout(errorBox, "error", {
              bad_credentials: tr("Wrong username or password."),
              bad_invite: tr("This invitation is not valid or was already used. Ask the server admin for a new one."),
              username_taken: tr("This username is already taken. Choose another one, or sign in if the account is yours."),
              bad_username: tr("The username must be 3 to 64 characters."),
              weak_password: tr("The account password must be at least {n} characters.", { n: MIN_ACCOUNT_PASSWORD }),
            }[account]);
            return;
          }
          const problem = connectProblem(e);
          const detail = errorText(e);
          callout(errorBox, "error", {
            bad_url: tr("No Sync and MCP server answered at this address. Check the address and the port."),
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
    const noVaults = this.vaults.length === 0;
    if (noVaults && this.hasUserAccount) return this.renderFirstVault();
    this.header(
      tr("Choose a server vault"),
      tr("Connected as “{name}”. This whole Obsidian vault will be kept in sync with the server vault you choose.", { name: this.meName })
    );
    if (noVaults) {
      callout(this.contentEl, "warning", tr("This token has no access to any vault yet. Ask the server admin for access, or sign in to your account to create a vault."));
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
    if (this.hasUserAccount) {
      let name = "";
      const more = details(this.contentEl, tr("Create another server vault"));
      textField(more, { name: tr("Vault name"), value: name, placeholder: tr("e.g. Work"), onChange: (v) => { name = v; } });
      const errorBox = more.createDiv();
      button(buttonRow(more), { text: tr("Create vault"), icon: "plus", busyText: tr("Creating..."), onClick: async () => {
        errorBox.empty();
        if (!name.trim()) return void callout(errorBox, "error", tr("Enter a name"));
        try {
          const vault = await this.api().createOwnedVault(name.trim());
          this.vaults.push(vault);
          this.vaultId = vault.id;
          this.vaultHasData = false;
          this.render();
        } catch (e) { callout(errorBox, "error", errorText(e)); }
      } });
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

  /** A new account has nothing to choose from: name the first vault and go on. */
  private renderFirstVault() {
    this.header(
      tr("Create your first server vault"),
      tr("Signed in as “{name}”. A server vault keeps the encrypted copy of this Obsidian vault. You can add more vaults later.", { name: this.meName })
    );
    let name = this.app.vault.getName();
    const form = this.contentEl.createDiv({ cls: "obsi-sync-setup-form" });
    const { input } = textField(form, { name: tr("Vault name"), desc: tr("Only you see it, in Sync and MCP and in AI assistants."), value: name, onChange: (v) => (name = v) });
    window.setTimeout(() => input.select(), 0);
    const errorBox = this.contentEl.createDiv();
    this.footer(() => this.go("server"), {
      label: tr("Create and continue"),
      busyLabel: tr("Creating..."),
      run: async () => {
        errorBox.empty();
        if (!name.trim()) return void callout(errorBox, "error", tr("Enter a name"));
        try {
          const vault = await this.api().createOwnedVault(name.trim());
          this.vaults.push(vault);
          this.vaultId = vault.id;
          this.vaultHasData = false;
          this.go("password");
        } catch (e) {
          callout(errorBox, "error", tr("Could not create the vault: {error}", { error: errorText(e) }));
        }
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
    if (this.hasUserAccount) {
      this.contentEl.createEl("p", {
        cls: "obsi-sync-setup-note",
        text: tr("This is not your account password. The account password lets you sign in; the encryption password never leaves your devices."),
      });
    }
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
      tr("On the other device open Settings → Sync and MCP → Devices and press “Show QR code”. Then scan it or paste its setup text (device-adder) here.")
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
          callout(status, "error", tr("This is not valid Sync and MCP setup text: {error}", { error: errorText(e) }));
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
      hero.createEl("p", { cls: "obsi-sync-setup-lead", text: tr("Your settings are saved and Sync and MCP will retry automatically. You can also try again now.") });
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
    tip("smartphone", this.hasUserAccount
      ? tr("To add another device, open Settings → Sync and MCP → Devices: each device gets its own QR code and can be disconnected separately.")
      : tr("To add another device, open Settings → Sync and MCP → Devices and scan the QR code there."));
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
    s.syncReviewHold = wasConfigured;
    this.ai = "off"; // AI rules travel with the vault itself
    await this.plugin.saveSettings();
    this.serverUrl = data.serverUrl;
    this.token = data.deviceToken;
    this.plugin.me = undefined;
    this.plugin.vaults = [];
    await this.plugin.refreshMe();
    if (data.provisionalDeviceName) {
      const detected = deviceNameFromSystem({
        ios: Platform.isIosApp,
        android: Platform.isAndroidApp,
        mac: Platform.isMacOS,
        windows: Platform.isWin,
        linux: Platform.isLinux,
        mobile: Platform.isMobile,
        userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
      });
      if (detected) {
        try {
          await new ObsiApi(data.serverUrl, data.deviceToken, obsidianHttp).renameMe(detected);
          await this.plugin.refreshMe();
        } catch (e) {
          // the random name from the QR still works; naming is not required to sync
          console.debug("sync-and-mcp: could not rename this device", e);
        }
      }
    }
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
    if (this.plugin.settings.syncReviewHold) {
      this.plugin.settings.syncReviewHold = false;
      await this.plugin.saveSettings();
    }
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
