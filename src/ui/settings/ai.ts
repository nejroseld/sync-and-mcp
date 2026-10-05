import { Notice, Setting, TFolder } from "obsidian";
import type { PublishReport } from "../../ai/publisher";
import {
  STARTER_RULES,
  STARTER_RULES_ALLOW,
  type FolderRule,
  type PropertyRule,
  type RuleBase,
  type RulesConfig,
  type RulesPreset,
  isCheckboxRule,
  rulesPreset,
} from "../../ai/rules";
import { t as tr } from "../../i18n";
import { normalizeMountPath } from "../../sync/mounts";
import {
  type Tone,
  ask,
  button,
  buttonRow,
  callout,
  card,
  choiceCard,
  choiceGroup,
  confirmAction,
  details,
  errorText,
  pill,
  sectionTitle,
  selectField,
} from "../kit";
import { renderAssistants } from "./assistants";
import type { SettingsContext } from "./context";

type Choice = "off" | RulesPreset;

/** Current AI access on this device, from the setting and the (cached) shared rules file. */
const currentChoice = (ctx: SettingsContext): Choice | "no_rules" => {
  if (!ctx.plugin.settings.aiEnabled) return "off";
  const rules = ctx.plugin.rules.peek();
  if (rules === undefined) return "custom";
  if (rules === null) return "no_rules";
  return rulesPreset(rules.config);
};

/** One-line summary for the Overview tab. */
export const aiSummary = (ctx: SettingsContext): { text: string; pill?: { text: string; tone: Tone } } => {
  const c = currentChoice(ctx);
  const failed = ctx.plugin.publisher.last?.perVault.some((v) => v.error);
  const on = (text: string) => ({ text, pill: failed ? { text: tr("Error"), tone: "error" as Tone } : { text: tr("On"), tone: "info" as Tone } });
  switch (c) {
    case "off": return { text: tr("AI assistants can't read your notes."), pill: { text: tr("Off"), tone: "muted" } };
    case "no_rules": return { text: tr("On, but no rules yet: nothing is shared."), pill: { text: tr("Needs setup"), tone: "warning" } };
    case "ticked": return on(tr("AI can read notes with “ai” ticked."));
    case "all_but_private": return on(tr("AI can read all notes except those with “private” ticked."));
    case "custom": return on(tr("AI can read notes allowed by your custom rules."));
  }
};

const skippedText = (reason: string) => {
  if (reason.startsWith("no root mount")) return tr("AI access needs the whole vault to be synced. Add it on the Folders tab.");
  if (reason.startsWith("no .obsi/ai-rules.json")) return tr("There are no AI rules yet. Choose what AI can read above.");
  if (reason.startsWith("rules file has errors")) return tr("The AI rules file has errors, so nothing is published: {details}", { details: reason.replace(/^rules file has errors: /, "") });
  if (reason.startsWith("server is not configured")) return tr("Connect to a server first.");
  if (reason === "AI Available is disabled") return tr("AI access is off on this device.");
  return reason;
};

const reportText = (r: PublishReport | undefined): { tone: Tone; text: string } | undefined => {
  if (!r) return undefined;
  if (r.skipped) return { tone: "warning", text: skippedText(r.skipped) };
  const errors = r.perVault.filter((v) => v.error);
  if (errors.length) return { tone: "error", text: errors.map((v) => `${v.vaultId}: ${v.error}`).join("; ") };
  const put = r.perVault.reduce((n, v) => n + v.put, 0);
  const deleted = r.perVault.reduce((n, v) => n + v.deleted, 0);
  return { tone: "success", text: put || deleted ? tr("Up to date: {put} file(s) shared, {deleted} removed in the last run.", { put, deleted }) : tr("Up to date. Nothing changed in the last run.") };
};

