import { Notice, setIcon } from "obsidian";
import { t as tr } from "../../i18n";
import { connectProblem, normalizeServerUrl } from "../../onboarding";
import { isConfigured } from "../../settings";
import { button, buttonRow, callout, card, choiceCard, errorText, icon, pill, relativeTime, sectionTitle, textField } from "../kit";
import { STATE_ICON, syncState } from "../statusBar";
import { aiSummary } from "./ai";
import type { SettingsContext } from "./context";
import { mountTitle, mountStatus } from "./folders";

export const renderOverview = (ctx: SettingsContext, el: HTMLElement) => {
  const { plugin } = ctx;
  const s = plugin.settings;

  if (!isConfigured(s)) {
    renderNotSetUp(ctx, el);
    renderConnection(ctx, el);
    renderAbout(ctx, el);
    return;
  }

  renderStatusHero(ctx, el);

  sectionTitle(el, tr("This vault"));
  const rows = el.createDiv({ cls: "obsi-ui-list" });
  for (const m of s.mounts) {
    const st = mountStatus(ctx, m);
    listRow(rows, {
      icon: m.path === "" ? "library" : "folder",
      title: mountTitle(m),
      desc: tr("Synced with “{vault}”", { vault: m.vaultName || m.vaultId || tr("(no server vault)") }),
      pill: st,
      onClick: () => ctx.go("folders"),
    });
  }
  const ai = aiSummary(ctx);
  listRow(rows, { icon: "sparkles", title: tr("AI access"), desc: ai.text, pill: ai.pill, onClick: () => ctx.go("ai") });
  listRow(rows, {
    icon: "smartphone",
    title: tr("Other devices"),
    desc: tr("Connect a phone or another computer by scanning a QR code."),
    onClick: () => ctx.go("devices"),
  });

  renderConnection(ctx, el);
  renderAbout(ctx, el);
};

const listRow = (
  parent: HTMLElement,
  o: { icon: string; title: string; desc: string; pill?: { text: string; tone: "success" | "warning" | "error" | "muted" | "info" }; onClick: () => void }
) => {
  const row = parent.createEl("button", { cls: "obsi-ui-list-row" });
  row.type = "button";
  icon(row, o.icon, "obsi-ui-list-icon");
  const text = row.createDiv({ cls: "obsi-ui-list-text" });
  text.createDiv({ cls: "obsi-ui-list-title", text: o.title });
  text.createDiv({ cls: "obsi-ui-list-desc", text: o.desc });
  if (o.pill) pill(row, o.pill.text, o.pill.tone);
  icon(row, "chevron-right", "obsi-ui-list-chevron");
  row.addEventListener("click", o.onClick);
};

const renderNotSetUp = (ctx: SettingsContext, el: HTMLElement) => {
  const hero = el.createDiv({ cls: "obsi-ui-hero" });
  setIcon(hero.createDiv({ cls: "obsi-ui-hero-icon" }), "refresh-cw");
  const text = hero.createDiv({ cls: "obsi-ui-hero-text" });
  text.createDiv({ cls: "obsi-ui-hero-title", text: tr("Obsi Sync is not set up yet") });
  text.createDiv({ cls: "obsi-ui-hero-desc", text: tr("Nothing is synced until this vault is connected to your server. Setup takes about a minute.") });
  const choices = el.createDiv({ cls: "obsi-ui-choices" });
  choiceCard(choices, {
    icon: "server",
    title: tr("Connect to my server"),
    desc: tr("I have a server address and a device token."),
    onClick: () => ctx.plugin.openSetup(),
  });
  choiceCard(choices, {
    icon: "smartphone",
    title: tr("Copy setup from another device"),
    desc: tr("Obsi Sync already works on another device. Use its QR code or setup text."),
    onClick: () => ctx.plugin.openSetup("import"),
  });
};

