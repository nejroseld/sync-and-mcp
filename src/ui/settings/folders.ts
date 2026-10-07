import { Notice, Setting, TFolder } from "obsidian";
import { t as tr } from "../../i18n";
import { checkVaultPassword } from "../../onboarding";
import { type MountConfig, exportMounts, parseMountsImport, validateMounts } from "../../settings";
import { FakeFsObsiServer } from "../../sync/fsObsiServer";
import { folderVaultName, normalizeMountPath } from "../../sync/mounts";
import {
  type Tone,
  button,
  buttonRow,
  callout,
  card,
  confirmAction,
  copyToClipboard,
  details,
  errorText,
  pill,
  relativeTime,
  textField,
} from "../kit";
import type { SettingsContext } from "./context";

export const mountTitle = (m: MountConfig) => (normalizeMountPath(m.path) === "" ? tr("Whole vault") : m.path);

export const mountStatus = (ctx: SettingsContext, m: MountConfig): { text: string; tone: Tone } => {
  if (m.encryptionMethod !== "rclone-base64") return { text: tr("Unsupported encryption"), tone: "error" };
  if (!m.vaultId) return { text: tr("No server vault"), tone: "warning" };
  if (!m.password) return { text: tr("Needs password"), tone: "warning" };
  if (!ctx.plugin.settings.syncEnabled) return { text: tr("Paused"), tone: "muted" };
  const st = ctx.plugin.syncManager.status.get(m.vaultId);
  if (st?.lastError) return { text: tr("Error"), tone: "error" };
  if (st?.lastOk) return { text: tr("Synced {time}", { time: relativeTime(st.lastOk) }), tone: "success" };
  return { text: tr("Waiting for sync"), tone: "muted" };
};

export const renderFolders = (ctx: SettingsContext, el: HTMLElement) => {
  const { plugin, state } = ctx;
  const s = plugin.settings;

  el.createEl("p", {
    cls: "obsi-ui-lead",
    text: tr("Choose what to sync. Usually it's the whole vault with one server vault. You can also sync separate folders with different server vaults, each with its own password; a folder synced separately is left out of the whole-vault sync."),
  });

  const problems = validateMounts(s.mounts);
  for (const p of problems) callout(el, "error", p);

  // folder suggestions for the path field
  const listId = "obsi-sync-folder-list";
  const datalist = el.createEl("datalist", { attr: { id: listId } });
  for (const f of plugin.app.vault.getAllLoadedFiles()) {
    if (f instanceof TFolder && !f.isRoot()) datalist.createEl("option", { value: f.path });
  }

  if (s.mounts.length === 0) {
    callout(el, "info", tr("Nothing is synced yet. Add the whole vault or a folder."));
  }

  s.mounts.forEach((m, idx) => {
    const st = mountStatus(ctx, m);
    const editing = state.editingMount === idx;
    const c = card(el, {
      icon: normalizeMountPath(m.path) === "" ? "library" : "folder",
      title: mountTitle(m),
      subtitle: m.vaultId ? tr("Synced with “{vault}”", { vault: m.vaultName || m.vaultId }) : tr("No server vault chosen"),
      cls: "obsi-sync-mount",
    });
    if (c.actions) {
      pill(c.actions, st.text, st.tone);
      button(c.actions, {
        text: editing ? tr("Done") : tr("Edit"),
        onClick: () => {
          state.editingMount = editing ? undefined : idx;
          ctx.refresh();
        },
      });
    }
    const status = plugin.syncManager.status.get(m.vaultId);
    if (status?.lastError) callout(c.body, "error", status.lastError);
    if (!editing) return;
    renderMountEditor(ctx, c.body, m, idx, listId);
  });

  const add = buttonRow(el);
  button(add, {
    text: s.mounts.some((x) => normalizeMountPath(x.path) === "") ? tr("Add a folder") : tr("Sync the whole vault"),
    icon: "plus",
    onClick: async () => {
      const hasRoot = s.mounts.some((x) => normalizeMountPath(x.path) === "");
      const m: MountConfig = { path: hasRoot ? tr("New folder") : "", vaultId: "", password: "", encryptionMethod: "rclone-base64" };
      s.mounts.push(m);
      state.editingMount = s.mounts.length - 1;
      await ctx.save();
      ctx.refresh();
    },
  });
  button(add, {
    text: tr("Refresh server vaults"),
    icon: "rotate-cw",
    busyText: tr("Loading..."),
    onClick: async () => {
      await plugin.refreshMe();
      ctx.refresh();
    },
  });

  const more = details(el, tr("Share the folder layout without passwords"));
  more.createEl("p", {
    cls: "obsi-ui-muted",
    text: tr("Copies the list of folders and server vaults, without passwords and tokens. To move the whole setup with secrets, use Devices instead."),
  });
  button(buttonRow(more), { text: tr("Copy layout"), icon: "copy", onClick: () => copyToClipboard(exportMounts(s), tr("Folder layout copied")) });
  let importText = "";
  new Setting(more)
    .setName(tr("Import a layout"))
    .setDesc(tr("Adds folders that are not here yet. Enter their passwords afterwards."))
    .addTextArea((t) => {
      t.setPlaceholder(tr("Paste the copied layout here"));
      t.inputEl.rows = 3;
      t.onChange((v) => (importText = v));
    })
    .addButton((b) =>
      b.setButtonText(tr("Import")).onClick(async () => {
        try {
          const imp = parseMountsImport(importText);
          if (imp.serverUrl && !s.serverUrl) s.serverUrl = imp.serverUrl;
          let added = 0;
          for (const m of imp.mounts) {
            if (!s.mounts.some((x) => x.vaultId === m.vaultId)) {
              s.mounts.push(m);
              added++;
            }
          }
          await ctx.save();
          new Notice(tr("Added {n} folder(s). Now enter their passwords.", { n: added }));
          ctx.refresh();
        } catch (e) {
          new Notice(tr("Import failed: {error}", { error: errorText(e) }));
        }
      })
    );
};

