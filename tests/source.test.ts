// AGPL-3.0, §13: o código-fonte do commit em execução fica ao alcance de quem
// usa o Vinki pela rede (health, capacidades, páginas do cliente).
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildInfo } from "../src/build-info.generated";
import { OFFICIAL_SOURCE, sourceInfo } from "../src/source";
import { page, statePage } from "../src/web-steps";
import { capabilities } from "../src/modules/capabilities";
import { fixture } from "./service-center-fixture";

const known = /^[a-f0-9]{40}$/.test(buildInfo.commit);

describe("código-fonte do commit em execução", () => {
  it("aponta para o repositório oficial no commit em execução", () => {
    const info = sourceInfo({});
    expect(info.repository).toBe(OFFICIAL_SOURCE);
    expect(info.license).toBe("AGPL-3.0");
    expect(info.commit).toBe(buildInfo.commit);
    expect(info.url).toBe(
      known ? `${OFFICIAL_SOURCE}/tree/${buildInfo.commit}` : OFFICIAL_SOURCE,
    );
  });

  it("WABOTIA_SOURCE_URL troca o repositório; endereço inválido cai no oficial", () => {
    const fork = sourceInfo({
      WABOTIA_SOURCE_URL: "https://git.example.com/eu/wabotia/",
    });
    expect(fork.repository).toBe("https://git.example.com/eu/wabotia");
    if (known)
      expect(fork.url).toBe(
        `https://git.example.com/eu/wabotia/tree/${buildInfo.commit}`,
      );
    const template = sourceInfo({
      WABOTIA_SOURCE_URL: "https://code.example.com/wabotia/src/{commit}",
    });
    if (known)
      expect(template.url).toBe(
        `https://code.example.com/wabotia/src/${buildInfo.commit}`,
      );
    for (const bad of [
      "http://inseguro.example.com",
      "javascript:alert(1)",
      "https://user:pass@example.com/x",
      "nada",
      "",
    ])
      expect(sourceInfo({ WABOTIA_SOURCE_URL: bad }).repository).toBe(
        OFFICIAL_SOURCE,
      );
  });

  it("/api/health e a página de passo web levam o link", async () => {
    const health: any = await (await SELF.fetch("https://test/api/health")).json();
    expect(health.source).toEqual(sourceInfo(env as any));
    const notFound = await SELF.fetch("https://test/api/w/AAAAAAAAAAAAAAAA");
    const html = await notFound.text();
    expect(html).toContain(`href="${sourceInfo(env as any).url}"`);
    expect(html).toContain("Código-fonte (AGPL-3.0)");
  });

  it("/api/v1/capabilities leva o código-fonte", async () => {
    const f = await fixture();
    const result: any = await capabilities(env as any, f.admin);
    expect(result.source).toEqual(sourceInfo(env as any));
  });

  it("toda página do cliente (passo web, carrinho, estados) tem o rodapé", () => {
    const custom = "https://git.example.com/eu/wabotia/tree/abc";
    expect(page("t", "<p>x</p>", { app: "W", source: custom })).toContain(
      `href="${custom}"`,
    );
    expect(statePage("expired", "Vinki")).toContain(sourceInfo().url);
  });
});