const renderStatusHero = (ctx: SettingsContext, el: HTMLElement) => {
  const { plugin } = ctx;
  const hero = el.createDiv({ cls: "obsi-ui-hero" });
  const iconEl = hero.createDiv({ cls: "obsi-ui-hero-icon" });
  const text = hero.createDiv({ cls: "obsi-ui-hero-text" });
  const title = text.createDiv({ cls: "obsi-ui-hero-title" });
  const desc = text.createDiv({ cls: "obsi-ui-hero-desc" });
  const meter = text.createDiv({ cls: "obsi-ui-meter" });
  const fill = meter.createDiv();
  const actions = hero.createDiv({ cls: "obsi-ui-hero-actions" });
  const problems = el.createDiv();

  let drawn: string | undefined;
  const draw = (live?: string, progress?: { done: number; total: number }) => {
    const state = syncState(plugin);
    hero.dataset.state = state;
    setIcon(iconEl, STATE_ICON[state]);
    iconEl.toggleClass("is-spinning", state === "syncing");
    meter.toggle(state === "syncing");
    if (progress && progress.total > 0) {
      meter.addClass("is-determinate");
      fill.style.width = `${Math.round((progress.done / progress.total) * 100)}%`;
    } else if (state !== "syncing") {
      meter.removeClass("is-determinate");
    }
    const last = plugin.syncManager.lastRunAt;
    const s = plugin.settings;
    const schedule = [s.syncOnSave && tr("on save"), s.syncOnStartup && tr("on startup"), s.autoSyncMinutes > 0 && tr("every {n} min", { n: s.autoSyncMinutes })]
      .filter(Boolean)
      .join(", ");
    switch (state) {
      case "syncing":
        title.setText(tr("Syncing..."));
        desc.setText(live ?? tr("Comparing this vault with the server."));
        break;
      case "paused":
        title.setText(tr("Sync is paused"));
        desc.setText(tr("Changes stay on this device until you resume."));
        break;
      case "error":
        title.setText(tr("Sync needs attention"));
        desc.setText(tr("The last sync {time} did not finish. Obsi Sync will retry automatically.", { time: relativeTime(last) }));
        break;
      case "synced":
        title.setText(tr("Everything is synced"));
        desc.setText(tr("Last sync {time}. Syncs automatically: {schedule}.", { time: relativeTime(last), schedule: schedule || tr("manually only") }));
        break;
      default:
        title.setText(tr("Ready to sync"));
        desc.setText(schedule ? tr("Syncs automatically: {schedule}.", { schedule }) : tr("Automatic sync is off. Use “Sync now”."));
    }
    // buttons and problems only change with the state, not with every progress tick
    if (drawn === state && state === "syncing") return;
    drawn = state;
    actions.empty();
    if (state === "paused") {
      button(actions, { text: tr("Resume sync"), icon: "play", cta: true, onClick: async () => { await plugin.setSyncEnabled(true); draw(); } });
    } else {
      button(actions, {
        text: tr("Sync now"),
        icon: "refresh-cw",
        cta: true,
        onClick: () => void plugin.syncManager.syncAll("manual"),
      }).setDisabled(state === "syncing");
      button(actions, { text: tr("Pause"), icon: "pause", onClick: async () => { await plugin.setSyncEnabled(false); draw(); } });
    }
    problems.empty();
    if (state === "error") {
      for (const f of plugin.syncManager.failures()) {
        const m = plugin.settings.mounts.find((x) => x.vaultId === f.vaultId);
        callout(problems, "error", `${m ? mountTitle(m) : f.path || tr("Whole vault")}: ${f.lastError}`);
      }
    }
  };
  draw();
  const unsubscribe = plugin.syncManager.subscribe((live, progress) => draw(live, progress));
  const timer = window.setInterval(() => {
    if (!plugin.syncManager.running) draw();
  }, 30_000);
  ctx.onCleanup(() => {
    unsubscribe();
    window.clearInterval(timer);
  });
};

