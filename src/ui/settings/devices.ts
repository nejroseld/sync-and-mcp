import { t as tr } from "../../i18n";
import { createDeviceAdder } from "../../deviceAdder";
import { isConfigured } from "../../settings";
import { deviceAdderQrUrl } from "../qrTransfer";
import { button, buttonRow, callout, card, copyToClipboard, details, errorText } from "../kit";
import type { SettingsContext } from "./context";

export const renderDevices = (ctx: SettingsContext, el: HTMLElement) => {
  const { plugin, state } = ctx;
  el.createEl("p", {
    cls: "obsi-ui-lead",
    text: tr("Add your phone, tablet or another computer to this vault in a few seconds: no need to type the server, token or passwords again."),
  });

  if (!isConfigured(plugin.settings)) {
    callout(el, "info", tr("Set up sync on this device first, then you can copy the setup to others."));
    return;
  }

  const steps = el.createEl("ol", { cls: "obsi-ui-steps" });
  steps.createEl("li", { text: tr("Install Obsi Sync in Obsidian on the new device and open the vault you want to sync.") });
  steps.createEl("li", { text: tr("In the welcome window choose “Copy setup from another device”.") });
  steps.createEl("li", { text: tr("Scan the QR code below with the camera, or paste the setup text.") });

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
    return;
  }

  const qr = c.body.createDiv({ cls: "obsi-ui-qr" });
  const actions = buttonRow(c.body);
  button(actions, { text: tr("Copy setup text"), icon: "copy", onClick: () => copyToClipboard(payload, tr("Setup text copied. Delete it from where you paste it after use.")) });
  button(actions, {
    text: tr("Hide"),
    icon: "eye-off",
    onClick: () => {
      state.qrVisible = false;
      ctx.refresh();
    },
  });
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

  const raw = details(c.body, tr("Show setup text"));
  const text = raw.createEl("textarea", { cls: "obsi-sync-device-adder-text", attr: { "aria-label": tr("Device-adder text"), readonly: "" } });
  text.value = payload;
  text.rows = 5;

  callout(el, "info", tr("Both devices use the same device token. To revoke access for one device later, create a separate token for it on the Server tab."));
};
