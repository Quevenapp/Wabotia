import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { one } from "../src/db";
import { now, uid } from "../src/types";
import {
  createWork,
  moveWork,
  workDetail,
  works,
} from "../src/modules/condominio/works";
import { condFixture } from "./condominio-fixture";

describe("Condomínio: ponte com o motor", () => {
  it("preenche unidade verificada, ignora telefone/unidade textual e preserva a ordem em replay", async () => {
    const f = await condFixture(),
      key = uid();
    const d = {
      kind: "ocorrencia",
      item: "Elevador",
      problem: "Parado",
      phone: "99999999",
      extra: { unidade: "Injetada" },
    };
    const first = await createWork(f.ctx, f.customer, d, key, f.accessId);
    const replay = await createWork(f.ctx, f.customer, d, key, f.accessId);
    expect(replay.id).toBe(first.id);
    const view = await workDetail(f.ctx, f.customer, first.id, f.accessId);
    expect(view.extra.unidade).toBe("Bloco A · 101");
    expect(view.customer).not.toHaveProperty("phone");
    expect(
      await one(
        env,
        "SELECT unit_id,person_id FROM cond_works WHERE profile_id=? AND id=?",
        f.profile,
        first.id,
      ),
    ).toMatchObject({ unit_id: f.unit, person_id: f.person });
    await expect(
      createWork(
        f.ctx,
        f.customer,
        { ...d, extra: { segredo: "SIGILO" } },
        uid(),
        f.accessId,
      ),
    ).rejects.toMatchObject({ code: "private_field" });
  });
  it("portaria opera encomenda/visitante e nunca recebe relato, financeiro ou ocorrência", async () => {
    const f = await condFixture();
    const create = (kind: string) =>
      createWork(
        f.ctx,
        f.admin,
        {
          kind,
          unit_id: f.unit,
          person_id: f.person,
          item: "Caixa",
          problem: "SIGILO_RELATO",
        },
        uid(),
      );
    const parcel = await create("encomenda"),
      incident = await create("ocorrencia");
    const v = await workDetail(f.ctx, f.member, parcel.id);
    expect(v).toMatchObject({
      name: "Ana",
      unit: "101",
      phone: "5511960010203",
    });
    expect(JSON.stringify(v)).not.toContain("SIGILO_RELATO");
    for (const field of ["quote", "extra", "history", "notes", "problem"])
      expect(v).not.toHaveProperty(field);
    expect((await works(f.ctx, f.member, {})).data.map((w) => w.id)).toEqual([
      parcel.id,
    ]);
    await expect(
      workDetail(f.ctx, f.member, incident.id),
    ).rejects.toMatchObject({ code: "not_found" });
    await moveWork(
      f.ctx,
      f.member,
      { id: parcel.id, transition_id: "iniciar", version: v.version },
      uid(),
    );
    expect((await workDetail(f.ctx, f.member, parcel.id)).stage).toBe(
      "Execução",
    );
    await expect(
      moveWork(
        f.ctx,
        f.member,
        { id: incident.id, transition_id: "iniciar", version: 1 },
        uid(),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });
  it("não compartilha histórico reservado com coabitante nem novo ocupante; isola áreas", async () => {
    const f = await condFixture(),
      other = await condFixture();
    const order = await createWork(
      f.ctx,
      f.customer,
      { kind: "visitante", item: "Visita", problem: "Recepção" },
      uid(),
      f.accessId,
    );
    await expect(
      workDetail(other.ctx, other.customer, order.id, other.accessId),
    ).rejects.toMatchObject({ code: "not_found" });
    await f.create("end-membership", { id: f.membership });
    await f.create("membership", {
      person_id: f.person,
      unit_id: f.unit,
      role: "inquilino",
      starts_at: now() - 1,
    });
    expect((await works(f.ctx, f.customer, {}, f.accessId)).data).toHaveLength(
      0,
    );
    await expect(
      workDetail(f.ctx, f.customer, order.id, f.accessId),
    ).rejects.toMatchObject({ code: "not_found" });
  });
  it("bots não abrem trabalhos nem recebem cadastro pelo acesso de outro cliente", async () => {
    const f = await condFixture();
    await expect(
      createWork(
        f.ctx,
        { ...f.admin, id: "bot:x" },
        {
          kind: "encomenda",
          unit_id: f.unit,
          person_id: f.person,
          item: "A",
          problem: "B",
        },
        uid(),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      works(
        f.ctx,
        {
          ...f.customer,
          credential: { ...f.customer.credential!, subject: "outro" },
        },
        {},
        f.accessId,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
