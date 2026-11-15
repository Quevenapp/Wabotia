// Observação da revisão de segurança: o endereço público seguia a última
// origem vista numa requisição de pessoa. Aberto o painel por dois nomes
// (workers.dev e o domínio próprio), os links aos clientes e o
// notification_url do Mercado Pago mudavam de nome. Agora fica fixo.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { exec, one } from "../src/db";
import { api, bearer, fixture } from "./service-center-fixture";

const origin = async () =>
  (
    await one(
      env,
      "SELECT value FROM instance_settings WHERE key='public_origin'",
    )
  )?.value;

describe("endereço público fixo (observação da revisão)", () => {
  it("a primeira origem vira o padrão; outro nome não muda; o administrador troca", async () => {
    await exec(env, "DELETE FROM instance_settings WHERE key='public_origin'");
    const f = await fixture();
    const token = await bearer(f.admin);
    const me = (host: string) =>
      SELF.fetch(`https://${host}/api/v1/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    expect((await me("atendimento.exemplo.com.br")).status).toBe(200);
    expect(await origin()).toBe("https://atendimento.exemplo.com.br");
    expect((await me("wabotia.conta.workers.dev")).status).toBe(200);
    expect(await origin()).toBe("https://atendimento.exemplo.com.br");
    // O administrador fixa outro endereço.
    const saved = await api(token, "/system/origin/configure", "POST", {
      public_origin: "https://novo.exemplo.com.br",
    });
    expect(saved.status).toBe(200);
    expect(await origin()).toBe("https://novo.exemplo.com.br");
    const system = await (await api(token, "/system")).json<any>();
    expect(system.public_origin).toBe("https://novo.exemplo.com.br");
    // Endereço com caminho ou sem HTTPS é recusado; operador não troca.
    for (const value of ["https://x.com/painel", "http://x.com", "lixo"])
      expect(
        (
          await api(token, "/system/origin/configure", "POST", {
            public_origin: value,
          })
        ).status,
        value,
      ).toBe(400);
    expect(
      (
        await api(await bearer(f.member), "/system/origin/configure", "POST", {
          public_origin: "https://outro.exemplo.com.br",
        })
      ).status,
    ).toBe(403);
    expect(await origin()).toBe("https://novo.exemplo.com.br");
  });
});