export const renderAi = (ctx: SettingsContext, el: HTMLElement) => {
  const { plugin, state } = ctx;
  const s = plugin.settings;

  if (state.rulesDraft === undefined) {
    void plugin.rules.load(true).then((p) => {
      state.rulesDraft = p === null ? null : structuredClone(p.config);
      state.rulesErrors = p?.errors ?? [];
      state.rulesDirty = false;
      ctx.refresh();
    });
    el.createEl("p", { cls: "obsi-ui-muted", text: tr("Loading...") });
    return;
  }

  el.createEl("p", {
    cls: "obsi-ui-lead",
    text: tr("Let AI assistants (Claude and others, via MCP) read and suggest edits to the notes you allow. Allowed notes are stored on the server without end-to-end encryption; everything else stays encrypted."),
  });

  if (!s.mounts.some((m) => m.vaultId && normalizeMountPath(m.path) === "")) {
    callout(el, "warning", tr("AI access needs the whole vault to be synced. Add it on the Folders tab."));
  }

  const choice = currentChoice(ctx);
  const shown: Choice = choice === "no_rules" ? "off" : choice;
  sectionTitle(el, tr("What can AI read?"), tr("Rules are stored in the vault and apply to all your devices."));
  const group = choiceGroup(el, tr("What can AI read?"));
  const option = (value: Choice, icon: string, title: string, desc: string) =>
    choiceCard(group, { icon, title, desc, selected: shown === value, onClick: () => void choose(ctx, value) });
  option("off", "lock", tr("Nothing"), tr("AI access is off on this device."));
  option("ticked", "check-square", tr("Only notes I mark"), tr("New notes get an “ai” checkbox. Tick it to share a note with AI."));
  option("all_but_private", "eye", tr("All notes except private ones"), tr("New notes get a “private” checkbox. Tick it to hide a note from AI."));
  option("custom", "sliders-horizontal", tr("Custom rules"), tr("Choose by folders and note properties."));
  if (choice === "no_rules") callout(el, "warning", tr("AI access is on, but there are no rules yet, so nothing is shared. Choose an option above."));

  if (s.aiEnabled) renderPublishStatus(ctx, el);
  if (s.aiEnabled && (choice === "custom" || state.rulesEditorOpen) && state.rulesDraft) renderRulesEditor(ctx, el, state.rulesDraft);

  if (s.aiEnabled || plugin.me?.account_token) renderAssistants(ctx, el);

  const adv = details(el, tr("Advanced"));
  selectField(adv, {
    name: tr("Largest file to share"),
    desc: tr("Bigger attachments are not shared with AI."),
    options: [[5, "5 MB"], [10, "10 MB"], [25, "25 MB"], [50, "50 MB"], [100, "100 MB"]],
    value: s.aiMaxFileMB,
    onChange: async (v) => {
      s.aiMaxFileMB = v;
      await ctx.save();
    },
  });
  selectField(adv, {
    name: tr("Check for edits from AI"),
    desc: tr("Edits suggested by AI are applied to your notes after this check. They are also checked after every sync."),
    options: [
      [0, tr("Only after sync")],
      [1, tr("Every minute")],
      [2, tr("Every 2 minutes")],
      [5, tr("Every 5 minutes")],
      [15, tr("Every 15 minutes")],
    ],
    value: s.changesPollMinutes,
    onChange: async (v) => {
      s.changesPollMinutes = v;
      await ctx.save();
    },
  });
  new Setting(adv)
    .setName(tr("Remove shared notes from the server"))
    .setDesc(tr("Deletes everything this device has shared with AI. Your notes are not affected."))
    .addButton((b) =>
      b.setButtonText(tr("Remove")).setWarning().onClick(async () => {
        const ok = await confirmAction(ctx.app, tr("Remove shared notes?"), tr("AI assistants will no longer see any notes until they are shared again."), tr("Remove"));
        if (ok) await clearShared(ctx);
      })
    );
};

const clearShared = async (ctx: SettingsContext) => {
  try {
    const errs = await ctx.plugin.publisher.clearPublished(ctx.plugin.settings.mounts);
    new Notice(errs.length ? tr("Some data could not be removed: {errors}", { errors: errs.join("; ") }) : tr("Shared notes removed from the server"));
  } catch (e) {
    new Notice(tr("Could not remove: {error}", { error: errorText(e) }));
  }
};

const choose = async (ctx: SettingsContext, value: Choice) => {
  const { plugin, state } = ctx;
  const s = plugin.settings;
  if (value === "off") {
    if (!s.aiEnabled) return;
    const r = await ask(ctx.app, {
      title: tr("Turn off AI access?"),
      text: tr("This device stops sharing notes. Notes already shared stay on the server until you remove them."),
      actions: [
        { id: "remove", label: tr("Turn off and remove shared notes"), warning: true },
        { id: "off", label: tr("Turn off"), cta: true },
      ],
    });
    if (!r) return;
    s.aiEnabled = false;
    plugin.publisher.stop();
    state.rulesEditorOpen = false;
    await ctx.save();
    if (r === "remove") await clearShared(ctx);
    ctx.refresh();
    return;
  }

  const existing = state.rulesDraft;
  let next: RulesConfig | undefined;
  if (value === "custom") {
    state.rulesEditorOpen = true;
    if (!existing) next = structuredClone(STARTER_RULES);
  } else {
    const preset = value === "ticked" ? STARTER_RULES : STARTER_RULES_ALLOW;
    if (existing && rulesPreset(existing) !== value) {
      const ok = await confirmAction(
        ctx.app,
        tr("Replace the AI rules?"),
        tr("Your current rules will be replaced for all devices of this vault."),
        tr("Replace"),
        false
      );
      if (!ok) return;
    }
    if (!existing || rulesPreset(existing) !== value) next = structuredClone(preset);
    state.rulesEditorOpen = false;
  }
  if (next) {
    await plugin.rules.save(next);
    state.rulesDraft = structuredClone(next);
    state.rulesErrors = [];
    state.rulesDirty = false;
  }
  s.aiEnabled = true;
  await ctx.save();
  plugin.publisher.schedule();
  ctx.refresh();
};

