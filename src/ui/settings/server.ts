import { type App, Modal, Notice, Setting } from "obsidian";
import type { ObsiApi } from "../../api/client";
import type { EmbeddingSettings } from "../../api/types";
import { t as tr } from "../../i18n";
import { button, buttonRow, callout, card, copyToClipboard, errorText, relativeTime, sectionTitle, textField } from "../kit";
import type { SettingsContext } from "./context";

export const renderServer = (ctx: SettingsContext, el: HTMLElement) => {
  const { plugin, state } = ctx;
  const s = plugin.settings;
  const a = state.admin;

  el.createEl("p", {
    cls: "obsi-ui-lead",
    text: tr("For whoever runs the Sync and MCP server: invite people, see their accounts, manage vaults, set up semantic search. Needs the admin token from the server installation. Everyone manages their own devices and assistants on the Devices and AI tabs."),
  });

  const api = () => plugin.getAdminApi();
  const load = async () => {
    const x = api();
    if (!x || a.loading) return;
    a.loading = true;
    try {
      const [vaults, settings, invites, users] = await Promise.all([x.listVaults(), x.getAdminSettings(), x.listInvites(), x.listUsers()]);
      // every vault on the server; kept apart from plugin.vaults, which is what this device's own token can see
      a.vaults = vaults;
      a.invites = invites;
      a.users = users;
      const emb = settings.embedding ?? {};
      a.embedding = { base_url: emb.base_url ?? "", api_key: emb.api_key ?? "", model: emb.model ?? "" };
      a.index = (settings as { index?: typeof a.index }).index;
      a.loaded = true;
      a.error = undefined;
    } catch (e) {
      a.error = errorText(e);
      a.loaded = false;
    } finally {
      a.loading = false;
    }
    ctx.refresh();
  };

  const conn = card(el, { icon: "key", title: tr("Admin access"), subtitle: a.loaded ? tr("Connected to {server}", { server: s.serverUrl }) : tr("Not connected") });
  let token = s.adminToken;
  textField(conn.body, {
    name: tr("Admin token"),
    desc: tr("Stored only on this device and used only on this tab."),
    value: token,
    secret: true,
    onChange: (v) => (token = v.trim()),
  });
  if (a.error) callout(conn.body, "error", tr("Could not load server data: {error}", { error: a.error }));
  if (!s.serverUrl) callout(conn.body, "warning", tr("Set the server address on the Overview tab first."));
  button(buttonRow(conn.body), {
    text: a.loaded ? tr("Reload") : tr("Connect"),
    cta: !a.loaded,
    busyText: tr("Connecting..."),
    onClick: async () => {
      if (token !== s.adminToken) {
        s.adminToken = token;
        await ctx.save();
      }
      await load();
    },
  });
  if (!a.loaded) {
    if (a.loading) conn.body.createEl("p", { cls: "obsi-ui-muted", text: tr("Loading...") });
    else if (s.adminToken && s.serverUrl && !a.error) void load();
    return;
  }
  const x = api()!;

  renderUserAccounts(ctx, el, x);
  renderVaults(ctx, el, x);
  renderEmbeddings(ctx, el, x);
};

const renderUserAccounts = (ctx: SettingsContext, el: HTMLElement, x: ObsiApi) => {
  const a = ctx.state.admin;
  sectionTitle(el, tr("People"), tr("Everyone signs in with their own account and sees only their own vaults. To add someone, send them an invitation."));
  const invite = card(el, { icon: "mail", title: tr("Invite someone") });
  let name = "";
  const { input } = textField(invite.body, { name: tr("Who is it for"), desc: tr("Only for your list, e.g. “Alice”."), value: name, placeholder: tr("e.g. Alice"), onChange: (v) => { name = v; } });
  const create = async () => {
    if (!name.trim()) return void new Notice(tr("Enter a name"));
    try {
      const created = await x.createInvite(name.trim());
      a.invites.unshift({ ...created, code: undefined });
      ctx.refresh();
      new InviteCodeModal(ctx.app, created.name, invitationMessage(created.name, ctx.plugin.settings.serverUrl, created.code ?? "")).open();
    } catch (e) { new Notice(tr("Failed: {error}", { error: errorText(e) })); }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) void create();
  });
  button(buttonRow(invite.body), { text: tr("Create invitation"), icon: "send", cta: true, busyText: tr("Creating..."), onClick: create });

  const pending = a.invites.filter((i) => !i.used_at);
  if (pending.length) {
    el.createDiv({ cls: "obsi-ui-subtitle", text: tr("Waiting for sign-up") });
    const list = el.createDiv({ cls: "obsi-ui-list" });
    for (const i of pending) new Setting(list).setName(i.name).setDesc(tr("Invited {time}. The code works once.", { time: relativeTime(i.created_at) }));
  }

  el.createDiv({ cls: "obsi-ui-subtitle", text: tr("Accounts ({count})", { count: a.users.length }) });
  const users = el.createDiv({ cls: "obsi-ui-list", attr: { "aria-label": tr("User accounts") } });
  for (const user of a.users) {
    new Setting(users)
      .setName(user.username)
      .setDesc(tr("Joined {time} · vaults: {vaults} · devices and assistants: {tokens}", {
        time: relativeTime(user.created_at),
        vaults: user.vault_count,
        tokens: user.token_count,
      }));
  }
  if (!a.users.length) users.createEl("p", { cls: "obsi-ui-muted", text: tr("No accounts yet. Send an invitation to the first person.") });
};

