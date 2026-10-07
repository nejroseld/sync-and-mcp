import { type App, Modal, Notice } from "obsidian";
import type { ObsiApi } from "../../api/client";
import type { TokenInfo, VaultInfo } from "../../api/types";
import { t as tr } from "../../i18n";
import { button, buttonRow, callout, choiceCard, choiceGroup, copyToClipboard, errorText, sectionTitle, textField } from "../kit";
import { lastUsed, loadedAccount, ownedVaults, reloadTokens, tokenList, vaultNames } from "./account";
import type { SettingsContext } from "./context";

/** MCP operations: reading is the safe default, edits arrive as suggestions the plugin applies. */
const READ_OPS = ["list", "search", "read"];
const EDIT_OPS = [...READ_OPS, "write"];

/** AI tab: connect Claude or another MCP client to the vaults of this account. */
export const renderAssistants = (ctx: SettingsContext, el: HTMLElement) => {
  const { plugin } = ctx;
  // the header holds only the title, description and button; everything else goes below it, full width
  const section = sectionTitle(el, tr("Assistants"), tr("Each assistant (Claude Desktop, Claude Code, Cursor...) gets its own access key, so you can disconnect one without touching the others."));
  if (!plugin.getApi()) return;
  const plainToken = plugin.me !== undefined && !plugin.me.account_token;
  const account = plainToken ? undefined : loadedAccount(ctx, el);
  if (plainToken || (account && !account.accountToken)) {
    callout(el, "info", tr("To connect an assistant, sign in to your account (Overview → Connection → Sign in)."));
    return;
  }
  if (!account) return;
  button(buttonRow(section), { text: tr("Connect an assistant"), icon: "plus", cta: true, onClick: () => openConnectAssistant(ctx) });
  tokenList(ctx, el, account.tokens.filter((t) => t.kind === "mcp"), {
    describe: (t) => tr("{vaults} · {access} · {used}", {
      vaults: vaultNames(ctx, t) || tr("no access"),
      access: Object.values(t.grants ?? {}).some((ops) => ops.includes("write")) ? tr("can suggest edits") : tr("read only"),
      used: lastUsed(t),
    }),
    empty: tr("No assistants connected yet."),
  });
};

/**
 * Opens the connect window directly, also from the Overview. The name and the vault of the whole
 * synced folder are filled in, so “Connect” alone is enough. Without an account session it shows the AI tab.
 */
export const openConnectAssistant = async (ctx: SettingsContext) => {
  const { plugin } = ctx;
  const api = plugin.getApi();
  if (!api || !plugin.me?.account_token) return ctx.go("ai");
  if (!plugin.vaults.length) {
    try {
      plugin.vaults = await api.listVaults();
    } catch (e) {
      return void new Notice(tr("Failed: {error}", { error: errorText(e) }));
    }
  }
  const root = plugin.settings.mounts.find((m) => m.path === "")?.vaultId;
  new ConnectAssistantModal(ctx.app, api, plugin.settings.serverUrl, ownedVaults(ctx), root, !plugin.settings.aiEnabled, () => reloadTokens(ctx)).open();
};

/** Name → vaults → read or edit; then the connection details, shown once. */
class ConnectAssistantModal extends Modal {
  private name = "Claude";
  private chosen: Set<string>;
  private edits = false;
  private created: TokenInfo | undefined;

  constructor(
    app: App,
    private api: ObsiApi,
    private serverUrl: string,
    private vaults: VaultInfo[],
    rootVault: string | undefined,
    private aiOff: boolean,
    private onCreated: () => Promise<void>
  ) {
    super(app);
    const preselect = vaults.find((v) => v.id === rootVault) ?? (vaults.length === 1 ? vaults[0] : undefined);
    this.chosen = new Set(preselect ? [preselect.id] : []);
  }