const renderPublishStatus = (ctx: SettingsContext, el: HTMLElement) => {
  const { plugin } = ctx;
  const c = card(el, { icon: "sparkles", title: tr("Sharing with AI"), subtitle: tr("Updates automatically a few seconds after changes.") });
  const status = createDiv();
  const draw = () => {
    status.empty();
    const r = reportText(plugin.publisher.last);
    if (!r) return status.detach();
    if (!status.isConnected) c.body.prepend(status);
    callout(status, r.tone, r.text);
  };
  draw();
  if (c.actions) {
    button(c.actions, {
      text: tr("Update now"),
      icon: "upload-cloud",
      busyText: tr("Updating..."),
      onClick: async () => {
        await plugin.publisher.runNow();
        draw();
      },
    });
    button(c.actions, {
      text: tr("Apply AI edits"),
      icon: "download",
      busyText: tr("Checking..."),
      onClick: async () => {
        const r = await plugin.applier.runNow();
        new Notice(
          r.skipped
            ? tr("Nothing applied: {reason}", { reason: r.skipped })
            : tr("AI edits: {applied} applied, {conflicts} conflicts, {rejected} rejected", { applied: r.applied, conflicts: r.conflicts, rejected: r.rejected })
        );
      },
    });
  }
};

type OpChoice = "ticked" | "unticked" | "exists" | "equals" | "contains";

const opOf = (r: PropertyRule): OpChoice => {
  if (r.op === "equals" && r.value === true) return "ticked";
  if (r.op === "equals" && r.value === false) return "unticked";
  return r.op;
};

const parseValue = (v: string): unknown => {
  const t = v.trim();
  if (t !== "" && !Number.isNaN(Number(t))) return Number(t);
  return t;
};

