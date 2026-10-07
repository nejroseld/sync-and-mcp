import { Modal, Notice } from "obsidian";
import { t as tr } from "../i18n";
import type ObsiSyncPlugin from "../main";
import { button, buttonRow, callout, errorText } from "./kit";

/**
 * On-demand look at notes an MCP client has written and not yet applied.
 * Opens with a single fetch; nothing is polled while the window is closed.
 */
export const openMcpPreview = (plugin: ObsiSyncPlugin) => {
  new McpPreviewModal(plugin).open();
};

class McpPreviewModal extends Modal {
  private generation = 0;

  constructor(private plugin: ObsiSyncPlugin) {
    super(plugin.app);
  }

  onOpen() {
    this.modalEl.addClass("obsi-ui-dialog");
    this.titleEl.setText(tr("What AI wrote"));
    void this.render();
  }

  private async render() {
    const gen = ++this.generation;
    const el = this.contentEl;
    el.empty();
    el.createEl("p", {
      cls: "obsi-ui-lead",
      text: tr("Notes an assistant wrote through MCP and that are not in the vault yet. Opened only when you ask; nothing is checked in the background."),
    });
    const status = el.createDiv();
    status.createEl("p", { cls: "obsi-ui-muted", text: tr("Loading...") });
    let report: Awaited<ReturnType<typeof this.plugin.applier.listPending>>;
    try {
      report = await this.plugin.applier.listPending();
    } catch (e) {
      status.empty();
      callout(status, "error", tr("Could not load AI edits: {error}", { error: errorText(e) }));
      report = { items: [], errors: [] };
    }
    if (gen !== this.generation || !el.isConnected) return;
    status.empty();
    if (report.skipped) {
      callout(status, "warning", tr("Nothing to show: {reason}", { reason: report.skipped }));
    }
    for (const err of report.errors) callout(status, "error", err);
    if (!report.skipped && report.items.length === 0 && report.errors.length === 0) {
      callout(status, "info", tr("Nothing from AI is waiting."));
    }
    for (const item of report.items) {
      const block = el.createDiv({ cls: "obsi-ui-card" });
      const head = block.createDiv({ cls: "obsi-ui-card-body" });
      head.createDiv({ cls: "obsi-ui-list-title", text: item.path });
      const who = item.author ? tr("by {name}", { name: item.author }) : "";
      const kind = item.op === "create" ? tr("New note") : tr("Changed note");
      head.createDiv({
        cls: "obsi-ui-muted",
        text: [kind, item.vaultName, who].filter(Boolean).join(" · "),
      });
      if (item.excerpt) head.createEl("pre", { cls: "obsi-ui-snippet", text: item.excerpt });
    }
    const row = buttonRow(el);
    button(row, {
      text: tr("Refresh"),
      icon: "rotate-cw",
      onClick: () => void this.render(),
    });
    if (report.items.length > 0) {
      button(row, {
        text: tr("Apply AI edits"),
        icon: "download",
        cta: true,
        busyText: tr("Checking..."),
        onClick: async () => {
          const r = await this.plugin.applier.runNow();
          new Notice(
            r.skipped
              ? tr("Nothing applied: {reason}", { reason: r.skipped })
              : tr("AI edits: {applied} applied, {conflicts} conflicts, {rejected} rejected", {
                  applied: r.applied,
                  conflicts: r.conflicts,
                  rejected: r.rejected,
                })
          );
          await this.render();
        },
      });
    }
  }
}
