import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { exec } from "../src/db";
import { conversation } from "../src/service";
import { now } from "../src/types";
import { modulesApi } from "../src/modules/api";
import {
  formatDocument,
  validCnpj,
  validCpf,
  validateEstablishment,
} from "../src/establishment";
import {
  api,
  application,
  bearer,
  drain,
  fixture,
  receive,
} from "./service-center-fixture";

const get = async (token: string, path: string) => {
  const response = await api(token, path);
  return { status: response.status, body: await response.json<any>() };
};

const body = {
  name: "Assistência Exemplo",
  document: "11.222.333/0001-81",
  address: "Rua das Flores, 120\nCentro, Campinas/SP",
  phone: "(19) 3333-4444",
  footer: "Garantia de 90 dias.",
};

describe("dados do estabelecimento", () => {
  it("confere CPF e CNPJ, inclusive o alfanumérico", () => {
    expect(validCpf("52998224725")).toBe(true);
    expect(validCpf("52998224724")).toBe(false);
    expect(validCpf("11111111111")).toBe(false);
    expect(validCnpj("11222333000181")).toBe(true);
    expect(validCnpj("11222333000182")).toBe(false);
    // Exemplo publicado pela Receita para o CNPJ alfanumérico.
    expect(validCnpj("12ABC34501DE35")).toBe(true);
    expect(validCnpj("12ABC34501DE36")).toBe(false);
    expect(formatDocument("52998224725")).toBe("529.982.247-25");
    expect(formatDocument("12ABC34501DE35")).toBe("12.ABC.345/01DE-35");
    expect(validateEstablishment({ document: "529.982.247-25" }).document).toBe(
      "52998224725",
    );
    expect(
      validateEstablishment({ document: "12.abc.345/01de-35" }).document,
    ).toBe("12ABC34501DE35");
    expect(() => validateEstablishment({ document: "123" })).toThrow(
      /CPF ou CNPJ inválido/,
    );
    expect(() => validateEstablishment({ name: "x".repeat(101) })).toThrow(
      /Nome fantasia/,
    );
    expect(() => validateEstablishment({ phone: "1\n2" })).toThrow(
      /numa linha/,
    );
    expect(() => validateEstablishment([])).toThrow(/inválidos/);
  });

  it("gestão grava; pessoa, aparelho pareado, módulo e página do passo web leem", async () => {
    const f = await fixture();
    const admin = await bearer(f.admin);
    const member = await bearer(f.member);
    const path = `/profiles/${f.profile}/establishment`;
    // Sem cadastro: nome da área.
    const before = (await get(member, path)).body;
    expect(before).toMatchObject({ configured: false, document_type: null });
    expect(before.name).toBeTruthy();

    // Só administrador grava.
    const settings = `/profiles/${f.profile}/settings`;
    expect(
      (await api(member, settings, "PUT", { establishment: body })).status,
    ).toBe(403);
    expect(
      (await api(admin, settings, "PUT", { establishment: body })).status,
    ).toBe(200);
    expect((await get(member, path)).body).toEqual({
      name: "Assistência Exemplo",
      document: "11222333000181",
      document_type: "cnpj",
      document_display: "11.222.333/0001-81",
      address: "Rua das Flores, 120\nCentro, Campinas/SP",
      phone: "(19) 3333-4444",
      footer: "Garantia de 90 dias.",
      configured: true,
    });
    expect(
      (
        await api(admin, settings, "PUT", {
          establishment: { ...body, document: "11222333000182" },
        })
      ).status,
    ).toBe(400);

    // Chave de aplicação com escopo só da fila (como o totem pareado) lê.
    const device = await application(f, ["queue:read"]);
    const viaApp = await get(device.token, path);
    expect(viaApp.status).toBe(200);
    expect(viaApp.body.document_display).toBe("11.222.333/0001-81");
    // Área que a credencial não alcança: 404.
    const other = await fixture();
    expect(
      (await get(device.token, `/profiles/${other.profile}/establishment`))
        .status,
    ).toBe(404);
    expect(
      (await get(member, `/profiles/${other.profile}/establishment`)).status,
    ).toBe(404);

    // Módulo.
    const ctx = modulesApi(env, f.profile, "forms");
    expect((await ctx.establishment()).name).toBe("Assistência Exemplo");

    // Página do passo web: nome no cabeçalho, dados no rodapé.
    await exec(
      env,
      "INSERT OR REPLACE INTO instance_settings(key,value,updated) VALUES('public_origin','https://x.example.com',?)",
      now(),
    );
    const r = await receive(f, f.line, "oi", "5511991000002");
    await drain(f);
    const c = await conversation(env, r.id, f.profile);
    const opened = await ctx.openWebStep(c, {
      kind: "form",
      ref: "cadastro",
      trigger: "module",
      actor: "system",
      sourceKey: "est-1",
      spec: {
        title: "Cadastro",
        fields: [{ id: "nome", type: "text", label: "Nome" }],
      },
    });
    const html = await (
      await SELF.fetch(
        opened.url!.replace("https://x.example.com", "https://test"),
      )
    ).text();
    expect(html).toContain(
      '<header class="brand">Assistência Exemplo</header>',
    );
    expect(html).toContain("CNPJ 11.222.333/0001-81");
    expect(html).toContain("(19) 3333-4444");
    expect(html).toContain("Garantia de 90 dias.");
  });

  it("pessoas da área: id, nome e papel, para escolher responsável", async () => {
    const f = await fixture();
    const other = await fixture();
    const path = `/profiles/${f.profile}/people`;
    const list = await get(await bearer(f.member), path);
    expect(list.status).toBe(200);
    const ids = list.body.data.map((p: any) => p.id);
    expect(ids).toContain(f.member.id);
    expect(ids).toContain(f.admin.id);
    expect(ids).not.toContain(other.member.id);
    for (const person of list.body.data) {
      expect(Object.keys(person).sort()).toEqual(["grants", "id", "name", "role"]);
      expect(person.grants).toEqual([]);
      expect(["admin", "operator"]).toContain(person.role);
    }
    // Chave de aplicação: só com conversations:read.
    const reader = await application(f, ["conversations:read"]);
    expect((await get(reader.token, path)).status).toBe(200);
    const queueOnly = await application(f, ["queue:read"]);
    expect((await get(queueOnly.token, path)).status).toBe(403);
    expect(
      (await get(reader.token, `/profiles/${other.profile}/people`)).status,
    ).toBe(404);
  });

  it("aparece em features das capacidades", async () => {
    const f = await fixture();
    const caps = (await get(await bearer(f.member), "/capabilities")).body;
    expect(caps.features).toContain("establishment");
  });
});
