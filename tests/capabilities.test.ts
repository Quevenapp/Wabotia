import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { perform } from "../src/service";
import { uid } from "../src/types";
import { buildInfo } from "../src/build-info.generated";
import { openapi } from "../src/openapi";
import { api, application, bearer, fixture } from "./service-center-fixture";

const read = async (token: string, query = "") => {
  const response = await api(token, "/capabilities" + query);
  return { status: response.status, body: await response.json<any>() };
};

describe("GET /api/v1/capabilities", () => {
  it("pessoa vê a versão do servidor e os módulos ligados das suas áreas", async () => {
    const f = await fixture();
    const other = await fixture();
    const { status, body } = await read(await bearer(f.member));
    expect(status).toBe(200);
    expect(body.capabilities_version).toBe(1);
    expect(body.server).toMatchObject({
      service: "wabotia",
      version: buildInfo.version,
    });
    expect(body.features).toContain("modules");
    expect(body.actor).toMatchObject({ id: f.member.id, kind: "user" });
    const ids = body.profiles.map((p: any) => p.id);
    expect(ids).toContain(f.profile);
    expect(ids).not.toContain(other.profile);
    const area = body.profiles.find((p: any) => p.id === f.profile);
    expect(area.modules).toContainEqual({
      id: "queue",
      name: "Fila presencial",
      version: "1.0.0",
    });
  });

  it("aparelho pareado (chave de aplicação) lê só a área da chave", async () => {
    const f = await fixture();
    await fixture();
    const device = await application(f, ["queue:read", "queue:issue"]);
    const { status, body } = await read(device.token);
    expect(status).toBe(200);
    expect(body.actor).toMatchObject({ kind: "app", role: "service" });
    expect(body.profiles.map((p: any) => p.id)).toEqual([f.profile]);
    // Mesmo sem nenhuma permissão a rota responde: ela não expõe dados.
    const bare = await application(f, []);
    expect((await read(bare.token)).status).toBe(200);
  });

  it("módulo desligado sai da lista; profile filtra e recusa área alheia", async () => {
    const f = await fixture();
    const other = await fixture();
    await perform(
      env,
      f.admin,
      f.profile,
      "module.set",
      { id: "queue", enabled: false },
      uid(),
    );
    const token = await bearer(f.member);
    const { body } = await read(token, "?profile=" + f.profile);
    expect(body.profiles).toHaveLength(1);
    expect(body.profiles[0].modules.map((m: any) => m.id)).not.toContain(
      "queue",
    );
    expect((await read(token, "?profile=" + other.profile)).status).toBe(404);
    // O administrador alcança todas as áreas e vê a outra com a fila ligada.
    const admin = await read(
      await bearer(f.admin),
      "?profile=" + other.profile,
    );
    expect(admin.body.profiles[0].modules.map((m: any) => m.id)).toContain(
      "queue",
    );
  });

  it("exige autenticação e está no contrato OpenAPI", async () => {
    const response = await SELF.fetch("https://test/api/v1/capabilities");
    expect(response.status).toBe(401);
    const spec = openapi("https://test");
    expect(spec.paths["/capabilities"].get.tags).toEqual(["Módulos"]);
    expect(spec.paths["/profiles/{profile}/modules/{id}"].put).toBeTruthy();
    expect(spec.components.schemas.Capabilities).toBeTruthy();
  });
});