const renderRulesEditor = (ctx: SettingsContext, el: HTMLElement, draft: RulesConfig) => {
  const { plugin, state } = ctx;
  sectionTitle(el, tr("Custom rules"), tr("A hiding rule always wins over a sharing rule. Attachments are shared when a shared note links to them."));
  for (const e of state.rulesErrors) callout(el, "error", e);

  const box = el.createDiv({ cls: "obsi-ui-rules" });
  const saveBar = el.createDiv({ cls: "obsi-ui-savebar" });
  const markDirty = () => {
    state.rulesDirty = true;
    saveBar.addClass("is-dirty");
  };

  selectField(box, {
    name: tr("Notes that match no rule"),
    options: [
      ["deny_by_default", tr("are hidden from AI")],
      ["allow_by_default", tr("are shared with AI")],
    ],
    value: draft.mode,
    onChange: (v) => {
      draft.mode = v;
      markDirty();
    },
  });

  const listId = "obsi-sync-ai-folder-list";
  const datalist = box.createEl("datalist", { attr: { id: listId } });
  for (const f of plugin.app.vault.getAllLoadedFiles()) {
    if (f instanceof TFolder && !f.isRoot()) datalist.createEl("option", { value: f.path });
  }

  draft.rules.forEach((r, idx) => {
    const row = box.createDiv({ cls: "obsi-ui-rule" });
    const line = row.createDiv({ cls: "obsi-ui-rule-line" });
    const effect = line.createEl("select", { cls: "dropdown" });
    effect.createEl("option", { value: "include", text: tr("Share") });
    effect.createEl("option", { value: "exclude", text: tr("Hide") });
    effect.value = r.effect;
    effect.addEventListener("change", () => {
      r.effect = effect.value === "exclude" ? "exclude" : "include";
      markDirty();
    });

    if (r.type === "folder") {
      const fr = r as FolderRule;
      line.createSpan({ text: tr("notes in folder") });
      const input = line.createEl("input", { type: "text", attr: { list: listId, placeholder: tr("whole vault"), "aria-label": tr("Folder") } });
      input.value = String(fr.path ?? "");
      input.addEventListener("input", () => {
        fr.path = input.value.trim().replace(/^\/+|\/+$/g, "");
        markDirty();
      });
    } else if (r.type === "property") {
      const pr = r as PropertyRule;
      line.createSpan({ text: tr("notes where") });
      const key = line.createEl("input", { type: "text", attr: { placeholder: tr("property"), "aria-label": tr("Property") } });
      key.value = String(pr.key ?? "");
      key.addEventListener("input", () => {
        pr.key = key.value.trim();
        markDirty();
      });
      const op = line.createEl("select", { cls: "dropdown" });
      const ops: Array<[OpChoice, string]> = [
        ["ticked", tr("is ticked")],
        ["unticked", tr("is not ticked")],
        ["exists", tr("exists")],
        ["equals", tr("equals")],
        ["contains", tr("contains")],
      ];
      for (const [v, label] of ops) op.createEl("option", { value: v, text: label });
      op.value = opOf(pr);
      if (op.value === "equals" || op.value === "contains") {
        const value = line.createEl("input", { type: "text", attr: { placeholder: tr("value"), "aria-label": tr("Value") } });
        value.value = pr.value === undefined ? "" : String(pr.value);
        value.addEventListener("input", () => {
          pr.value = parseValue(value.value);
          markDirty();
        });
      }
      op.addEventListener("change", () => {
        const v = op.value as OpChoice;
        if (v === "ticked" || v === "unticked") {
          pr.op = "equals";
          pr.value = v === "ticked";
        } else {
          pr.op = v;
          pr.value = v === "exists" ? undefined : typeof pr.value === "boolean" ? "" : pr.value;
          if (v === "exists") delete pr.value;
        }
        markDirty();
        ctx.refresh();
      });
      if (isCheckboxRule(pr)) {
        const label = row.createEl("label", { cls: "obsi-ui-rule-option" });
        const cb = label.createEl("input", { type: "checkbox" });
        cb.checked = pr.addToNewNotes === true;
        label.appendText(tr("Add the “{key}” checkbox to new notes", { key: pr.key || "…" }));
        cb.addEventListener("change", () => {
          pr.addToNewNotes = cb.checked;
          markDirty();
        });
      }
    } else {
      line.createSpan({ text: tr("Unknown rule type “{type}” (kept as is)", { type: r.type }) });
    }
    const del = line.createEl("button", { cls: "clickable-icon obsi-ui-rule-delete", attr: { "aria-label": tr("Delete rule") } });
    del.type = "button";
    del.setText("✕");
    del.addEventListener("click", () => {
      draft.rules.splice(idx, 1);
      markDirty();
      ctx.refresh();
    });
  });
  if (draft.rules.length === 0) box.createEl("p", { cls: "obsi-ui-muted", text: tr("No rules yet.") });

  const nextId = () => {
    let n = draft.rules.length + 1;
    while (draft.rules.some((r) => r.id === `r${n}`)) n++;
    return `r${n}`;
  };
  const add = buttonRow(box);
  button(add, {
    text: tr("Folder rule"),
    icon: "folder-plus",
    onClick: () => {
      draft.rules.push({ id: nextId(), type: "folder", effect: "include", path: "" } as RuleBase);
      markDirty();
      ctx.refresh();
    },
  });
  button(add, {
    text: tr("Property rule"),
    icon: "tag",
    onClick: () => {
      draft.rules.push({ id: nextId(), type: "property", effect: "exclude", key: "private", op: "equals", value: true, addToNewNotes: true } as RuleBase);
      markDirty();
      ctx.refresh();
    },
  });

  if (state.rulesDirty) saveBar.addClass("is-dirty");
  saveBar.createSpan({ cls: "obsi-ui-savebar-text", text: tr("Unsaved changes") });
  pill(saveBar, tr("Applies to all devices"), "muted");
  saveBar.createDiv({ cls: "obsi-ui-spacer" });
  button(saveBar, {
    text: tr("Discard"),
    onClick: () => {
      state.rulesDraft = undefined;
      state.rulesDirty = false;
      ctx.refresh();
    },
  });
  button(saveBar, {
    text: tr("Save rules"),
    cta: true,
    onClick: async () => {
      await plugin.rules.save(draft);
      state.rulesDirty = false;
      state.rulesDraft = undefined;
      new Notice(tr("AI rules saved"));
      plugin.publisher.schedule();
      ctx.refresh();
    },
  });
};
