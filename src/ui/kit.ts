import { type App, ButtonComponent, Modal, Notice, Setting, setIcon } from "obsidian";
import { currentLanguage, t as tr } from "../i18n";

/** Small shared UI vocabulary of the plugin: the welcome window and settings are built from it. */

export type Tone = "info" | "warning" | "error" | "success" | "muted";

export const icon = (parent: HTMLElement, name: string, cls = "obsi-ui-icon") => {
  const el = parent.createSpan({ cls });
  setIcon(el, name);
  return el;
};

const TONE_ICON: Record<Tone, string> = {
  info: "info",
  warning: "alert-triangle",
  error: "alert-circle",
  success: "check-circle",
  muted: "info",
};

export const callout = (parent: HTMLElement, tone: Tone, text: string | DocumentFragment, iconName?: string) => {
  const el = parent.createDiv({ cls: `obsi-ui-callout is-${tone}` });
  if (tone === "error") el.setAttribute("role", "alert");
  icon(el, iconName ?? TONE_ICON[tone], "obsi-ui-callout-icon");
  const body = el.createDiv({ cls: "obsi-ui-callout-body" });
  if (typeof text === "string") body.setText(text);
  else body.appendChild(text);
  return el;
};

export const pill = (parent: HTMLElement, text: string, tone: Tone = "muted") =>
  parent.createSpan({ cls: `obsi-ui-pill is-${tone}`, text });

/** A large clickable option; with `selected` it behaves as a radio button inside a radiogroup. */
export const choiceCard = (
  parent: HTMLElement,
  o: { icon: string; title: string; desc?: string; selected?: boolean; badge?: string; onClick: () => void }
) => {
  const radio = o.selected !== undefined;
  const el = parent.createEl("button", { cls: "obsi-ui-choice" });
  el.type = "button";
  if (radio) {
    el.setAttribute("role", "radio");
    el.setAttribute("aria-checked", String(o.selected));
    el.toggleClass("is-selected", !!o.selected);
  }
  icon(el, o.icon, "obsi-ui-choice-icon");
  const text = el.createSpan({ cls: "obsi-ui-choice-text" });
  const title = text.createSpan({ cls: "obsi-ui-choice-title", text: o.title });
  if (o.badge) pill(title, o.badge, "info");
  if (o.desc) text.createSpan({ cls: "obsi-ui-choice-desc", text: o.desc });
  if (radio) el.createSpan({ cls: "obsi-ui-choice-check" });
  else icon(el, "chevron-right", "obsi-ui-choice-chevron");
  el.addEventListener("click", o.onClick);
  return el;
};

export const choiceGroup = (parent: HTMLElement, label: string) =>
  parent.createDiv({ cls: "obsi-ui-choices", attr: { role: "radiogroup", "aria-label": label } });

/** Text field as a Setting row; `secret` adds a show/hide button. */
export const textField = (
  parent: HTMLElement,
  o: {
    name: string;
    desc?: string;
    value: string;
    placeholder?: string;
    secret?: boolean;
    list?: string;
    onChange: (v: string) => void;
  }
) => {
  let input!: HTMLInputElement;
  const setting = new Setting(parent).setName(o.name).addText((t) => {
    input = t.inputEl;
    t.setPlaceholder(o.placeholder ?? "").setValue(o.value).onChange(o.onChange);
    input.setAttribute("autocomplete", "off");
    input.setAttribute("spellcheck", "false");
    if (o.secret) input.type = "password";
    if (o.list) input.setAttribute("list", o.list);
  });
  setting.settingEl.addClass("obsi-ui-field");
  if (o.desc) setting.setDesc(o.desc);
  if (o.secret) {
    setting.addExtraButton((b) => {
      b.setIcon("eye").setTooltip(tr("Show")).onClick(() => {
        const hidden = input.type === "password";
        input.type = hidden ? "text" : "password";
        b.setIcon(hidden ? "eye-off" : "eye").setTooltip(tr(hidden ? "Hide" : "Show"));
      });
    });
  }
  return { setting, input };
};

/** Dropdown row with fixed choices; an unknown current value is kept as an extra option. */
export const selectField = <T extends string | number>(
  parent: HTMLElement,
  o: { name: string; desc?: string; options: Array<[T, string]>; value: T; onChange: (v: T) => void }
) => {
  const setting = new Setting(parent).setName(o.name).addDropdown((d) => {
    const options = [...o.options];
    if (!options.some(([v]) => v === o.value)) options.push([o.value, String(o.value)]);
    for (const [v, label] of options) d.addOption(String(v), label);
    d.setValue(String(o.value)).onChange((raw) => {
      const hit = options.find(([v]) => String(v) === raw);
      if (hit) o.onChange(hit[0]);
    });
  });
  if (o.desc) setting.setDesc(o.desc);
  return setting;
};

export const toggleField = (parent: HTMLElement, o: { name: string; desc?: string; value: boolean; onChange: (v: boolean) => void }) => {
  const setting = new Setting(parent).setName(o.name).addToggle((t) => t.setValue(o.value).onChange(o.onChange));
  if (o.desc) setting.setDesc(o.desc);
  return setting;
};

