import { type App, Modal, Notice, Setting } from "obsidian";
import type { ObsiApi } from "../../api/client";
import type { EmbeddingSettings, TokenInfo, TokenKind, VaultInfo } from "../../api/types";
import { t as tr } from "../../i18n";
import {
  button,
  buttonRow,
  callout,
  card,
  choiceCard,
  choiceGroup,
  confirmAction,
  copyToClipboard,
  errorText,
  pill,
  relativeTime,
  sectionTitle,
  textField,
} from "../kit";
import type { SettingsContext } from "./context";

const KIND_LABEL = (kind: TokenKind) =>
  ({ device: tr("Device"), mcp: tr("AI assistant"), admin: tr("Admin") })[kind] ?? kind;

const OPS: Record<Exclude<TokenKind, "admin">, Array<[string, string]>> = {
  device: [["read", "Read"], ["write", "Write"]],
  mcp: [["list", "List"], ["search", "Search"], ["read", "Read"], ["write", "Suggest edits"]],
};

export const renderServer = (ctx: SettingsContext, el: HTMLElement) => {
  const { plugin, state } = ctx;
  const s = plugin.settings;
  const a = state.admin;

  el.createEl("p", {
    cls: "obsi-ui-lead",
    text: tr("For whoever runs the Obsi server: invite people, manage vaults and tokens, set up semantic search. Needs the admin token from the server installation. Your own devices and assistants are on the Devices and AI tabs."),
  });

  const api = () => plugin.getAdminApi();
  const load = async () => {
    const x = api();
    if (!x || a.loading) return;
    a.loading = true;
    try {
      const [vaults, tokens, settings, invites, users] = await Promise.all([x.listVaults(), x.listTokens(), x.getAdminSettings(), x.listInvites(), x.listUsers()]);
      plugin.vaults = vaults;
      a.tokens = tokens;
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
  renderTokens(ctx, el, x);
  renderEmbeddings(ctx, el, x);
};

const renderUserAccounts = (ctx: SettingsContext, el: HTMLElement, x: ObsiApi) => {
  const a = ctx.state.admin;
  const section = sectionTitle(el, tr("People"), tr("Everyone signs in with their own account and sees only their own vaults. To add someone, send them an invitation."));
  const invite = card(section, { icon: "mail", title: tr("Invite someone") });
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
    section.createDiv({ cls: "obsi-ui-section-title", text: tr("Waiting for sign-up") });
    const list = section.createDiv({ cls: "obsi-ui-list" });
    for (const i of pending) new Setting(list).setName(i.name).setDesc(tr("Invited {time}. The code works once.", { time: relativeTime(i.created_at) }));
  }

  section.createDiv({ cls: "obsi-ui-section-title", text: tr("Accounts ({count})", { count: a.users.length }) });
  const users = section.createDiv({ cls: "obsi-ui-list", attr: { "aria-label": tr("User accounts") } });
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
    tr("Obsi Sync invitation for {name}", { name }),
    tr("Server: {url}", { url: serverUrl }),
    tr("Code: {code}", { code }),
    tr("In Obsidian: Obsi Sync → “I have an invitation”, paste this whole message. The code works once."),
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
  const { plugin } = ctx;
  sectionTitle(el, tr("Vaults"), tr("Each vault is a separate encrypted space on the server."));
  const list = el.createDiv({ cls: "obsi-ui-list" });
  for (const v of plugin.vaults) {
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
          plugin.vaults = await x.listVaults();
          ctx.refresh();
        } catch (e) {
          new Notice(tr("Failed: {error}", { error: errorText(e) }));
        }
      })
    );
};

const grantsText = (t: TokenInfo, vaults: VaultInfo[]) =>
  Object.entries(t.grants ?? {})
    .map(([vid, ops]) => `${vaults.find((v) => v.id === vid)?.name ?? vid}: ${ops.join(", ")}`)
    .join("; ") || tr("no access");

