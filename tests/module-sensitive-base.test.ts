// Base do núcleo para a revisão de segurança (M3, M6, M7): billing:write,
// dados pessoais e notas nas leituras dos módulos, telefone verificado.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { exec } from "../src/db";
import { perform, scopes } from "../src/service";
import { now, uid, type Actor, type Conversation } from "../src/types";
import { modulesApi } from "../src/modules/api";
import { application, fixture, receive } from "./service-center-fixture";

const app = (scopes: string[]): Actor => ({
  id: "app:x",
  kind: "app",
  name: "App",
  role: "operator",
  profiles: [],
  scopes,
  bots: [],
  rate: 60,
  runLimit: 3,
});

describe("base do núcleo: dado sensível, telefone verificado e billing:write", () => {
  it("mayRead e redact seguem a regra do núcleo", async () => {
    const f = await fixture();
    const ctx = modulesApi(env, f.profile, "os");
    const row = { id: "1", phone: "5511", notes: "interna", title: "Tela" };
    const fields = { contacts: ["phone"], notes: ["notes"] };
    // Pessoa da equipe vê tudo.
    expect(ctx.mayRead(f.member, "contacts")).toBe(true);
    expect(ctx.redact(f.member, row, fields)).toEqual(row);
    // Aplicação só de conversas: sem telefone e sem nota.
    expect(ctx.redact(app(["conversations:read"]), row, fields)).toEqual({
      id: "1",
      title: "Tela",
    });
    expect(
      ctx.redact(app(["conversations:read", "contacts:read"]), row, fields),
    ).toEqual({ id: "1", phone: "5511", title: "Tela" });
    expect(
      ctx.redact(app(["conversations:read", "notes:read"]), row, fields),
    ).toEqual({ id: "1", notes: "interna", title: "Tela" });
    // O original não muda.
    expect(row.phone).toBe("5511");
  });

  it("verifiedPhone: só o telefone autenticado pelo canal", async () => {
    const f = await fixture();
    const ctx = modulesApi(env, f.profile, "os");
    const channel = await receive(f, f.line, "oi", "5511977770001");
    expect(ctx.verifiedPhone(channel)).toBe("5511977770001");
    // Conversa de integração com external_id igual ao telefone de outra pessoa.
    const fake = {
      ...channel,
      external_namespace: "app:x",
      external_id: "5511977770001",
      phone: "5511977770001",
    } as Conversation;
    expect(ctx.verifiedPhone(fake)).toBeNull();
    expect(
      ctx.verifiedPhone({ ...channel, chat_type: "group" } as Conversation),
    ).toBeNull();
  });

  it("billing:write existe e não vai para aparelho pareado do Vinki ou do Fagoo", async () => {
    const f = await fixture();
    expect(scopes).toContain("billing:write");
    const created = await perform(
      env,
      f.admin,
      f.profile,
      "application.create",
      {
        name: "ERP",
        profiles: [f.profile],
        scopes: ["conversations:read", "billing:write"],
      },
      uid(),
    );
    expect(created.id).toBeTruthy();
    for (const client of ["vinki", "fagoo"]) {
      const paired = await application(f, ["conversations:read"]);
      await exec(
        env,
        "INSERT INTO pairing_requests(id,client,instance_name,device_hash,user_hash,status,expires,profile_id,app_id,created,updated) VALUES(?,?,?,?,?,'consumed',?,?,?,?,?)",
        uid(),
        client,
        "Loja",
        uid(),
        uid(),
        now() + 60000,
        f.profile,
        paired.id,
        now(),
        now(),
      );
      await expect(
        perform(
          env,
          f.admin,
          f.profile,
          "application.update",
          { id: paired.id, scopes: ["conversations:read", "billing:write"] },
          uid(),
        ),
      ).rejects.toMatchObject({
        code: "scope_not_allowed",
        message:
          "billing:write não pode ser concedida a aparelhos pareados do Vinki.",
      });
      // Outras mudanças de permissão continuam valendo.
      await perform(
        env,
        f.admin,
        f.profile,
        "application.update",
        { id: paired.id, scopes: ["conversations:read", "contacts:read"] },
        uid(),
      );
    }
  });
});
