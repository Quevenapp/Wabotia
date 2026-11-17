// Links that shorten the installation, shared by the installer, the site and
// the panel. No imports: this file is bundled into all three.

/** Permissions of the installation token, as Cloudflare's template URL names them. */
export const installTokenPermissions = [
  { key: "workers_scripts", type: "edit" },
  { key: "d1", type: "edit" },
  { key: "workers_r2", type: "edit" },
] as const;

/**
 * Opens Cloudflare's "create token" form with the name and the three
 * permissions already filled in. The person still chooses the account, reviews
 * and creates the token there.
 * https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/
 */
export const installTokenUrl =
  "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=" +
  encodeURIComponent(JSON.stringify(installTokenPermissions)) +
  "&accountId=*&zoneId=all&name=" +
  encodeURIComponent("Wabotia instalação");

const setupPrefix = "#setup=";
const setupShape = /^[a-f0-9]{64}$/;

/**
 * First-access link printed by the installer. The code travels in the URL
 * fragment, which browsers do not send to the server or record in its logs.
 */
export const setupLink = (origin: string, setupToken: string) =>
  `${origin}/app${setupPrefix}${setupToken}`;

/** The installation code carried by a first-access link, or "" when absent. */
export function setupTokenFromHash(hash: string) {
  const value = hash.startsWith(setupPrefix)
    ? hash.slice(setupPrefix.length)
    : "";
  return setupShape.test(value) ? value : "";
}

/**
 * Links de uso único gerados pelo administrador (src/auth-tokens.ts): redefinir
 * a senha (#reset=) e aceitar o convite (#invite=). O código vai no fragmento,
 * que o navegador não manda ao servidor nem grava nos registros.
 */
export type AccountLinkPurpose = "reset" | "invite";
export const accountLink = (
  origin: string,
  purpose: AccountLinkPurpose,
  token: string,
) => `${origin}/app#${purpose}=${token}`;

/** {purpose, token} de um link de conta no fragmento, ou null. */
export function accountTokenFromHash(hash: string) {
  const match = /^#(reset|invite)=([a-f0-9]{64})$/.exec(hash);
  return match
    ? { purpose: match[1] as AccountLinkPurpose, token: match[2] }
    : null;
}