  onOpen() {
    this.modalEl.addClass("obsi-ui-dialog", "obsi-sync-token-modal");
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  private render() {
    const el = this.contentEl;
    el.empty();
    if (this.created) return this.renderCreated();
    this.titleEl.setText(tr("Connect an assistant"));
    const { input } = textField(el, { name: tr("Name"), desc: tr("Which assistant it is, e.g. “Claude Desktop”."), value: this.name, placeholder: "Claude Desktop", onChange: (v) => (this.name = v) });
    window.setTimeout(() => input.select());

    el.createDiv({ cls: "obsi-ui-section-title", text: tr("Vaults") });
    if (!this.vaults.length) callout(el, "warning", tr("Your account has no vaults of its own yet."));
    const list = el.createDiv({ cls: "obsi-ui-grants" });
    for (const v of this.vaults) {
      const label = list.createEl("label", { cls: "obsi-ui-grant-row" });
      const cb = label.createEl("input", { type: "checkbox" });
      cb.checked = this.chosen.has(v.id);
      cb.addEventListener("change", () => (cb.checked ? this.chosen.add(v.id) : this.chosen.delete(v.id)));
      label.appendText(v.name);
    }

    const group = choiceGroup(el, tr("What can it do?"));
    const option = (edits: boolean, icon: string, title: string, desc: string) =>
      choiceCard(group, { icon, title, desc, selected: this.edits === edits, onClick: () => { this.edits = edits; this.render(); } });
    option(false, "book-open", tr("Read and search"), tr("Finds and reads the notes you share with AI."));
    option(true, "pencil", tr("Read, search and suggest edits"), tr("Can also write notes. Edits reach your vault through Sync and MCP on your devices."));
    callout(el, "info", this.aiOff
      ? tr("AI access is off on this device, so the assistant will see no notes until you choose what AI can read on this tab.")
      : tr("The assistant sees only the notes you share with AI. Everything else stays encrypted."));

    const errorBox = el.createDiv();
    const row = el.createDiv({ cls: "obsi-ui-dialog-buttons" });
    button(row, { text: tr("Cancel"), onClick: () => this.close() });
    const connect = button(row, {
      text: tr("Connect"),
      cta: true,
      busyText: tr("Creating..."),
      onClick: async () => {
        errorBox.empty();
        if (!this.name.trim()) return void callout(errorBox, "error", tr("Enter a name"));
        if (!this.chosen.size) return void callout(errorBox, "error", tr("Choose at least one vault."));
        const ops = this.edits ? EDIT_OPS : READ_OPS;
        try {
          this.created = await this.api.createOwnToken(this.name.trim(), "mcp", Object.fromEntries([...this.chosen].map((vid) => [vid, ops])));
          this.render();
          // the key is shown first: a failed list reload must not hide it
          void this.onCreated().catch(() => undefined);
        } catch (e) {
          callout(errorBox, "error", tr("Failed: {error}", { error: errorText(e) }));
        }
      },
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) connect.buttonEl.click();
    });
  }

  private renderCreated() {
    const el = this.contentEl;
    const token = this.created?.token ?? "";
    const endpoint = `${this.serverUrl}/mcp`;
    this.titleEl.setText(tr("“{name}” is ready to connect", { name: this.created?.name ?? "" }));
    callout(el, "warning", tr("Copy what you need now: the access key is shown only once. If you lose it, disconnect this assistant and connect it again."));
    const snippet = (title: string, desc: string, text: string) => {
      el.createDiv({ cls: "obsi-ui-section-title", text: title });
      el.createDiv({ cls: "obsi-ui-section-desc", text: desc });
      el.createEl("pre", { cls: "obsi-ui-token" }).setText(text);
      button(buttonRow(el), { text: tr("Copy"), icon: "copy", onClick: () => copyToClipboard(text, tr("Copied")) });
    };
    snippet(tr("Claude Code"), tr("Run in a terminal:"), `claude mcp add --transport http obsi ${endpoint} --header "Authorization: Bearer ${token}"`);
    snippet(
      tr("Claude Desktop and other clients"),
      tr("Add to the client's MCP configuration (for Claude Desktop: claude_desktop_config.json):"),
      JSON.stringify({ mcpServers: { obsi: { command: "npx", args: ["mcp-remote", endpoint, "--header", `Authorization: Bearer ${token}`] } } }, null, 2)
    );
    snippet(tr("Any MCP client"), tr("Server address and header:"), `${endpoint}\nAuthorization: Bearer ${token}`);
    const row = el.createDiv({ cls: "obsi-ui-dialog-buttons" });
    button(row, { text: tr("Done"), cta: true, onClick: () => this.close() });
  }
}