const renderConnection = (ctx: SettingsContext, el: HTMLElement) => {
  const { plugin, state } = ctx;
  const s = plugin.settings;
  sectionTitle(el, tr("Connection"));
  const c = card(el, {
    icon: "server",
    title: s.serverUrl || tr("No server"),
    subtitle: plugin.me ? tr("Signed in as “{name}”", { name: plugin.me.name }) : s.deviceToken ? tr("Device token saved") : tr("No device token"),
  });
  // attached on first check only, so an unchecked card has no empty body
  const result = createDiv();
  const check = async () => {
    result.empty();
    if (!result.isConnected) c.body.prepend(result);
    const api = plugin.getApi();
    if (!api) return void callout(result, "warning", tr("Enter the server address and device token."));
    try {
      const h = await api.health();
      const me = await api.me();
      plugin.me = me;
      plugin.vaults = await api.listVaults();
      const names = plugin.vaults.map((v) => v.name).join(", ") || tr("none");
      callout(result, me.kind === "device" ? "success" : "warning",
        me.kind === "device"
          ? tr("Connected as “{name}”. Server {version}. Vaults: {vaults}.", { name: me.name, version: h.version, vaults: names })
          : tr("This is a “{kind}” token, not a device token. Sync needs a device token.", { kind: me.kind }));
      if (c.subtitleEl) c.subtitleEl.setText(tr("Signed in as “{name}”", { name: me.name }));
    } catch (e) {
      const p = connectProblem(e);
      callout(result, "error", {
        bad_url: tr("No Obsi server answered at this address. Check the address and the port."),
        unreachable: tr("Can't reach the server. Check the address and your internet connection."),
        bad_token: tr("The server didn't accept this token. Copy it again, without extra spaces."),
        server_error: tr("The server returned an error: {error}", { error: errorText(e) }),
      }[p]);
    }
  };
  if (c.actions) {
    button(c.actions, { text: tr("Check"), busyText: tr("Checking..."), onClick: check });
    if (!state.connectionEditing) button(c.actions, { text: tr("Change"), onClick: () => { state.connectionEditing = true; ctx.refresh(); } });
  }
  if (!state.connectionEditing) return;

  const form = c.body.createDiv({ cls: "obsi-ui-form" });
  let url = s.serverUrl;
  let token = s.deviceToken;
  textField(form, { name: tr("Server address"), value: url, placeholder: "https://obsi.example.com", onChange: (v) => (url = v) });
  textField(form, { name: tr("Device token"), desc: tr("A token of kind “device” with read and write access to your vaults."), value: token, secret: true, onChange: (v) => (token = v.trim()) });
  callout(form, "info", tr("Changing the server or token does not touch your notes. Folders and passwords stay as they are."));
  const row = buttonRow(form);
  button(row, { text: tr("Cancel"), onClick: () => { state.connectionEditing = false; ctx.refresh(); } });
  button(row, {
    text: tr("Save"),
    cta: true,
    onClick: async () => {
      s.serverUrl = normalizeServerUrl(url);
      s.deviceToken = token;
      plugin.me = undefined;
      await ctx.save();
      await plugin.refreshMe();
      state.connectionEditing = false;
      new Notice(tr("Connection saved"));
      ctx.refresh();
    },
  });
};

const renderAbout = (ctx: SettingsContext, el: HTMLElement) => {
  const { plugin, state } = ctx;
  const about = el.createDiv({ cls: "obsi-ui-about" });
  const version = about.createEl("button", { cls: "obsi-ui-link", text: tr("Obsi Sync {version}", { version: plugin.manifest.version }) });
  version.addEventListener("click", () => {
    if (state.devUnlocked) return;
    if (++state.devClicks >= 7) {
      state.devUnlocked = true;
      new Notice(tr("Developer tools unlocked"));
      ctx.go("dev");
    }
  });
  if (isConfigured(plugin.settings)) {
    button(about, { text: tr("Run setup again"), onClick: () => plugin.openSetup() });
  }
};
