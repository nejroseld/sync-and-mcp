import { Notice, Setting } from "obsidian";
import type { TokenInfo } from "../../api/types";
import { t as tr } from "../../i18n";
import { button, buttonRow, callout, confirmAction, errorText, pill, relativeTime } from "../kit";
import type { SettingsContext, SettingsState } from "./context";

/**
 * The account behind this device's token, loaded once per token. Renders the loading or error
 * state into `parent` and returns the state only when it is known.
 */
export const loadedAccount = (ctx: SettingsContext, parent: HTMLElement): SettingsState["account"] | undefined => {
  const { plugin, state } = ctx;
  const current = plugin.settings.deviceToken;
  if (state.account.token !== current) state.account = { loaded: false, loading: false, token: current, accountToken: false, tokens: [] };
  const acc = state.account;
  if (acc.loaded) return acc;
  if (acc.error) {
    callout(parent, "error", tr("Could not load your account: {error}", { error: acc.error }));
    button(buttonRow(parent), { text: tr("Retry"), busyText: tr("Loading..."), onClick: () => loadAccount(ctx) });
  } else {
    parent.createEl("p", { cls: "obsi-ui-muted", text: tr("Loading...") });
    if (!acc.loading) void loadAccount(ctx);
  }
  return undefined;
};

const loadAccount = async (ctx: SettingsContext) => {
  const { plugin, state } = ctx;
  const acc = state.account;
  const api = plugin.getApi();
  if (!api || acc.loading) return;
  acc.loading = true;
  try {
    const me = await api.me();
    const accountToken = me.account_token === true;
    const [tokens, vaults] = accountToken ? await Promise.all([api.listOwnTokens(), api.listVaults()]) : [[], undefined];
    plugin.me = me;
    if (vaults) plugin.vaults = vaults;
    Object.assign(acc, { accountToken, username: me.user?.username, userId: me.user?.id, tokenId: me.token_id, tokens, loaded: true, error: undefined });
  } catch (e) {
    acc.error = errorText(e);
  } finally {
    acc.loading = false;
  }
  // a reply for a token that was replaced meanwhile is dropped with the old state object
  if (state.account === acc) ctx.refresh();
};

export const reloadTokens = async (ctx: SettingsContext) => {
  const api = ctx.plugin.getApi();
  if (!api) return;
  ctx.state.account.tokens = await api.listOwnTokens();
  ctx.refresh();
};

/** Vaults this account owns: the only ones its tokens can be given access to. */
export const ownedVaults = (ctx: SettingsContext) =>
  ctx.plugin.vaults.filter((v) => v.owner_user_id && v.owner_user_id === ctx.state.account.userId);

export const vaultNames = (ctx: SettingsContext, t: TokenInfo) =>
  Object.keys(t.grants ?? {}).map((vid) => ctx.plugin.vaults.find((v) => v.id === vid)?.name ?? vid).join(", ");

/** One row per active token, newest first; the token of this device can't be revoked from here. */
export const tokenList = (ctx: SettingsContext, parent: HTMLElement, tokens: TokenInfo[], o: { describe: (t: TokenInfo) => string; empty: string }) => {
  const list = parent.createDiv({ cls: "obsi-ui-list" });
  const active = tokens.filter((t) => !t.revoked_at).sort((x, y) => y.created_at - x.created_at);
  for (const t of active) {
    const row = new Setting(list).setName(t.is_session ? tr("Signed in with password") : t.name).setDesc(o.describe(t));
    if (t.id === ctx.state.account.tokenId) {
      row.nameEl.createSpan({ text: " " });
      pill(row.nameEl, tr("this device"), "success");
      continue;
    }
    row.addButton((b) =>
      b.setButtonText(tr("Disconnect")).setWarning().onClick(async () => {
        const name = t.is_session ? tr("Signed in with password") : t.name;
        const ok = await confirmAction(ctx.app, tr("Disconnect “{name}”?", { name }), tr("It loses access to your vaults immediately. Notes already on it stay there. This can't be undone."), tr("Disconnect"));
        if (!ok) return;
        try {
          await ctx.plugin.getApi()!.revokeOwnToken(t.id);
          await reloadTokens(ctx);
        } catch (e) {
          new Notice(tr("Failed: {error}", { error: errorText(e) }));
        }
      })
    );
  }
  if (!active.length) list.createEl("p", { cls: "obsi-ui-muted", text: o.empty });
};

export const lastUsed = (t: TokenInfo) => tr("last used {time}", { time: relativeTime(t.last_used_at ?? undefined) });
