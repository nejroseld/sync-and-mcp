import { Notice } from "obsidian";
import { t as tr } from "../../i18n";
import { button, buttonRow, card } from "../kit";
import type { SettingsContext } from "./context";

export const renderDev = (ctx: SettingsContext, el: HTMLElement) => {
  const { plugin } = ctx;
  const c = card(el, { icon: "bug", title: tr("Developer tools"), subtitle: tr("Visible until the settings window is closed.") });
  const row = buttonRow(c.body);
  button(row, { text: tr("Show welcome screen"), onClick: () => plugin.openSetup() });
  button(row, {
    text: tr("Show welcome screen on next start"),
    onClick: async () => {
      plugin.settings.onboardingDone = false;
      await ctx.save();
      new Notice(tr("The welcome screen will open on the next start if sync is not set up."));
    },
  });
  c.body.createEl("p", {
    cls: "obsi-ui-muted",
    text: tr("Opening the welcome screen does not reset anything; finishing it can update the connection and the whole-vault folder."),
  });
};