const renderTokens = (ctx: SettingsContext, el: HTMLElement, x: ObsiApi) => {
  const { plugin, state } = ctx;
  const head = sectionTitle(el, tr("Access tokens"), tr("Give each device and each AI assistant its own token, so you can revoke one without touching the others."));
  button(head, {
    text: tr("New token"),
    icon: "plus",
    cta: true,
    onClick: () =>
      new NewTokenModal(ctx.app, x, plugin.vaults, async () => {
        state.admin.tokens = await x.listTokens();
        ctx.refresh();
      }).open(),
  });
  const active = state.admin.tokens.filter((t) => !t.revoked_at);
  const revoked = state.admin.tokens.filter((t) => t.revoked_at);
  const list = el.createDiv({ cls: "obsi-ui-list" });
  for (const t of [...active, ...revoked]) {
    const row = new Setting(list).setName(t.name).setDesc(
      tr("{grants} · last used {time}", { grants: t.kind === "admin" ? tr("full server administration") : grantsText(t, plugin.vaults), time: relativeTime(t.last_used_at ?? undefined) })
    );
    row.nameEl.createSpan({ text: " " });
    pill(row.nameEl, KIND_LABEL(t.kind), t.kind === "admin" ? "warning" : "info");
    if (t.revoked_at) {
      row.settingEl.addClass("is-revoked");
      pill(row.nameEl, tr("revoked"), "muted");
      continue;
    }
    if (plugin.me && plugin.me.name === t.name && t.kind === "device") pill(row.nameEl, tr("this device"), "success");
    row.addButton((b) =>
      b.setButtonText(tr("Revoke")).setWarning().onClick(async () => {
        const ok = await confirmAction(ctx.app, tr("Revoke “{name}”?", { name: t.name }), tr("Everything using this token loses access immediately. This can't be undone."), tr("Revoke"));
        if (!ok) return;
        try {
          await x.revokeToken(t.id);
          state.admin.tokens = await x.listTokens();
          ctx.refresh();
        } catch (e) {
          new Notice(tr("Failed: {error}", { error: errorText(e) }));
        }
      })
    );
  }
  if (state.admin.tokens.length === 0) list.createEl("p", { cls: "obsi-ui-muted", text: tr("No tokens yet.") });
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

/** Create a token: name, kind, access per vault; then show it once. */
class NewTokenModal extends Modal {
  private name = "";
  private kind: TokenKind = "device";
  private grants: Record<string, Set<string>> = {};
  private created: TokenInfo | undefined;

  constructor(
    app: App,
    private api: ObsiApi,
    private vaults: VaultInfo[],
    private onCreated: () => Promise<void>
  ) {
    super(app);
  }

  onOpen() {
    this.modalEl.addClass("obsi-ui-dialog", "obsi-sync-token-modal");
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  private defaults() {
    this.grants = {};
    if (this.kind === "admin") return;
    const ops = OPS[this.kind].map(([op]) => op);
    for (const v of this.vaults) this.grants[v.id] = new Set(this.vaults.length === 1 ? ops : []);
  }

  private render() {
    const el = this.contentEl;
    el.empty();
    if (this.created) return this.renderCreated();
    this.titleEl.setText(tr("New access token"));
    if (Object.keys(this.grants).length === 0) this.defaults();

    textField(el, { name: tr("Name"), desc: tr("Who will use it, e.g. “Phone” or “Claude Desktop”."), value: this.name, onChange: (v) => (this.name = v) });

    const group = choiceGroup(el, tr("Kind"));
    const kind = (k: TokenKind, icon: string, title: string, desc: string) =>
      choiceCard(group, {
        icon,
        title,
        desc,
        selected: this.kind === k,
        onClick: () => {
          this.kind = k;
          this.defaults();
          this.render();
        },
      });
    kind("device", "smartphone", tr("Device"), tr("For Obsi Sync on a phone or computer."));
    kind("mcp", "sparkles", tr("AI assistant"), tr("For an MCP client: it sees only notes shared with AI."));
    kind("admin", "shield", tr("Admin"), tr("Full control of the server. Keep it to yourself."));

    if (this.kind !== "admin") {
      const ops = OPS[this.kind];
      const table = el.createDiv({ cls: "obsi-ui-grants" });
      table.createDiv({ cls: "obsi-ui-section-title", text: tr("Access") });
      if (this.vaults.length === 0) callout(table, "warning", tr("There are no vaults yet. Create one first."));
      for (const v of this.vaults) {
        const set = (this.grants[v.id] ??= new Set());
        const row = table.createDiv({ cls: "obsi-ui-grant-row" });
        row.createDiv({ cls: "obsi-ui-grant-vault", text: v.name });
        for (const [op, label] of ops) {
          const l = row.createEl("label");
          const cb = l.createEl("input", { type: "checkbox" });
          cb.checked = set.has(op);
          cb.addEventListener("change", () => (cb.checked ? set.add(op) : set.delete(op)));
          l.appendText(tr(label));
        }
      }
    } else {
      callout(el, "warning", tr("An admin token can create and revoke tokens and change server settings. It can't read notes."));
    }

    const row = el.createDiv({ cls: "obsi-ui-dialog-buttons" });
    button(row, { text: tr("Cancel"), onClick: () => this.close() });
    button(row, {
      text: tr("Create token"),
      cta: true,
      busyText: tr("Creating..."),
      onClick: async () => {
        if (!this.name.trim()) return void new Notice(tr("Enter a name"));
        const grants: Record<string, string[]> = {};
        for (const [vid, set] of Object.entries(this.grants)) if (set.size) grants[vid] = [...set];
        try {
          this.created = await this.api.createToken(this.name.trim(), this.kind, grants);
          await this.onCreated();
          this.render();
        } catch (e) {
          new Notice(tr("Failed: {error}", { error: errorText(e) }));
        }
      },
    });
  }

  private renderCreated() {
    const t = this.created!;
    const el = this.contentEl;
    this.titleEl.setText(tr("Token “{name}” created", { name: t.name }));
    callout(el, "warning", tr("Copy it now: it is shown only once."));
    el.createEl("code", { cls: "obsi-ui-token", text: t.token ?? "" });
    const row = el.createDiv({ cls: "obsi-ui-dialog-buttons" });
    button(row, { text: tr("Copy"), icon: "copy", onClick: () => copyToClipboard(t.token ?? "", tr("Token copied")) });
    button(row, { text: tr("Done"), cta: true, onClick: () => this.close() });
  }
}