/** Bordered card with a header (icon, title, subtitle, actions) and a body. */
export const card = (parent: HTMLElement, o: { icon?: string; title?: string; subtitle?: string; tone?: Tone; cls?: string } = {}) => {
  const el = parent.createDiv({ cls: `obsi-ui-card${o.tone ? ` is-${o.tone}` : ""}${o.cls ? ` ${o.cls}` : ""}` });
  let head: HTMLElement | undefined;
  let actions: HTMLElement | undefined;
  let titleEl: HTMLElement | undefined;
  let subtitleEl: HTMLElement | undefined;
  if (o.title !== undefined) {
    head = el.createDiv({ cls: "obsi-ui-card-head" });
    if (o.icon) icon(head, o.icon, "obsi-ui-card-icon");
    const text = head.createDiv({ cls: "obsi-ui-card-heading" });
    titleEl = text.createDiv({ cls: "obsi-ui-card-title", text: o.title });
    if (o.subtitle !== undefined) subtitleEl = text.createDiv({ cls: "obsi-ui-card-subtitle", text: o.subtitle });
    actions = head.createDiv({ cls: "obsi-ui-card-actions" });
  }
  const body = el.createDiv({ cls: "obsi-ui-card-body" });
  return { el, head, actions, body, titleEl, subtitleEl };
};

export const sectionTitle = (parent: HTMLElement, title: string, desc?: string) => {
  const el = parent.createDiv({ cls: "obsi-ui-section" });
  el.createDiv({ cls: "obsi-ui-section-title", text: title });
  if (desc) el.createDiv({ cls: "obsi-ui-section-desc", text: desc });
  return el;
};

/** Collapsible block for rarely used options. */
export const details = (parent: HTMLElement, title: string, open = false) => {
  const el = parent.createEl("details", { cls: "obsi-ui-details" });
  el.open = open;
  const summary = el.createEl("summary");
  icon(summary, "chevron-right", "obsi-ui-details-chevron");
  summary.createSpan({ text: title });
  return el.createDiv({ cls: "obsi-ui-details-body" });
};

export const button = (
  parent: HTMLElement,
  o: { text: string; icon?: string; cta?: boolean; warning?: boolean; busyText?: string; onClick: () => unknown }
) => {
  const b = new ButtonComponent(parent);
  if (o.icon) {
    b.buttonEl.addClass("obsi-ui-button-icon");
    icon(b.buttonEl, o.icon);
    b.buttonEl.createSpan({ text: o.text });
  } else {
    b.setButtonText(o.text);
  }
  if (o.cta) b.setCta();
  if (o.warning) b.setWarning();
  let busy = false;
  b.onClick(async () => {
    if (busy) return;
    busy = true;
    b.setDisabled(true);
    const label = b.buttonEl.lastElementChild instanceof HTMLSpanElement ? b.buttonEl.lastElementChild : b.buttonEl;
    const original = label.textContent ?? "";
    if (o.busyText) label.textContent = o.busyText;
    try {
      await o.onClick();
    } finally {
      busy = false;
      if (b.buttonEl.isConnected) {
        b.setDisabled(false);
        label.textContent = original;
      }
    }
  });
  return b;
};

export const buttonRow = (parent: HTMLElement) => parent.createDiv({ cls: "obsi-ui-buttons" });

/** "3 minutes ago" in the interface language. */
export const relativeTime = (ts: number | undefined, now = Date.now()): string => {
  if (!ts) return tr("never");
  const seconds = Math.round((ts - now) / 1000);
  const fmt = new Intl.RelativeTimeFormat(currentLanguage(), { numeric: "auto" });
  const abs = Math.abs(seconds);
  if (abs < 45) return tr("just now");
  if (abs < 3600) return fmt.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return fmt.format(Math.round(seconds / 3600), "hour");
  return fmt.format(Math.round(seconds / 86400), "day");
};

export const errorText = (e: unknown) => String(e instanceof Error ? e.message : e);

export const copyToClipboard = async (text: string, done: string) => {
  try {
    await navigator.clipboard.writeText(text);
    new Notice(done);
  } catch (e) {
    new Notice(tr("Could not copy: {error}", { error: errorText(e) }));
  }
};

/**
 * Confirmation dialog. Resolves with the id of the chosen action, or null when dismissed.
 * The last action is the primary one.
 */
export const ask = (
  app: App,
  o: { title: string; text: string; actions: Array<{ id: string; label: string; warning?: boolean; cta?: boolean }> }
): Promise<string | null> =>
  new Promise((resolve) => {
    let result: string | null = null;
    const modal = new (class extends Modal {
      onOpen() {
        this.modalEl.addClass("obsi-ui-dialog");
        this.titleEl.setText(o.title);
        this.contentEl.createEl("p", { cls: "obsi-ui-dialog-text", text: o.text });
        const row = this.contentEl.createDiv({ cls: "obsi-ui-dialog-buttons" });
        new ButtonComponent(row).setButtonText(tr("Cancel")).onClick(() => this.close());
        for (const a of o.actions) {
          const b = new ButtonComponent(row).setButtonText(a.label).onClick(() => {
            result = a.id;
            this.close();
          });
          if (a.warning) b.setWarning();
          if (a.cta) b.setCta();
        }
      }
      onClose() {
        this.contentEl.empty();
        resolve(result);
      }
    })(app);
    modal.open();
  });

export const confirmAction = async (app: App, title: string, text: string, label: string, warning = true) =>
  (await ask(app, { title, text, actions: [{ id: "ok", label, warning, cta: !warning }] })) === "ok";
