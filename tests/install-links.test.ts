import { it, expect } from "vitest";
import {
  installTokenUrl,
  setupLink,
  setupTokenFromHash,
} from "../src/install-links";

it("abre o formulário de token da Cloudflare com as três permissões da instalação", () => {
  const url = new URL(installTokenUrl);
  expect(url.origin + url.pathname).toBe(
    "https://dash.cloudflare.com/profile/api-tokens",
  );
  expect(JSON.parse(url.searchParams.get("permissionGroupKeys")!)).toEqual([
    { key: "workers_scripts", type: "edit" },
    { key: "d1", type: "edit" },
    { key: "workers_r2", type: "edit" },
  ]);
  expect(url.searchParams.get("name")).toBe("Wabotia instalação");
});

it("leva o código de instalação no fragmento e só aceita o formato do instalador", () => {
  const token = "ab12".repeat(16);
  const link = setupLink("https://meu.workers.dev", token);
  expect(link).toBe(`https://meu.workers.dev/app#setup=${token}`);
  // O código não vai na parte da URL enviada ao servidor.
  const url = new URL(link);
  expect(url.search).toBe("");
  expect(url.pathname).toBe("/app");
  expect(setupTokenFromHash(url.hash)).toBe(token);
  for (const hash of [
    "",
    "#setup=",
    "#setup=curto",
    "#setup=" + "g".repeat(64),
    "#outra=" + token,
    "#setup=" + token + "&x=1",
  ])
    expect(setupTokenFromHash(hash)).toBe("");
});
