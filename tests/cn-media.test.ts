import { env } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { all, exec } from "../src/db";
import { defaults, now, uid } from "../src/types";
import type { SocialEventScope, SocialInboundMedia } from "../src/channel-contracts";
import { copySocialMedia, socialMediaId, socialMediaUrl } from "../src/zernio-social-media";
import { zernioInbound } from "../src/zernio";

let unexpectedNetwork = 0;
beforeEach(() => {
  unexpectedNetwork = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => { unexpectedNetwork++; throw new Error("Rede inesperada no teste."); });
});
afterEach(() => { vi.restoreAllMocks(); expect(unexpectedNetwork).toBe(0); });

async function seed(): Promise<SocialEventScope> {
  const profileId = uid();
  await exec(env, "INSERT INTO profiles(id,name,settings,created) VALUES(?,?,?,?)", profileId, "Mídia social", JSON.stringify(defaults), now());
  return { profileId, integrationId: uid(), connectionId: uid(), channel: "instagram", accountId: "account", providerProfileId: null };
}
// URLs sintéticas do formato do anexo; a conferir com a conta real.
const attachment: SocialInboundMedia = { kind: "image", mimeType: "image/png", name: "Foto.png", sourceUrl: "https://scontent.xx.fbcdn.net/photo.png?expires=1", providerMediaId: "remote-media" };

it("autoriza somente HTTPS e sufixos delimitados, sem credenciais na URL", () => {
  expect(socialMediaUrl(attachment.sourceUrl!).hostname).toBe("scontent.xx.fbcdn.net");
  for (const url of ["http://scontent.xx.fbcdn.net/photo", "https://fbcdn.net.evil.example/photo", "https://evilfbcdn.net/photo", "https://user:password@fbcdn.net/photo", "https://fbcdn.net:8443/photo", "https://127.0.0.1/photo", "https://fbcdn.net/photo?access_token=secret"])
    expect(() => socialMediaUrl(url)).toThrow();
  expect(socialMediaUrl("https://media.example/file", { exactOrigins: ["https://media.example"], hostSuffixes: [] }).origin).toBe("https://media.example");
  expect(fetch).not.toHaveBeenCalled();
});

it("copia CDN sem Authorization e reutiliza ID determinístico sem baixar novamente", async () => {
  const scope = await seed();
  const fetcher = vi.fn<typeof fetch>(async () =>
    new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/png", "Content-Length": "3" } }));
  const first = await copySocialMedia(env, scope, "message", [attachment], { fetcher });
  expect(first).toEqual({ attachments: [await socialMediaId(scope.connectionId, "message", 0)], unavailable: false });
  // Fora do mock: falhas de asserção não podem virar "anexo indisponível".
  const [url, init] = fetcher.mock.calls[0];
  const request = new Request(url, init);
  expect(request.url).toBe(attachment.sourceUrl);
  expect(request.headers.get("Authorization")).toBe(null);
  // O Request do Worker não expõe credentials/referrerPolicy; conferir o envio.
  expect(init?.credentials).toBe("omit");
  expect(init?.referrerPolicy).toBe("no-referrer");
  expect(request.redirect).toBe("manual");
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  expect(request.signal).toBeDefined();
  expect(await copySocialMedia(env, scope, "message", [attachment], { fetcher })).toEqual(first);
  expect(fetcher).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
  const rows = await all(env, "SELECT * FROM media WHERE profile_id=?", scope.profileId);
  expect(rows).toHaveLength(1); expect(JSON.stringify(rows)).not.toContain("fbcdn.net");
});

it("cópias concorrentes conservam um registro determinístico", async () => {
  const scope = await seed();
  const fetcher = vi.fn(async () => new Response(new Uint8Array([1]), { headers: { "Content-Type": "image/png" } }));
  const [first, second] = await Promise.all([
    copySocialMedia(env, scope, "same-message", [attachment], { fetcher }),
    copySocialMedia(env, scope, "same-message", [attachment], { fetcher }),
  ]);
  expect(first).toEqual(second); expect(first.unavailable).toBe(false);
  expect(await all(env, "SELECT id FROM media WHERE profile_id=?", scope.profileId)).toHaveLength(1);
});

it("falha e redirecionamento não salvam URL temporária e renovação é desligada por padrão", async () => {
  const scope = await seed(), renew = vi.fn(async () => "https://fbcdn.net/renewed");
  const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { Location: "https://evil.example/credential" } }));
  expect(await copySocialMedia(env, scope, "redirect", [attachment], { fetcher, renewal: { enabled: false, renew } })).toEqual({ attachments: [], unavailable: true });
  expect(fetcher).toHaveBeenCalledTimes(1); expect(renew).not.toHaveBeenCalled();
  expect(await all(env, "SELECT id FROM media WHERE profile_id=?", scope.profileId)).toEqual([]);
});

it("falha de download permite recuperação com o mesmo ID sem marcar recebimento", async () => {
  const scope = await seed();
  const fetcher = vi.fn().mockRejectedValueOnce(new Error("download indisponível"))
    .mockResolvedValueOnce(new Response(new Uint8Array([4, 5]), { headers: { "Content-Type": "image/png" } }));
  expect(await copySocialMedia(env, scope, "retry", [attachment], { fetcher })).toEqual({ attachments: [], unavailable: true });
  expect(await copySocialMedia(env, scope, "retry", [attachment], { fetcher })).toEqual({ attachments: [await socialMediaId(scope.connectionId, "retry", 0)], unavailable: false });
  expect(await all(env, "SELECT id FROM inbox WHERE profile_id=?", scope.profileId)).toEqual([]);
});

it("recusa tamanho, MIME, URL e prazo inválidos sem arquivo permanente", async () => {
  const scope = await seed();
  for (const response of [
    new Response(new Uint8Array([1]), { headers: { "Content-Type": "text/html" } }),
    new Response(new Uint8Array([1]), { headers: { "Content-Type": "image/png", "Content-Length": String(3 * 1024 * 1024 + 1) } }),
    new Response(new Uint8Array([1]), { headers: { "Content-Type": "image/png", "Content-Length": "2" } }),
  ]) expect((await copySocialMedia(env, scope, uid(), [attachment], { fetcher: vi.fn(async () => response) })).unavailable).toBe(true);
  const fetcher = vi.fn(async () => new Response());
  expect((await copySocialMedia(env, scope, "expired", [attachment], { deadline: Date.now() - 1, fetcher })).unavailable).toBe(true);
  expect((await copySocialMedia(env, scope, "evil", [{ ...attachment, sourceUrl: "https://evil.example/a" }], { fetcher })).unavailable).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
  expect(await all(env, "SELECT id FROM media WHERE profile_id=?", scope.profileId)).toEqual([]);
});

it("só WhatsApp mantém seu teste de webhook sem copiador social ou rede", async () => {
  const connection = { id: "wa", profile_id: "wa-profile", kind: "zernio", config: "{}" };
  const dispatch = vi.fn();
  expect(await (await zernioInbound(env, connection, { event: "webhook.test" }, dispatch)).json()).toEqual({ received: true, test: true });
  expect(dispatch).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