/** Ready to forward: the invitee pastes it whole into the setup window, which picks out the address and the code. */
export const invitationMessage = (name: string, serverUrl: string, code: string) =>
  [
    tr("Sync and MCP invitation for {name}", { name }),
    tr("Server: {url}", { url: serverUrl }),
    tr("Code: {code}", { code }),
    tr("In Obsidian: Sync and MCP → “I have an invitation”, paste this whole message. The code works once."),
  ].join("\n");

class InviteCodeModal extends Modal {
  constructor(app: App, private inviteName: string, private message: string) { super(app); }
  onOpen() {
    this.modalEl.addClass("obsi-ui-dialog");
    this.titleEl.setText(tr("Invitation for {name}", { name: this.inviteName }));
    this.contentEl.createEl("p", { text: tr("Send this message to {name} in any messenger or email. It is shown only once.", { name: this.inviteName }) });
    this.contentEl.createEl("pre", { cls: "obsi-ui-token" }).setText(this.message);
    const row = this.contentEl.createDiv({ cls: "obsi-ui-dialog-buttons" });
    button(row, { text: tr("Copy message"), icon: "copy", onClick: () => copyToClipboard(this.message, tr("Invitation copied")) });
    button(row, { text: tr("Done"), cta: true, onClick: () => this.close() });
  }
  onClose() { this.contentEl.empty(); }
}

const renderVaults = (ctx: SettingsContext, el: HTMLElement, x: ObsiApi) => {
  const a = ctx.state.admin;
  sectionTitle(el, tr("Vaults"), tr("Each vault is a separate encrypted space on the server."));
  const list = el.createDiv({ cls: "obsi-ui-list" });
  for (const v of a.vaults) {
    new Setting(list)
      .setName(v.name)
      .setDesc(tr("{id} · created {time}. Semantic search:", { id: v.id, time: relativeTime(v.created_at) }))
      .addToggle((t) =>
        t
          .setTooltip(tr("Semantic search for AI"))
          .setValue(v.rag?.enabled ?? false)
          .onChange(async (on) => {
            try {
              await x.patchVault(v.id, { rag: { enabled: on } });
              v.rag = { ...(v.rag ?? { enabled: on }), enabled: on };
            } catch (e) {
              new Notice(tr("Failed: {error}", { error: errorText(e) }));
              t.setValue(!on);
            }
          })
      );
  }
  let name = "";
  new Setting(el)
    .setName(tr("New vault"))
    .addText((t) => t.setPlaceholder(tr("Name, e.g. Personal")).onChange((v) => (name = v)))
    .addButton((b) =>
      b.setButtonText(tr("Create")).onClick(async () => {
        if (!name.trim()) return void new Notice(tr("Enter a name"));
        try {
          const v = await x.createVault(name.trim());
          new Notice(tr("Vault “{name}” created", { name: v.name }));
          a.vaults = await x.listVaults();
          ctx.refresh();
        } catch (e) {
          new Notice(tr("Failed: {error}", { error: errorText(e) }));
        }
      })
    );
};

const renderEmbeddings = (ctx: SettingsContext, el: HTMLElement, x: ObsiApi) => {
  const a = ctx.state.admin;
  sectionTitle(el, tr("Semantic search"), tr("Lets AI find notes by meaning, not just words. Uses any OpenAI-compatible embeddings API, e.g. a local Ollama."));
  const c = card(el);
  const emb = { ...a.embedding };
  textField(c.body, { name: tr("API address"), value: emb.base_url, placeholder: "http://localhost:11434/v1", onChange: (v) => (emb.base_url = v.trim()) });
  textField(c.body, { name: tr("API key"), desc: tr("Leave as is to keep the current key."), value: emb.api_key, secret: true, onChange: (v) => (emb.api_key = v.trim()) });
  textField(c.body, { name: tr("Model"), value: emb.model, placeholder: "nomic-embed-text", onChange: (v) => (emb.model = v.trim()) });
  if (a.index) {
    const i = a.index;
    callout(c.body, i.last_error ? "error" : "info",
      i.last_error
        ? tr("Index error: {error}", { error: i.last_error })
        : tr("Index: {embedded} of {chunks} pieces ready, {pending} waiting.", { embedded: i.embedded ?? 0, chunks: i.chunks ?? 0, pending: i.pending ?? 0 }));
  }
  callout(c.body, "info", tr("Changing the address or model rebuilds the search index of all vaults."));
  button(buttonRow(c.body), {
    text: tr("Save"),
    cta: true,
    onClick: async () => {
      try {
        // the server returns the key masked; sending it back unchanged would be "keep", omitting it is clearer
        const payload: Partial<EmbeddingSettings> = { base_url: emb.base_url, model: emb.model };
        if (emb.api_key !== a.embedding.api_key) payload.api_key = emb.api_key;
        await x.putAdminSettings({ embedding: payload });
        a.embedding = { ...emb };
        new Notice(tr("Semantic search settings saved"));
      } catch (e) {
        new Notice(tr("Failed: {error}", { error: errorText(e) }));
      }
    },
  });
};
