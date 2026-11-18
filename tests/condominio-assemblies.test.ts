import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { now, uid } from "../src/types";
import {
  assemblyCommand,
  assemblyDetail,
  attendance,
  ballot,
  electoralRecords,
  results,
  vote,
} from "../src/modules/condominio/assemblies";
import { condFixture } from "./condominio-fixture";

async function election(rules: Record<string, unknown> = {}) {
  const f = await condFixture();
  const command = (action: string, data: any) =>
    assemblyCommand(f.ctx, f.admin, action, data, uid());
  const a = await command("create", {
    title: "Assembleia",
    call_text: "Convocação conferida",
    starts_at: now() - 1000,
  });
  const p = await command("agenda", {
    id: a.id,
    title: "Melhoria",
    options: ["Sim", "Não", "Abstenção"],
    closes_at: now() + 3600000,
    ...rules,
  });
  await command("publish", { id: a.id, reviewed: true });
  const qualify = (rest: Record<string, unknown> = {}) =>
    command("qualify", {
      id: p.id,
      unit_id: f.unit,
      person_id: f.person,
      ...rest,
    });
  const presence = () =>
    attendance(
      f.ctx,
      f.customer,
      { assembly_id: a.id, unit_id: f.unit },
      f.accessId,
    );
  const cast = (choice = "Sim", key = uid(), unit = f.unit) =>
    vote(
      f.ctx,
      f.customer,
      f.accessId,
      { agenda_id: p.id, unit_id: unit, choice, confirmed: true },
      key,
    );
  return { ...f, a, p, command, qualify, presence, cast };
}
describe("Condomínio: assembleia e voto por unidade", () => {
  it("publica convocação e pauta; regras começam desligadas e não mudam depois de abrir", async () => {
    const f = await election();
    const detail = await assemblyDetail(f.ctx, f.customer, f.a.id, f.accessId);
    expect(detail.agenda[0]).toMatchObject({
      weighted: false,
      block_debt: false,
    });
    const call = await one(
      env,
      "SELECT status,notice_id FROM cond_assemblies WHERE profile_id=? AND id=?",
      f.profile,
      f.a.id,
    );
    expect(call!.status).toBe("published");
    expect(
      await one(
        env,
        "SELECT body,status FROM cond_notices WHERE profile_id=? AND id=?",
        f.profile,
        call!.notice_id,
      ),
    ).toMatchObject({
      status: "approved",
      body: "Convocação conferida\n\nPauta:\n1. Melhoria",
    });
    await f.qualify();
    await f.command("open", { id: f.p.id });
    await expect(f.qualify()).rejects.toMatchObject({
      code: "electorate_frozen",
    });
    await expect(
      f.command("agenda", {
        id: f.a.id,
        title: "Outra",
        options: ["A", "B"],
        closes_at: now() + 3000,
      }),
    ).rejects.toMatchObject({ code: "invalid_agenda" });
  });
  it("presença não habilita voto e voto exige presença e confirmação explícita", async () => {
    const f = await election();
    await f.presence();
    await expect(f.cast()).rejects.toMatchObject({ code: "not_found" });
    await f.qualify();
    await f.command("open", { id: f.p.id });
    await attendance(
      f.ctx,
      f.customer,
      { assembly_id: f.a.id, unit_id: f.unit, leave: true },
      f.accessId,
    );
    await expect(f.cast()).rejects.toMatchObject({ code: "presence_required" });
    await f.presence();
    await expect(
      vote(
        f.ctx,
        f.customer,
        f.accessId,
        { agenda_id: f.p.id, unit_id: f.unit, choice: "Sim" },
        uid(),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(f.cast("Inexistente")).rejects.toMatchObject({
      code: "invalid_choice",
    });
    expect(await f.cast()).toMatchObject({ unit_id: f.unit, recorded: true });
  });
  it("garante um voto por unidade sob concorrência e grava auditoria atomicamente", async () => {
    const f = await election();
    await f.qualify();
    await f.presence();
    await f.command("open", { id: f.p.id });
    const outcomes = await Promise.allSettled([f.cast("Sim"), f.cast("Não")]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((r) => r.status === "rejected")).toHaveLength(1);
    const votes = await all(
      env,
      "SELECT * FROM cond_votes WHERE profile_id=? AND agenda_id=?",
      f.profile,
      f.p.id,
    );
    expect(votes).toHaveLength(1);
    expect(votes[0]).toMatchObject({
      unit_id: f.unit,
      person_id: f.person,
      actor_id: f.customer.id,
      weight: 1,
    });
    expect(
      await all(
        env,
        "SELECT entity_id FROM cond_audit WHERE profile_id=? AND action='vote'",
        f.profile,
      ),
    ).toEqual([{ entity_id: votes[0].id }]);
  });
  it("replay devolve o recibo, mesma chave com outra escolha conflita; prazo independe do alarme", async () => {
    const f = await election();
    await f.qualify();
    await f.presence();
    await f.command("open", { id: f.p.id });
    const key = uid(),
      first = await f.cast("Sim", key);
    expect(await f.cast("Sim", key)).toEqual(first);
    await expect(f.cast("Não", key)).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    await exec(
      env,
      "UPDATE cond_agenda SET closes_at=? WHERE profile_id=? AND id=?",
      now() - 1,
      f.profile,
      f.p.id,
    );
    await expect(f.cast("Não")).rejects.toMatchObject({
      code: "voting_closed",
    });
    expect(await f.cast("Sim", key)).toEqual(first);
  });
  it("um telefone com duas unidades tem duas cédulas; coproprietário não duplica voto", async () => {
    const f = await election();
    await f.create("membership", {
      person_id: f.person,
      unit_id: f.unit2,
      role: "proprietario",
      starts_at: now() - 1000,
    });
    await f.qualify();
    await f.qualify({ unit_id: f.unit2 });
    await f.presence();
    await attendance(
      f.ctx,
      f.customer,
      { assembly_id: f.a.id, unit_id: f.unit2 },
      f.accessId,
    );
    await f.command("open", { id: f.p.id });
    await f.cast();
    await f.cast("Não", uid(), f.unit2);
    const coowner = (await f.create("person", { name: "Coproprietário" })).id;
    await f.create("membership", {
      person_id: coowner,
      unit_id: f.unit,
      role: "proprietario",
      starts_at: now() - 1000,
    });
    await expect(f.qualify({ person_id: coowner })).rejects.toMatchObject({
      code: "electorate_frozen",
    });
    await f.command("close", { id: f.p.id });
    expect(
      (await results(f.ctx, f.customer, f.p.id, f.accessId)).totals,
    ).toEqual([
      { choice: "Sim", votes: 1, weight: 1 },
      { choice: "Não", votes: 1, weight: 1 },
      { choice: "Abstenção", votes: 0, weight: 0 },
    ]);
  });
  it("frações precisam estar completas e somar 1 bilhão; peso fica congelado", async () => {
    const f = await election({ weighted: true });
    await f.qualify();
    await f.presence();
    await exec(
      env,
      "UPDATE cond_units SET fraction_ppb=NULL WHERE profile_id=? AND id=?",
      f.profile,
      f.unit2,
    );
    await expect(f.command("open", { id: f.p.id })).rejects.toMatchObject({
      code: "fraction_total",
    });
    await exec(
      env,
      "UPDATE cond_units SET fraction_ppb=400000000 WHERE profile_id=? AND id=?",
      f.profile,
      f.unit2,
    );
    await f.command("open", { id: f.p.id });
    // Simula dado administrativo futuro: apuração usa o retrato, nunca a fração relida.
    await exec(
      env,
      "UPDATE cond_units SET fraction_ppb=500000000 WHERE profile_id=? AND id=?",
      f.profile,
      f.unit,
    );
    await f.cast();
    await f.command("close", { id: f.p.id });
    expect((await results(f.ctx, f.admin, f.p.id)).totals[0].weight).toBe(
      600000000,
    );
  });
  it("inadimplência desligada não bloqueia; ligada exige revisão por unidade e não aceita desconhecido", async () => {
    const f = await election({ block_debt: true });
    await expect(f.qualify()).rejects.toMatchObject({
      code: "financial_review_required",
    });
    await expect(
      assemblyCommand(
        f.ctx,
        f.other,
        "qualify",
        {
          id: f.p.id,
          unit_id: f.unit,
          person_id: f.person,
          debt_status: "regular",
          debt_evidence: "Conferida",
        },
        uid(),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await f.qualify({
      debt_status: "overdue",
      debt_evidence: "Competência e data conferidas",
    });
    await f.presence();
    await f.command("open", { id: f.p.id });
    await expect(f.cast()).rejects.toMatchObject({ code: "not_eligible" });
    const regular = await election({ block_debt: true });
    await regular.qualify({
      debt_status: "regular",
      debt_evidence: "Obrigações desta unidade na data de referência",
    });
    await regular.presence();
    await regular.command("open", { id: regular.p.id });
    expect((await regular.cast()).recorded).toBe(true);
  });
  it("inquilino depende de procuração revisada; revogação e término do proprietário impedem voto", async () => {
    const f = await election();
    await f.create("end-membership", { id: f.membership });
    await f.create("membership", {
      person_id: f.person,
      unit_id: f.unit,
      role: "inquilino",
      starts_at: now() - 1,
    });
    await expect(f.qualify()).rejects.toMatchObject({
      code: "representation_invalid",
    });
    const grantor = (await f.create("person", { name: "Proprietário" })).id;
    await f.create("membership", {
      person_id: grantor,
      unit_id: f.unit,
      role: "proprietario",
      starts_at: now() - 1000,
    });
    const proxy = await f.command("proxy", {
      assembly_id: f.a.id,
      agenda_id: f.p.id,
      unit_id: f.unit,
      grantor_id: grantor,
      person_id: f.person,
      evidence: "PROCURAÇÃO_SIGILOSA",
      expires_at: now() + 300000,
    });
    await expect(f.qualify({ proxy_id: proxy.id })).rejects.toMatchObject({
      code: "representation_invalid",
    });
    await f.command("review-proxy", { id: proxy.id, reviewed: true });
    await f.qualify({ proxy_id: proxy.id });
    await f.presence();
    await f.command("open", { id: f.p.id });
    await f.command("revoke-proxy", { id: proxy.id, reviewed: true });
    await expect(f.cast()).rejects.toMatchObject({
      code: "representation_invalid",
    });
    await expect(
      electoralRecords(f.ctx, f.member, f.a.id, "proxies"),
    ).rejects.toMatchObject({ code: "forbidden" });
    const read = await electoralRecords(f.ctx, f.admin, f.a.id, "proxies");
    expect(JSON.stringify(read)).toContain("PROCURAÇÃO_SIGILOSA");
    expect(
      await all(
        env,
        "SELECT id FROM cond_audit WHERE profile_id=? AND action='proxy_read'",
        f.profile,
      ),
    ).toHaveLength(1);
  });
  it("isola área, bloqueia portaria/IA e só publica totais após fechar; ata não contém nomes/votos individuais", async () => {
    const f = await election(),
      other = await condFixture();
    await f.qualify();
    await f.presence();
    await f.command("open", { id: f.p.id });
    await expect(
      results(f.ctx, f.customer, f.p.id, f.accessId),
    ).rejects.toMatchObject({ code: "results_unavailable" });
    await expect(
      ballot(other.ctx, other.customer, other.accessId, f.p.id, f.unit),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(assemblyDetail(f.ctx, f.member, f.a.id)).rejects.toMatchObject(
      { code: "forbidden" },
    );
    await expect(
      assemblyDetail(
        f.ctx,
        { ...f.admin, via: { masked: false } } as any,
        f.a.id,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await f.cast();
    await f.command("close", { id: f.p.id });
    const publicResult = JSON.stringify(
      await results(f.ctx, f.customer, f.p.id, f.accessId),
    );
    expect(publicResult).not.toContain(f.unit);
    expect(publicResult).not.toContain(f.person);
    const minutes = await f.command("minutes", { id: f.a.id });
    expect(minutes.minutes).toContain("Sim: 1 voto(s), peso 1");
    expect(minutes.minutes).not.toContain("Ana");
    expect(minutes.minutes).not.toContain(f.unit);
  });
  it("anular preserva votos e impede novas ações; não declara aprovação automática", async () => {
    const f = await election();
    await f.qualify();
    await f.presence();
    await f.command("open", { id: f.p.id });
    await f.cast();
    await expect(f.command("annul", { id: f.p.id })).rejects.toMatchObject({
      code: "reason_required",
    });
    await f.command("annul", { id: f.p.id, reason: "Correção da pauta" });
    await expect(f.cast()).rejects.toMatchObject({ code: "voting_closed" });
    await expect(results(f.ctx, f.admin, f.p.id)).rejects.toMatchObject({
      code: "results_unavailable",
    });
    expect(
      await all(
        env,
        "SELECT id FROM cond_votes WHERE profile_id=? AND agenda_id=?",
        f.profile,
        f.p.id,
      ),
    ).toHaveLength(1);
  });
  it("não abre eleitorado com representação encerrada e retira ata ao anular resultado já publicado", async () => {
    const f = await election();
    await f.qualify();
    await f.create("end-membership", { id: f.membership });
    await expect(f.command("open", { id: f.p.id })).rejects.toMatchObject({
      code: "representation_invalid",
    });
    const g = await election();
    await g.qualify();
    await g.presence();
    await g.command("open", { id: g.p.id });
    await g.cast();
    await g.command("close", { id: g.p.id });
    await g.command("minutes", { id: g.a.id });
    await g.command("annul", {
      id: g.p.id,
      reason: "Representação contestada",
    });
    expect(
      (await assemblyDetail(g.ctx, g.customer, g.a.id, g.accessId)).minutes,
    ).toBe("");
  });
});
