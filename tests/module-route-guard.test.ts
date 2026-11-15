// Revisão de segurança B5: a rota de módulo respondia 409 module_disabled
// (ou 404 de módulo) a credencial de outra área, revelando os módulos que a
// área usa, e "%" malformado no caminho dava erro interno.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { perform } from "../src/service";
import { uid } from "../src/types";
import { api, bearer, fixture } from "./service-center-fixture";
import { application } from "./service-center-fixture";

describe("rota de módulo confere a área antes do módulo (revisão B5)", () => {
  it("credencial de outra área recebe o mesmo 404, ligado ou desligado", async () => {
    const mine = await fixture();
    const other = await fixture();
    await perform(
      env,
      other.admin,
      other.profile,
      "module.set",
      { id: "agenda", enabled: true },
      uid(),
    );
    const key = (await application(mine, ["conversations:read"])).token;
    const on = await api(key, `/profiles/${other.profile}/agenda`);
    const off = await api(key, `/profiles/${other.profile}/reserva`);
    expect(on.status).toBe(404);
    expect(off.status).toBe(404);
    expect((await on.json<any>()).error.code).toBe("not_found");
    expect((await off.json<any>()).error.code).toBe("not_found");
    // Na própria área, desligado continua 409 module_disabled.
    const own = await api(key, `/profiles/${mine.profile}/reserva`);
    expect(own.status).toBe(409);
  });

  it("'%' malformado no caminho é 404, não erro interno", async () => {
    const f = await fixture();
    const response = await api(
      await bearer(f.admin),
      "/profiles/%E0%A4%A/agenda",
    );
    expect(response.status).toBe(404);
  });
});
