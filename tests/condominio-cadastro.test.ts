import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all } from "../src/db";
import { now, uid } from "../src/types";
import { condominioModule } from "../src/modules/condominio/definition";
import { directory } from "../src/modules/condominio/cadastro";
import { resident, selected } from "../src/modules/condominio/common";
import { condFixture, residentToken } from "./condominio-fixture";
import { api, bearer, fixture } from "./service-center-fixture";

describe("Condomínio: cadastro e identidade", () => {
  it("é desligado por padrão, depende de OS e as rotas exigem ativação", async () => {
    expect(condominioModule.default_enabled).toBe(false);
    expect(condominioModule.requires).toEqual(["os"]);
    const f = await fixture();
    expect(
      (
        await api(
          await bearer(f.admin),
          `/profiles/${f.profile}/condominio/units`,
        )
      ).status,
    ).toBe(409);
  });
  it("cadastra blocos/unidades e todos os papéis com início inclusivo e fim exclusivo", async () => {
    const f = await condFixture();
    expect((await directory(f.ctx, f.admin, "units", {})).data).toHaveLength(2);
    for (const role of [
      "proprietario",
      "inquilino",
      "dependente",
      "funcionario",
    ]) {
      await f.create("membership", {
        person_id: f.person,
        unit_id: f.unit2,
        role,
        starts_at: now() - 3000,
        ends_at: now() - 1000,
      });
    }
    expect((await resident(f.ctx, f.customer, f.accessId)).units).toHaveLength(
      1,
    );
    await expect(
      f.create("membership", {
        person_id: f.person,
        unit_id: f.unit2,
        role: "inquilino",
        starts_at: 5,
        ends_at: 4,
      }),
    ).rejects.toMatchObject({ code: "invalid_period" });
  });
  it("exige escolha com várias unidades e revalida vínculo e telefone encerrados", async () => {
    const f = await condFixture();
    await f.create("membership", {
      person_id: f.person,
      unit_id: f.unit2,
      role: "inquilino",
      starts_at: now() - 1000,
    });
    const r = await resident(f.ctx, f.customer, f.accessId);
    expect(() => selected(r)).toThrow(/Escolha/);
    expect(selected(r, f.unit2).unit_id).toBe(f.unit2);
    await f.create("end-membership", { id: f.membership });
    expect(() =>
      selected(
        { ...r, units: r.units.filter((u) => u.id !== f.membership) },
        f.unit,
      ),
    ).toThrow();
    expect(
      (await resident(f.ctx, f.customer, f.accessId)).units.some(
        (u) => u.unit_id === f.unit,
      ),
    ).toBe(false);
    await f.create("end-phone", { id: f.phone });
    await expect(resident(f.ctx, f.customer, f.accessId)).rejects.toMatchObject(
      { code: "not_found" },
    );
  });
  it("recusa pessoa/unidade de outra área e telefone digitado não vincula ninguém", async () => {
    const f = await condFixture(),
      other = await condFixture();
    await expect(
      f.create("membership", {
        person_id: f.person,
        unit_id: other.unit,
        role: "inquilino",
        starts_at: now(),
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      f.create("phone", {
        person_id: f.person,
        phone: "5511000000000",
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      resident(other.ctx, f.customer, f.accessId),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      f.create("phone", {
        person_id: (await f.create("person", { name: "Outra" })).id,
        conversation_id: f.c.id,
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: "phone_in_use" });
  });
  it("portaria só recebe nome, unidade e telefone; bots e mesa não leem cadastro", async () => {
    const f = await condFixture();
    const contacts = await directory(f.ctx, f.member, "contacts", {});
    expect(contacts.data[0]).toMatchObject({
      name: "Ana",
      unit: "101",
      phone: "5511960010203",
    });
    expect(contacts.data[0]).not.toHaveProperty("role");
    expect(contacts.data[0]).not.toHaveProperty("fraction_ppb");
    await expect(
      directory(f.ctx, f.member, "assets", {}),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(directory(f.ctx, f.other, "people", {})).rejects.toMatchObject(
      { code: "forbidden" },
    );
    for (const actor of [
      { ...f.admin, id: "bot:1" },
      { ...f.admin, via: { masked: false } },
      { ...f.admin, kind: "app" },
      { ...f.admin, module: { id: "outro", reach: [] } },
    ] as any[])
      await expect(directory(f.ctx, actor, "people", {})).rejects.toMatchObject(
        { code: "forbidden" },
      );
    expect(condominioModule.bot!.deny).toEqual(["condominio/", "condominio."]);
    expect(condominioModule.bot!.sensitive).toEqual(["condominio."]);
  });
  it("veículo/animal exige responsável vigente da unidade; dependente não recebe comunicado", async () => {
    const f = await condFixture();
    for (const kind of ["vehicle", "animal"])
      await f.create("asset", {
        kind,
        unit_id: f.unit,
        person_id: f.person,
        label: "Cadastro",
        detail: "Detalhe",
      });
    expect((await directory(f.ctx, f.admin, "assets", {})).data).toHaveLength(
      2,
    );
    await expect(
      f.create("asset", {
        kind: "animal",
        unit_id: f.unit2,
        person_id: f.person,
        label: "Pet",
        detail: "Gato",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      f.create("membership", {
        person_id: f.person,
        unit_id: f.unit2,
        role: "dependente",
        starts_at: now(),
        notices: true,
      }),
    ).rejects.toMatchObject({ code: "invalid_recipient" });
  });
  it("cancelamento de vínculo futuro não concede acesso nem no instante inicial", async () => {
    const f = await condFixture(),
      starts = now() + 60000;
    const m = await f.create("membership", {
      person_id: f.person,
      unit_id: f.unit2,
      role: "inquilino",
      starts_at: starts,
    });
    await f.create("end-membership", m);
    const rows = await all(
      env,
      "SELECT id FROM cond_memberships WHERE profile_id=? AND id=? AND starts_at<=? AND (ends_at IS NULL OR ends_at>?)",
      f.profile,
      m.id,
      starts,
      starts,
    );
    expect(rows).toHaveLength(0);
  });
  it("rota HTTP cria com idempotência e impede o papel portaria de cadastrar", async () => {
    const f = await condFixture(),
      root = `/profiles/${f.profile}/condominio`;
    const key = uid(),
      token = await bearer(f.admin);
    const first = await api(
      token,
      `${root}/blocks`,
      "POST",
      { name: "B" },
      key,
    );
    expect(first.status).toBe(200);
    const repeated = await api(
      token,
      `${root}/blocks`,
      "POST",
      { name: "B" },
      key,
    );
    expect(await repeated.json()).toEqual(await first.json());
    expect(
      (
        await api(await bearer(f.member), `${root}/blocks`, "POST", {
          name: "C",
        })
      ).status,
    ).toBe(403);
    expect(
      await all(
        env,
        "SELECT id FROM cond_blocks WHERE profile_id=? AND name='B'",
        f.profile,
      ),
    ).toHaveLength(1);
  });
  it("credencial HTTP é presa ao acesso, parâmetros da URL prevalecem e revogação é imediata", async () => {
    const f = await condFixture(),
      token = await residentToken(f),
      base = `/profiles/${f.profile}/condominio`;
    const units = await api(token, `${base}/me/${f.accessId}/units`);
    expect(units.status).toBe(200);
    expect((await units.json<any>()).data).toEqual([
      { id: f.unit, block: "Bloco A", number: "101" },
    ]);
    expect((await api(token, `${base}/me/outro/units`)).status).toBe(403);
    expect((await api(token, `${base}/phones`)).status).toBe(403);
    const choose = await api(token, `${base}/me/${f.accessId}/select`, "POST", {
      access_id: "forjado",
      profile: "forjado",
      unit_id: f.unit,
    });
    expect(choose.status).toBe(200);
    expect(
      (
        await api(token, `${base}/me/${f.accessId}/select`, "POST", {
          unit_id: f.unit2,
        })
      ).status,
    ).toBe(404);
    await f.create("end-phone", { id: f.phone });
    expect((await api(token, `${base}/me/${f.accessId}/units`)).status).toBe(
      404,
    );
  });
});