/** An empty server vault for this folder. Any token that belongs to an account can create one. */
const renderCreateVault = (ctx: SettingsContext, form: HTMLElement, m: MountConfig) => {
  const { plugin } = ctx;
  if (!plugin.me) return;
  if (!plugin.me.user) {
    if (!m.vaultId) callout(form, "info", tr("Sign in on the Overview tab to create a server vault for this folder."));
    return;
  }
  let vaultName = folderVaultName(m.path) || plugin.app.vault.getName() || tr("New vault");
  const box = form.createDiv();
  textField(box, {
    name: tr("Create a server vault"),
    desc: tr("Use this when the folder should be its own vault, instead of picking one that already exists. Then set the encryption password."),
    value: vaultName,
    placeholder: tr("New vault"),
    onChange: (v) => (vaultName = v),
  });
  const errorBox = box.createDiv();
  button(buttonRow(box), {
    text: tr("Create vault"),
    icon: "plus",
    busyText: tr("Creating..."),
    onClick: async () => {
      errorBox.empty();
      const name = vaultName.trim();
      if (!name) return void callout(errorBox, "error", tr("Enter a name"));
      const api = plugin.getApi();
      if (!api) return void callout(errorBox, "error", tr("Server vaults are not loaded. Check the connection on the Overview tab."));
      try {
        const created = await api.createOwnedVault(name);
        await plugin.refreshMe();
        for (const id of [m.vaultId, created.id]) if (id) await plugin.syncManager.clearHistory(id);
        m.vaultId = created.id;
        m.vaultName = created.name;
        await ctx.save();
        new Notice(tr("Created vault “{name}”. Set its encryption password if you have not yet.", { name: created.name }));
        ctx.refresh();
      } catch (e) {
        callout(errorBox, "error", tr("Could not create the vault: {error}", { error: errorText(e) }));
      }
    },
  });
};

