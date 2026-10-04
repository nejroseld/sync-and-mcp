import { t as tr } from "../../i18n";
import { callout, details, sectionTitle, selectField, toggleField } from "../kit";
import type { SettingsContext } from "./context";

export const renderSync = (ctx: SettingsContext, el: HTMLElement) => {
  const s = ctx.plugin.settings;
  const set = async (fn: () => void, redraw = false) => {
    fn();
    await ctx.save();
    if (redraw) ctx.refresh();
  };

  toggleField(el, {
    name: tr("Sync on this device"),
    desc: tr("Turn off to pause all syncing. Your notes stay as they are."),
    value: s.syncEnabled,
    onChange: (v) => void ctx.plugin.setSyncEnabled(v).then(() => ctx.refresh()),
  }).settingEl.addClass("obsi-ui-setting-main");

  sectionTitle(el, tr("When to sync"));
  toggleField(el, { name: tr("When a note is saved"), desc: tr("A couple of seconds after you stop typing."), value: s.syncOnSave, onChange: (v) => void set(() => (s.syncOnSave = v)) });
  toggleField(el, { name: tr("When Obsidian starts"), value: s.syncOnStartup, onChange: (v) => void set(() => (s.syncOnStartup = v)) });
  selectField(el, {
    name: tr("Regularly in the background"),
    desc: tr("Picks up changes made on other devices."),
    options: [
      [0, tr("Never")],
      [1, tr("Every minute")],
      [5, tr("Every 5 minutes")],
      [10, tr("Every 10 minutes")],
      [15, tr("Every 15 minutes")],
      [30, tr("Every 30 minutes")],
      [60, tr("Every hour")],
    ],
    value: s.autoSyncMinutes,
    onChange: (v) => void set(() => (s.autoSyncMinutes = v)),
  });

  sectionTitle(el, tr("Conflicts and safety"));
  selectField(el, {
    name: tr("If a note changed on two devices"),
    options: [
      ["keep_newer", tr("Keep the newer version")],
      ["keep_larger", tr("Keep the larger version")],
    ],
    value: s.conflictAction,
    onChange: (v) => void set(() => (s.conflictAction = v)),
  });
  selectField(el, {
    name: tr("Stop a sync that would change too much"),
    desc: tr("Protects against mass deletion, e.g. after a wrong folder setup. Applies when there are 10 or more files."),
    options: [
      [-1, tr("Never stop")],
      [25, tr("More than 25% of files")],
      [50, tr("More than 50% of files")],
      [75, tr("More than 75% of files")],
      [90, tr("More than 90% of files")],
    ],
    value: s.protectModifyPercentage,
    onChange: (v) => void set(() => (s.protectModifyPercentage = v)),
  });
  selectField(el, {
    name: tr("Files deleted on another device go to"),
    options: [
      ["obsidian", tr("Obsidian trash (.trash folder)")],
      ["system", tr("System trash")],
    ],
    value: s.deleteToWhere,
    onChange: (v) => void set(() => (s.deleteToWhere = v)),
  });

  sectionTitle(el, tr("Appearance"));
  toggleField(el, {
    name: tr("Show status in the status bar"),
    desc: tr("Sync state at the bottom of the window; click it for quick actions."),
    value: s.statusBar,
    onChange: (v) => void set(() => (s.statusBar = v)),
  });

  const adv = details(el, tr("Advanced"));
  toggleField(adv, {
    name: tr("Sync Obsidian settings folder"),
    desc: tr("Also syncs themes, plugins and their settings (whole-vault sync only). Settings of other plugins, including their secrets, are uploaded encrypted."),
    value: s.syncConfigDir,
    onChange: (v) => void set(() => (s.syncConfigDir = v), true),
  });
  if (s.syncConfigDir) callout(adv, "warning", tr("Different devices with different plugins may overwrite each other's settings."));
  selectField(adv, {
    name: tr("Delay before the startup sync"),
    options: [
      [1, tr("1 second")],
      [5, tr("5 seconds")],
      [15, tr("15 seconds")],
      [30, tr("30 seconds")],
      [60, tr("1 minute")],
    ],
    value: s.startupDelaySeconds,
    onChange: (v) => void set(() => (s.startupDelaySeconds = v)),
  });
  selectField(adv, {
    name: tr("Parallel transfers"),
    desc: tr("More is faster on a good connection."),
    options: [[1, "1"], [2, "2"], [3, "3"], [5, "5"], [8, "8"]],
    value: s.concurrency,
    onChange: (v) => void set(() => (s.concurrency = v)),
  });
};
