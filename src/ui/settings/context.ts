import type { App } from "obsidian";
import type { RulesConfig } from "../../ai/rules";
import type { InviteInfo, TokenInfo } from "../../api/types";
import type ObsiSyncPlugin from "../../main";

export type SectionId = "overview" | "sync" | "folders" | "devices" | "ai" | "server" | "dev";

/** Drafts and loaded data that must survive re-rendering the settings page. */
export interface SettingsState {
  /** undefined = not loaded yet, null = no rules file */
  rulesDraft: RulesConfig | null | undefined;
  rulesErrors: string[];
  rulesDirty: boolean;
  /** the custom rules editor is shown even while the rules still match a preset */
  rulesEditorOpen: boolean;
  /** mount index whose editor is open */
  editingMount: number | undefined;
  connectionEditing: boolean;
  qrVisible: boolean;
  admin: {
    loaded: boolean;
    loading: boolean;
    tokens: TokenInfo[];
    invites: InviteInfo[];
    embedding: { base_url: string; api_key: string; model: string };
    index?: { chunks?: number; embedded?: number; pending?: number; last_error?: string | null };
    error?: string;
  };
  devClicks: number;
  devUnlocked: boolean;
}

export const initialState = (): SettingsState => ({
  rulesDraft: undefined,
  rulesErrors: [],
  rulesDirty: false,
  rulesEditorOpen: false,
  editingMount: undefined,
  connectionEditing: false,
  qrVisible: false,
  admin: { loaded: false, loading: false, tokens: [], invites: [], embedding: { base_url: "", api_key: "", model: "" } },
  devClicks: 0,
  devUnlocked: false,
});

export interface SettingsContext {
  app: App;
  plugin: ObsiSyncPlugin;
  state: SettingsState;
  /** persist settings and refresh the status bar */
  save(): Promise<void>;
  /** re-render the whole page (keeps the current section) */
  refresh(): void;
  go(section: SectionId): void;
  /** register cleanup for when the page is hidden or re-rendered */
  onCleanup(fn: () => void): void;
}
