import { Modal } from "obsidian";
import { ApiError } from "../../api/client";
import { t as tr } from "../../i18n";
import { createDeviceAdder } from "../../deviceAdder";
import { isConfigured } from "../../settings";
import { deviceAdderQrUrl } from "../qrTransfer";
import { button, buttonRow, callout, card, copyToClipboard, details, errorText, relativeTime, sectionTitle, textField } from "../kit";
import { lastUsed, loadedAccount, reloadTokens, tokenList, vaultNames } from "./account";
import type { SettingsContext } from "./context";

export const renderDevices = (ctx: SettingsContext, el: HTMLElement) => {
  const { plugin } = ctx;
  el.createEl("p", {
    cls: "obsi-ui-lead",
    text: tr("Add your phone, tablet or another computer to this vault in a few seconds: no need to type the server, token or passwords again."),
  });

  if (!isConfigured(plugin.settings)) {
    callout(el, "info", tr("Set up sync on this device first, then you can copy the setup to others."));
    return;
  }
  // known without the network: a plain device token can only pass itself on
  if (plugin.me && !plugin.me.account_token) return renderSharedSetup(ctx, el);
  const account = loadedAccount(ctx, el);
  if (!account) return;
  if (account.accountToken) renderAccountDevices(ctx, el);
  else renderSharedSetup(ctx, el);
};

/** A new device token for every synced vault, packed with this device's setup into a QR payload. */
const addDevice = async (ctx: SettingsContext, name: string) => {
  const { plugin } = ctx;
  const grants: Record<string, string[]> = {};
  for (const m of plugin.settings.mounts) grants[m.vaultId] = ["read", "write"];
  const created = await plugin.getApi()!.createOwnToken(name, "device", grants);
  return { name: created.name, payload: createDeviceAdder({ ...plugin.settings, deviceToken: created.token ?? "" }) };
};

const addDeviceError = (e: unknown) =>
  e instanceof ApiError && e.code === "unknown_vault"
    ? tr("One of the synced vaults belongs to another account, so it can't be shared with a new device token. On the new device, sign in to your account instead.")
    : tr("Could not add the device: {error}", { error: errorText(e) });

/**
 * The quick way from the Overview: a name is already filled in, so one click (or Enter) shows the QR code.
 * Without an account session only the shared setup exists, which lives on the Devices tab.
 */
export const openAddDevice = (ctx: SettingsContext) => {
  if (!ctx.plugin.me?.account_token) return ctx.go("devices");
  new AddDeviceModal(ctx).open();
};

class AddDeviceModal extends Modal {
  private name = tr("Phone");
  private added: { name: string; payload: string } | undefined;

  constructor(private ctx: SettingsContext) {
    super(ctx.app);
  }

  onOpen() {
    this.modalEl.addClass("obsi-ui-dialog");
    this.render();
  }

  onClose() {
    // the QR holds a live token: it is not kept anywhere once the window closes
    this.added = undefined;
    this.contentEl.empty();
  }

  private render() {
    const el = this.contentEl;
    el.empty();
    if (this.added) {
      this.titleEl.setText(tr("QR code for “{name}”", { name: this.added.name }));
      callout(el, "info", tr("On the new device, choose “Copy setup from another device” in the welcome window and scan the code."));
      renderQr(el, this.added.payload, () => this.close());
      callout(el, "warning", tr("The code keeps working until you disconnect “{name}” on the Devices tab. Scan it on one device only.", { name: this.added.name }));
      return;
    }
    this.titleEl.setText(tr("Add a device"));
    const { input } = textField(el, { name: tr("Device name"), desc: tr("Helps you recognize it in the list of devices."), value: this.name, onChange: (v) => (this.name = v) });
    const errorBox = el.createDiv();
    const row = el.createDiv({ cls: "obsi-ui-dialog-buttons" });
    button(row, { text: tr("Cancel"), onClick: () => this.close() });
    const create = button(row, {
      text: tr("Create QR code"),
      icon: "qr-code",
      cta: true,
      busyText: tr("Creating..."),
      onClick: async () => {
        errorBox.empty();
        if (!this.name.trim()) return void callout(errorBox, "error", tr("Enter a name"));
        try {
          this.added = await addDevice(this.ctx, this.name.trim());
          this.render();
          // the device list only matters on the Devices tab, which reloads it anyway
          void reloadTokens(this.ctx).catch(() => undefined);
        } catch (e) {
          callout(errorBox, "error", addDeviceError(e));
        }
      },
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) create.buttonEl.click();
    });
    window.setTimeout(() => input.select());
  }
}

const steps = (el: HTMLElement, items: string[]) => {
  const list = el.createEl("ol", { cls: "obsi-ui-steps" });
  for (const text of items) list.createEl("li", { text });
};

