import { type App, type EventRef, TAbstractFile, TFile } from "obsidian";
import { newNoteProperties } from "./rules";
import type { RulesStore } from "./rulesStore";

/** Internal Obsidian API, absent from the public types. */
type AppWithPropertyTypes = App & {
  metadataTypeManager?: { setType?: (key: string, type: string) => void };
};

/**
 * Puts the "add to new notes" checkbox properties of the AI rules into freshly created notes,
 * so the user can tick them right away. Only touches notes that are still empty when created.
 */
export const registerNewNoteProps = (app: App, rules: RulesStore, register: (ref: EventRef) => void) => {
  const typed = new Set<string>();
  register(
    app.vault.on("create", (f: TAbstractFile) => {
      if (!(f instanceof TFile) || f.extension !== "md" || f.stat.size !== 0) return;
      // let templates / "new note" commands finish writing first
      window.setTimeout(() => {
        void (async () => {
          const parsed = await rules.load(false);
          if (!parsed || parsed.errors.length > 0) return;
          const props = newNoteProperties(parsed.config);
          const keys = Object.keys(props);
          if (keys.length === 0 || app.vault.getAbstractFileByPath(f.path) !== f) return;
          const types = (app as AppWithPropertyTypes).metadataTypeManager;
          for (const k of keys) {
            if (typed.has(k)) continue;
            typed.add(k);
            try {
              // internal API: show the property as a checkbox in the Properties view
              types?.setType?.(k, "checkbox");
            } catch (err) {
              // A missing internal API must not block writing frontmatter.
              console.debug("sync-and-mcp: new note properties", err);
            }
          }
          await app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) => {
            for (const k of keys) if (!(k in fm)) fm[k] = props[k];
          });
        })().catch((err) => {
          console.debug("sync-and-mcp: new note properties", err);
        });
      }, 300);
    })
  );
};