const renderMountEditor = (ctx: SettingsContext, body: HTMLElement, m: MountConfig, idx: number, listId: string) => {
  const { plugin } = ctx;
  const s = plugin.settings;
  const form = body.createDiv({ cls: "obsi-ui-form" });
  textField(form, {
    name: tr("Folder in this vault"),
    desc: tr("Leave empty to sync the whole vault."),
    value: m.path,
    placeholder: tr("Whole vault"),
    list: listId,
    onChange: (v) => {
      m.path = normalizeMountPath(v);
      void ctx.save().catch((err) => console.error("sync-and-mcp:", err));
    },
  });
  new Setting(form)
    .setName(tr("Server vault"))
    .addDropdown((d) => {
      d.addOption("", tr("Choose..."));
      const known = new Set<string>();
      for (const v of plugin.vaults) {
        d.addOption(v.id, v.name);
        known.add(v.id);
      }
      if (m.vaultId && !known.has(m.vaultId)) d.addOption(m.vaultId, m.vaultName ?? m.vaultId);
      d.setValue(m.vaultId).onChange((v) => {
        void (async () => {
          // a different server vault means a fresh comparison on both sides
          for (const id of [m.vaultId, v]) if (id) await plugin.syncManager.clearHistory(id);
          m.vaultId = v;
          m.vaultName = plugin.vaults.find((x) => x.id === v)?.name;
          await ctx.save();
          ctx.refresh();
        })().catch((err) => console.error("sync-and-mcp:", err));
      });
    })
    .setDesc(plugin.vaults.length ? "" : tr("Server vaults are not loaded. Check the connection on the Overview tab."));
  renderCreateVault(ctx, form, m);
  const { setting: pw } = textField(form, {
    name: tr("Encryption password"),
    desc: tr("The same on every device of this server vault. Stored only on this device; a lost password cannot be recovered."),
    value: m.password,
    secret: true,
    onChange: (v) => {
      m.password = v;
      void ctx.save().catch((err) => console.error("sync-and-mcp:", err));
    },
  });
  const check = form.createDiv();
  pw.addButton((b) =>
    b.setButtonText(tr("Check")).onClick(async () => {
      check.empty();
      const api = plugin.getApi();
      if (!api || !m.vaultId || !m.password) return void callout(check, "warning", tr("Choose a server vault and enter the password first."));
      b.setDisabled(true);
      try {
        const r = await checkVaultPassword(new FakeFsObsiServer(api, m.vaultId), m.password);
        callout(check, r === "mismatch" ? "error" : "success", {
          empty_vault: tr("The server vault is empty: this password will be used from now on."),
          match: tr("The password is correct."),
          mismatch: tr("This password doesn't match the notes in this vault."),
        }[r]);
      } catch (e) {
        callout(check, "error", tr("Could not check: {error}", { error: errorText(e) }));
      } finally {
        b.setDisabled(false);
      }
    })
  );

  const danger = buttonRow(form);
  button(danger, {
    text: tr("Forget sync history"),
    icon: "history",
    onClick: async () => {
      const ok = await confirmAction(
        ctx.app,
        tr("Forget sync history?"),
        tr("The next sync compares all files again, as on first sync. No files are deleted. Use this after changing the password or the server vault."),
        tr("Forget history"),
        false
      );
      if (!ok) return;
      if (m.vaultId) await plugin.syncManager.clearHistory(m.vaultId);
      new Notice(tr("Sync history cleared"));
    },
  });
  button(danger, {
    text: tr("Stop syncing"),
    icon: "trash-2",
    warning: true,
    onClick: async () => {
      const ok = await confirmAction(
        ctx.app,
        tr("Stop syncing “{folder}”?", { folder: mountTitle(m) }),
        tr("The files stay on this device and on the server. Only the connection is removed."),
        tr("Stop syncing")
      );
      if (!ok) return;
      s.mounts.splice(idx, 1);
      ctx.state.editingMount = undefined;
      await ctx.save();
      ctx.refresh();
    },
  });
};