/** Signed in to an account: every new device gets its own token, so it can be disconnected alone. */
const renderAccountDevices = (ctx: SettingsContext, el: HTMLElement) => {
  const { state } = ctx;
  sectionTitle(el, tr("Add a device"));
  steps(el, [
    tr("Install Sync and MCP in Obsidian on the new device and open the vault you want to sync."),
    tr("Here, name the new device and create its QR code."),
    tr("On the new device, choose “Copy setup from another device” in the welcome window and scan the code."),
  ]);

  if (state.newDevice) {
    const added = state.newDevice;
    const c = card(el, { icon: "qr-code", title: tr("QR code for “{name}”", { name: added.name }), subtitle: tr("Contains secrets: show it only to this device.") });
    renderQr(c.body, added.payload, () => {
      state.newDevice = undefined;
      ctx.refresh();
    });
    callout(c.body, "info", tr("The code keeps working until you disconnect “{name}” below. Scan it on one device only.", { name: added.name }));
  } else {
    const c = card(el, { icon: "smartphone", title: tr("New device") });
    let name = "";
    const { input } = textField(c.body, { name: tr("Device name"), desc: tr("Helps you recognize it in the list below."), value: name, placeholder: tr("e.g. Phone"), onChange: (v) => (name = v) });
    callout(c.body, "warning", tr("The QR code includes a new device token and the encryption passwords of this vault. Show it only to your own device."));
    const errorBox = c.body.createDiv();
    const create = async () => {
      errorBox.empty();
      if (!name.trim()) return void callout(errorBox, "error", tr("Enter a name"));
      try {
        state.newDevice = await addDevice(ctx, name.trim());
        await reloadTokens(ctx);
      } catch (e) {
        callout(errorBox, "error", addDeviceError(e));
      }
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) void create();
    });
    button(buttonRow(c.body), { text: tr("Create QR code"), icon: "qr-code", cta: true, busyText: tr("Creating..."), onClick: create });
  }

  sectionTitle(el, tr("Your devices"), tr("Devices connected to your account. Disconnect a lost or old device here; the others keep working."));
  tokenList(ctx, el, state.account.tokens.filter((t) => t.kind === "device"), {
    describe: (t) => t.is_session
      ? tr("Signed in {time} · {used}", { time: relativeTime(t.created_at), used: lastUsed(t) })
      : tr("Added {time} · {vaults} · {used}", { time: relativeTime(t.created_at), vaults: vaultNames(ctx, t) || tr("no access"), used: lastUsed(t) }),
    empty: tr("No devices yet."),
  });
  el.createEl("p", { cls: "obsi-ui-muted", text: tr("A device that signs in with your username and password is listed as “Signed in with password”.") });
};

/** Signed in with a plain device token: the QR code passes that same token on. */
const renderSharedSetup = (ctx: SettingsContext, el: HTMLElement) => {
  const { plugin, state } = ctx;
  steps(el, [
    tr("Install Sync and MCP in Obsidian on the new device and open the vault you want to sync."),
    tr("In the welcome window choose “Copy setup from another device”."),
    tr("Scan the QR code below with the camera, or paste the setup text."),
  ]);

  let payload: string;
  try {
    payload = createDeviceAdder(plugin.settings);
  } catch (e) {
    callout(el, "error", tr("The setup can't be copied yet: {error}", { error: errorText(e) }));
    return;
  }

  const c = card(el, { icon: "qr-code", title: tr("Setup QR code"), subtitle: tr("Contains secrets: show it only to your own devices.") });
  if (!state.qrVisible) {
    callout(c.body, "warning", tr("The QR code and text include the device token and encryption passwords. Anyone who sees them can read and change your notes."));
    button(buttonRow(c.body), {
      text: tr("Show QR code"),
      icon: "eye",
      cta: true,
      onClick: () => {
        state.qrVisible = true;
        ctx.refresh();
      },
    });
  } else {
    renderQr(c.body, payload, () => {
      state.qrVisible = false;
      ctx.refresh();
    });
  }
  callout(el, "info", tr("Both devices use the same token. To disconnect devices one by one, sign in to your account (Overview → Connection → Sign in): then every new device gets its own QR code."));
};

const renderQr = (body: HTMLElement, payload: string, hide: () => void) => {
  const qr = body.createDiv({ cls: "obsi-ui-qr" });
  const actions = buttonRow(body);
  button(actions, { text: tr("Copy setup text"), icon: "copy", onClick: () => copyToClipboard(payload, tr("Setup text copied. Delete it from where you paste it after use.")) });
  button(actions, { text: tr("Hide"), icon: "eye-off", onClick: hide });
  void deviceAdderQrUrl(payload)
    .then((url) => {
      if (!qr.isConnected) return;
      const img = qr.createEl("img", { cls: "obsi-sync-device-adder-qr", attr: { alt: tr("Setup QR code containing credentials") } });
      img.src = url;
      actions.createEl("a", { cls: "obsi-ui-link-button", text: tr("Save QR image"), attr: { href: url, download: "obsi-sync-device-adder.png" } });
    })
    .catch((e) => {
      if (qr.isConnected) callout(qr, "warning", tr("The QR code could not be created; use the setup text instead. {error}", { error: errorText(e) }));
    });

  const raw = details(body, tr("Show setup text"));
  const text = raw.createEl("textarea", { cls: "obsi-sync-device-adder-text", attr: { "aria-label": tr("Device-adder text"), readonly: "" } });
  text.value = payload;
  text.rows = 5;
};
