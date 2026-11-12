import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { json, now, uid, type Actor } from "../src/types";
import { perform, settings } from "../src/service";
import { availableMenus, menuPayload } from "../src/line-service";
import { serviceTemplates } from "../src/service-templates";
import { defaultProtocolConfirmation } from "../src/protocols";
import { openapi } from "../src/openapi";
import {
  api,
  application,
  bearer,
  bot,
  configure,
  drain,
  fixture,
  latest,
  receive,
  tickets,
  type Fixture,
} from "./service-center-fixture";

const template = serviceTemplates.find((t) => t.id === "central-aplicativos")!;
const wanted = template.settings;
const apply = (f: Fixture, body: any = {}, actor: Actor = f.admin) =>
  perform(
    env,
    actor,
    f.profile,
    "service-template.apply",
    { id: template.id, ...body },
    uid(),
  );
const ids = (list: any[]) => list.map((item) => item.id);
const children = (menus: any[], parent: string | null) =>
  menus.filter((menu) => (menu.parent_id || null) === parent);

describe("modelo central-aplicativos", () => {
  it("segue o contrato: setores, categorias, prazo, menu e prefixo dos ids", () => {
    expect(serviceTemplates.map((t) => t.id)).toEqual(["central-aplicativos"]);
    expect(wanted.departments.map((d) => d.name)).toEqual([
      "Suporte e protocolos",
      "Clientes com contrato",
      "Comercial e serviços",
      "Compras e licenças",
    ]);
    expect(wanted.ticket_categories.map((c) => c.name)).toEqual([
      "Pixel Goods",
      "Quall Studio",
      "NFS-e Leve",
      "Printher",
      "Wabotia",
      "Fagoo ERP",
      "Vinki",
      "Servidor ou integração",
      "Outro ou não sei",
    ]);
    expect(wanted).toMatchObject({
      protocol_response_unit: "business_days",
      protocol_response_days: 3,
      business_hours: { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" },
    });
    for (const item of [
      ...wanted.departments,
      ...wanted.ticket_categories,
      ...wanted.menus,
    ]) {
      expect(item.id).toMatch(/^central-[a-z0-9-]+$/);
      expect(item.id.length).toBeLessThanOrEqual(100);
    }
    const all = [
      ...ids(wanted.departments),
      ...ids(wanted.ticket_categories),
      ...ids(wanted.menus),
    ];
    expect(new Set(all).size).toBe(all.length);
    const root = children(wanted.menus, null);
    expect(root.map((m) => [m.label, m.type])).toEqual([
      ["Ajuda gratuita", "submenu"],
      ["Meus protocolos", "protocols"],
      ["Já tenho contrato", "human"],
      ["Contratar serviços", "submenu"],
      ["Compras e licenças", "submenu"],
      ["Conhecer aplicativos", "submenu"],
    ]);
    expect(root[2].department_id).toBe("central-setor-contratos");
    const help = children(wanted.menus, root[0].id);
    expect(help.map((m) => m.type)).toEqual([
      ...Array(9).fill("bot"),
      "ticket",
    ]);
    expect(help.slice(0, 7).map((m) => m.label)).toEqual(
      wanted.ticket_categories.slice(0, 7).map((c) => c.name),
    );
    expect(help.at(-1)!.label).toBe("Abrir protocolo");
    const services = children(wanted.menus, root[3].id);
    expect(services.map((m) => m.type)).toEqual([
      "content",
      "content",
      "content",
      "human",
    ]);
    expect(services[3].department_id).toBe("central-setor-comercial");
    expect(children(wanted.menus, root[4].id).map((m) => m.type)).toEqual([
      "content",
      "content",
      "ticket",
    ]);
    const known = children(wanted.menus, root[5].id);
    expect(known.map((m) => [m.label, m.type])).toEqual(
      wanted.ticket_categories.slice(0, 7).map((c) => [c.name, "content"]),
    );
    for (const rule of [
      "já disse",
      "aplicativo e o objetivo",
      "um vídeo e um artigo",
      "confirme se resolveu",
      "duas tentativas",
      "Nunca exija a contratação",
      "Compra não reconhecida",
      "senhas e tokens",
    ])
      expect(wanted.instructions).toContain(rule);
  });
  it("respeita os limites do WhatsApp em cada nível", () => {
    const parents = [
      null,
      ...ids(wanted.menus.filter((m) => m.type === "submenu")),
    ];
    for (const parent of parents) {
      const level = children(wanted.menus, parent);
      expect(level.length).toBeGreaterThan(0);
      expect(level.length).toBeLessThanOrEqual(10);
      // "N. label" must fit the 24 characters of a list row untruncated.
      const payload: any = menuPayload(level, "Menu", "token", true, !!parent);
      const interactive = payload.content.interactive;
      if (interactive.type === "list")
        expect(
          interactive.action.sections[0].rows.map((row: any) => row.title),
        ).toEqual(level.map((m, index) => `${index + 1}. ${m.label}`));
      else
        for (const m of level)
          expect(Array.from(m.label).length).toBeLessThanOrEqual(20);
    }
    for (const menu of wanted.menus) {
      expect(Array.from(menu.label).length).toBeLessThanOrEqual(20);
      for (const text of [menu.content, menu.fallback_content])
        if (text !== undefined) {
          expect(text.trim().length).toBeGreaterThan(20);
          expect(text.length).toBeLessThanOrEqual(3500);
        }
      if (menu.type === "content") expect(menu.content).toBeTruthy();
      if (menu.type === "bot")
        expect(menu.fallback_content).toContain("PROTOCOLO");
    }
    expect(wanted.instructions.length).toBeLessThan(3000);
    expect(wanted.protocol_confirmation).toBe(defaultProtocolConfirmation);
  });
});

describe("GET /service-templates", () => {
  it("lista os modelos com o conteúdo completo para pessoas autenticadas", async () => {
    const f = await fixture(),
      token = await bearer(f.member);
    const response = await api(token, "/service-templates");
    expect(response.status).toBe(200);
    const body = await response.json<any>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: "central-aplicativos",
      name: "Central de aplicativos",
      description: expect.stringContaining("quatro modalidades"),
      summary: expect.stringContaining("3 dias úteis"),
      manual_steps: expect.any(Array),
    });
    expect(body.data[0].settings.menus).toHaveLength(wanted.menus.length);
    expect(ids(body.data[0].settings.departments)).toEqual(
      ids(wanted.departments),
    );
    const app = await application(f, ["conversations:read"]);
    expect((await api(app.token, "/service-templates")).status).toBe(403);
    expect((await fetchAnonymous("/api/v1/service-templates")).status).toBe(
      401,
    );
    const spec = openapi("https://test");
    expect(spec.paths["/service-templates"].get).toBeTruthy();
    expect(
      spec.paths["/profiles/{profile}/service-templates/{id}/apply"].post
        .requestBody.content["application/json"].schema.$ref,
    ).toBe("#/components/schemas/ServiceTemplateApply");
  });
});
const fetchAnonymous = (path: string) => SELF.fetch("https://test" + path);

describe("aplicar o modelo", () => {
  it("merge em área vazia cria tudo, sem bot vira mensagem informativa e lista o que falta", async () => {
    const f = await fixture();
    const result = await apply(f);
    expect(result).toMatchObject({
      template_id: "central-aplicativos",
      mode: "merge",
      bot_id: null,
    });
    expect(result.created.departments).toEqual(ids(wanted.departments));
    expect(result.created.categories).toEqual(ids(wanted.ticket_categories));
    expect(result.created.menus).toEqual(ids(wanted.menus));
    expect(result.created.settings).toEqual([
      "protocol_response_unit",
      "protocol_response_days",
      "business_hours",
      "instructions",
      "menu_greeting",
    ]);
    expect(result.kept).toEqual({
      departments: [],
      categories: [],
      menus: [],
      settings: ["protocol_confirmation"],
    });
    for (const group of [result.replaced, result.removed, result.skipped])
      expect(Object.values(group).flat()).toEqual([]);
    const cfg = await settings(env, f.profile);
    expect(cfg).toMatchObject({
      protocol_response_unit: "business_days",
      protocol_response_days: 3,
      business_hours: {
        days: [1, 2, 3, 4, 5],
        start: "09:00",
        end: "18:00",
        holidays: [],
      },
      instructions: wanted.instructions,
      protocol_confirmation: defaultProtocolConfirmation,
    });
    expect(cfg.departments).toEqual(
      wanted.departments.map((d) => ({ ...d, members: [] })),
    );
    expect(cfg.ticket_categories).toEqual(wanted.ticket_categories);
    // No bot anywhere: the nine help options are informative messages.
    const help = children(cfg.menus, "central-menu-ajuda");
    expect(help.map((m: any) => m.type)).toEqual([
      ...Array(9).fill("content"),
      "ticket",
    ]);
    for (const menu of cfg.menus) {
      expect(menu.type).not.toBe("bot");
      expect(menu).not.toHaveProperty("fallback_content");
      expect(menu).not.toHaveProperty("bot_id");
    }
    expect(help[0].content).toContain("Descreva sua dúvida");
    expect(help[0].content).toContain("PROTOCOLO");
    const codes = result.pending.map((p: any) => p.code);
    expect(
      codes.filter((code: string) => code === "department_members"),
    ).toHaveLength(4);
    for (const code of [
      "bot_missing",
      "attendant_bot",
      "review_texts",
      "knowledge",
      "notification_template",
      "contract_identification",
    ])
      expect(codes).toContain(code);
    expect(codes).not.toContain("connect_whatsapp");
    expect(codes).not.toContain("activate");
    expect(
      result.pending.find((p: any) => p.code === "department_members"),
    ).toEqual({
      code: "department_members",
      department_id: "central-setor-suporte",
      message: expect.stringContaining("Suporte e protocolos"),
    });
    for (const p of result.pending)
      expect(p.message.length).toBeGreaterThan(20);
  });
  it("o menu aplicado funciona: navegação, protocolo gratuito e fila do setor", async () => {
    const f = await fixture();
    await apply(f);
    const root = await availableMenus(env, f.profile, f.line);
    expect(root.map((m: any) => m.label)).toEqual([
      "Ajuda gratuita",
      "Meus protocolos",
      "Já tenho contrato",
      "Contratar serviços",
      "Compras e licenças",
      "Conhecer aplicativos",
    ]);
    const say = async (text: string) => {
      const c = await receive(f, f.line, text);
      await drain(f);
      return c;
    };
    let c = await say("Olá");
    expect((await latest(c.id)).content.interactive.type).toBe("list");
    await say("5");
    expect((await latest(c.id)).content.interactive.type).toBe("button");
    await say("3");
    expect((await latest(c.id)).text).toContain("pagamento ou a liberação");
    await say("Paguei ontem e o recurso não liberou");
    const [ticket] = await tickets(c.id);
    expect(ticket).toMatchObject({
      title: "Paguei ontem e o recurso não liberou",
      owner: null,
    });
    // 3 business days, Monday to Friday, inside 09:00-18:00 Brasília time.
    const local = new Date(ticket.response_due_at - 3 * 3600000);
    expect([1, 2, 3, 4, 5]).toContain(local.getUTCDay());
    expect(ticket.response_due_at - ticket.created).toBeGreaterThanOrEqual(
      3 * 86400000,
    );
    expect((await latest(c.id)).text).toContain(`Protocolo: ${ticket.number}`);
    await say("menu");
    await say("3");
    c = (await one(env, "SELECT * FROM conversations WHERE id=?", c.id))!;
    expect(c).toMatchObject({
      state: "waiting",
      department_id: "central-setor-contratos",
    });
  });
  it("usa o bot informado, depois o atendente da área, depois o primeiro bot habilitado", async () => {
    const informed = await fixture(),
      first = await bot(informed, true, "Primeiro"),
      chosen = await bot(informed, false, "Escolhido");
    let result = await apply(informed, { bot_id: chosen });
    expect(result.bot_id).toBe(chosen);
    expect(result.pending.map((p: any) => p.code)).toContain("bot_disabled");
    let help = children(
      (await settings(env, informed.profile)).menus,
      "central-menu-ajuda",
    );
    expect(
      help
        .slice(0, 9)
        .every((m: any) => m.type === "bot" && m.bot_id === chosen),
    ).toBe(true);
    expect(help[0]).not.toHaveProperty("content");
    expect(first).not.toBe(chosen);

    const attendant = await fixture();
    await bot(attendant, true, "Outro");
    const own = await bot(attendant, true, "Atendente");
    await configure(attendant, { attendant_bot: own });
    result = await apply(attendant);
    expect(result.bot_id).toBe(own);
    expect(result.pending.map((p: any) => p.code)).not.toContain("bot_missing");
    expect(result.pending.map((p: any) => p.code)).not.toContain(
      "attendant_bot",
    );

    const fallback = await fixture();
    await bot(fallback, false, "Desabilitado");
    const enabled = await bot(fallback, true, "Habilitado");
    result = await apply(fallback);
    expect(result.bot_id).toBe(enabled);
    help = children(
      (await settings(env, fallback.profile)).menus,
      "central-menu-ajuda",
    );
    expect(help[8]).toMatchObject({ type: "bot", bot_id: enabled });

    // A bot of another area is refused and nothing is written.
    const stranger = await fixture();
    await expect(apply(stranger, { bot_id: enabled })).rejects.toThrow(
      "Bot não pertence",
    );
    expect((await settings(env, stranger.profile)).menus).toEqual([]);
  });
  it("merge não altera nem remove o que existe e só grava textos e prazo no padrão", async () => {
    const f = await fixture();
    const mine = {
      departments: [
        { id: "financeiro", name: "Financeiro", members: [f.member.id] },
        {
          id: "central-setor-suporte",
          name: "Meu suporte",
          members: [f.other.id],
        },
      ],
      ticket_categories: [
        { id: "central-cat-printher", name: "Printher PRO", enabled: false },
        { id: "interno", name: "Interno" },
      ],
      menus: [
        { id: "meu", label: "Meu item", type: "content", content: "Texto meu" },
        {
          id: "central-menu-protocolos",
          label: "Acompanhar pedidos",
          type: "protocols",
        },
      ],
      instructions: "Minhas orientações.",
      protocol_response_hours: 12,
      protocol_confirmation: "Recebido: {numero}",
      menu_greeting: "Bem-vindo ao meu atendimento.",
    };
    await configure(f, mine);
    const before = await settings(env, f.profile);
    const result = await apply(f, { mode: "merge" });
    const cfg = await settings(env, f.profile);
    expect(result.kept).toEqual({
      departments: ["central-setor-suporte"],
      categories: ["central-cat-printher"],
      menus: ["central-menu-protocolos"],
      settings: [
        "protocol_response_unit",
        "protocol_response_days",
        "business_hours",
        "instructions",
        "protocol_confirmation",
        "menu_greeting",
      ],
    });
    expect(result.created.settings).toEqual([]);
    expect(result.created.departments).toHaveLength(3);
    expect(result.created.categories).toHaveLength(8);
    expect(result.created.menus).toHaveLength(wanted.menus.length - 1);
    // Everything that existed is byte-for-byte the same and still first.
    expect(cfg.departments.slice(0, 2)).toEqual(before.departments);
    expect(cfg.ticket_categories.slice(0, 2)).toEqual(before.ticket_categories);
    expect(cfg.menus.slice(0, 2)).toEqual(before.menus);
    expect(cfg).toMatchObject({
      instructions: "Minhas orientações.",
      protocol_response_unit: "hours",
      protocol_response_hours: 12,
      protocol_confirmation: "Recebido: {numero}",
      menu_greeting: "Bem-vindo ao meu atendimento.",
      business_hours: before.business_hours,
    });
    expect(
      result.pending
        .filter((p: any) => p.code === "department_members")
        .map((p: any) => p.department_id),
    ).toEqual([
      "central-setor-contratos",
      "central-setor-comercial",
      "central-setor-compras",
    ]);
  });
  it("aplicar de novo é idempotente nos dois modos", async () => {
    const f = await fixture();
    await apply(f);
    const once = await one(
      env,
      "SELECT settings FROM profiles WHERE id=?",
      f.profile,
    );
    const again = await apply(f);
    expect(Object.values(again.created).flat()).toEqual([]);
    expect(again.kept.menus).toEqual(ids(wanted.menus));
    expect(again.kept.settings).toHaveLength(6);
    expect(
      json(
        (await one(env, "SELECT settings FROM profiles WHERE id=?", f.profile))
          .settings,
      ),
    ).toEqual(json(once.settings));
    const replaced = await apply(f, { mode: "replace" });
    expect(Object.values(replaced.created).flat()).toEqual([]);
    expect(Object.values(replaced.removed).flat()).toEqual([]);
    expect(replaced.replaced.menus).toEqual(ids(wanted.menus));
    expect(
      json(
        (await one(env, "SELECT settings FROM profiles WHERE id=?", f.profile))
          .settings,
      ),
    ).toEqual(json(once.settings));
    await apply(f, { mode: "replace" });
    expect(
      json(
        (await one(env, "SELECT settings FROM profiles WHERE id=?", f.profile))
          .settings,
      ),
    ).toEqual(json(once.settings));
  });
  it("replace substitui menus, setores, categorias, prazo e textos, sem tocar conversas e protocolos", async () => {
    const f = await fixture(),
      botId = await bot(f);
    await configure(f, {
      attendant_bot: botId,
      departments: [
        { id: "financeiro", name: "Financeiro", members: [f.member.id] },
        {
          id: "central-setor-suporte",
          name: "Meu suporte",
          members: [f.other.id],
        },
      ],
      ticket_categories: [{ id: "interno", name: "Interno" }],
      apps: [{ id: "loja", name: "Loja", url: "https://example.com/loja" }],
      menus: [
        { id: "meu", label: "Meu item", type: "content", content: "Texto meu" },
        {
          id: "fin",
          label: "Financeiro",
          type: "human",
          department_id: "financeiro",
        },
        { id: "app", label: "Loja", type: "app", app_id: "loja" },
      ],
      instructions: "Minhas orientações.",
      protocol_response_hours: 12,
      protocol_confirmation: "Recebido: {numero}",
      business_hours: {
        days: [1, 2],
        start: "10:00",
        end: "12:00",
        holidays: ["2026-12-25"],
      },
      surveys_enabled: true,
    });
    const c = await receive(f, f.line, "pedido");
    await exec(
      env,
      "UPDATE conversations SET department_id='financeiro' WHERE id=?",
      c.id,
    );
    const ticketId = uid();
    await exec(
      env,
      "INSERT INTO tickets(id,number,profile_id,conversation_id,title,category,response_due_at,created,updated) VALUES(?,?,?,?,?,?,?,?,?)",
      ticketId,
      "WA-R-" + ticketId.slice(0, 6),
      f.profile,
      c.id,
      "Antigo",
      "interno",
      now() + 3600000,
      now(),
      now(),
    );
    const untouched = {
      conversation: await one(
        env,
        "SELECT * FROM conversations WHERE id=?",
        c.id,
      ),
      ticket: await one(env, "SELECT * FROM tickets WHERE id=?", ticketId),
    };
    const result = await apply(f, { mode: "replace" });
    expect(result).toMatchObject({ mode: "replace", bot_id: botId });
    expect(result.removed).toEqual({
      departments: ["financeiro"],
      categories: ["interno"],
      menus: ["meu", "fin", "app"],
      settings: [],
    });
    expect(result.replaced.departments).toEqual(["central-setor-suporte"]);
    expect(result.created.departments).toHaveLength(3);
    expect(result.replaced.settings).toEqual([
      "protocol_response_unit",
      "business_hours",
      "instructions",
      "protocol_confirmation",
      "menu_greeting",
    ]);
    expect(result.kept.settings).toEqual(["protocol_response_days"]);
    const cfg = await settings(env, f.profile);
    expect(ids(cfg.menus)).toEqual(ids(wanted.menus));
    expect(ids(cfg.ticket_categories)).toEqual(ids(wanted.ticket_categories));
    expect(cfg.departments).toEqual(
      wanted.departments.map((d) => ({
        ...d,
        // People already placed in a department of the template stay there.
        members: d.id === "central-setor-suporte" ? [f.other.id] : [],
      })),
    );
    expect(cfg).toMatchObject({
      instructions: wanted.instructions,
      protocol_confirmation: defaultProtocolConfirmation,
      protocol_response_unit: "business_days",
      protocol_response_days: 3,
      // The administrator's holiday calendar is kept.
      business_hours: {
        days: [1, 2, 3, 4, 5],
        start: "09:00",
        end: "18:00",
        holidays: ["2026-12-25"],
      },
      // Not part of the template.
      attendant_bot: botId,
      surveys_enabled: true,
      protocol_response_hours: 12,
      apps: [{ id: "loja" }],
    });
    expect(children(cfg.menus, "central-menu-ajuda")[0]).toMatchObject({
      type: "bot",
      bot_id: botId,
    });
    expect(
      await one(env, "SELECT * FROM conversations WHERE id=?", c.id),
    ).toEqual(untouched.conversation);
    expect(
      await one(env, "SELECT * FROM tickets WHERE id=?", ticketId),
    ).toEqual(untouched.ticket);
    expect(
      result.pending
        .filter((p: any) => p.code === "department_members")
        .map((p: any) => p.department_id),
    ).toEqual([
      "central-setor-contratos",
      "central-setor-comercial",
      "central-setor-compras",
    ]);
  });
  it("merge deixa de fora o ramo cujo id de pai foi reutilizado para outra coisa", async () => {
    const f = await fixture();
    await configure(f, {
      menus: [
        {
          id: "central-menu-ajuda",
          label: "Ajuda",
          type: "content",
          content: "Fale com a gente.",
        },
      ],
    });
    const result = await apply(f);
    expect(result.kept.menus).toEqual(["central-menu-ajuda"]);
    expect(result.skipped.menus).toHaveLength(10);
    expect(result.pending.map((p: any) => p.code)).toContain("menu_conflict");
    const cfg = await settings(env, f.profile);
    expect(children(cfg.menus, "central-menu-ajuda")).toEqual([]);
    expect(ids(children(cfg.menus, "central-menu-servicos"))).toHaveLength(4);
  });
  it("passa pela mesma validação das configurações e não grava nada quando ela recusa", async () => {
    const f = await fixture();
    await configure(f, {
      menus: Array.from({ length: 180 }, (_, i) => ({
        id: "item-" + i,
        label: "Item " + i,
        type: "content",
        content: "Texto " + i,
      })),
    });
    const before = (
      await one(env, "SELECT settings FROM profiles WHERE id=?", f.profile)
    ).settings;
    await expect(apply(f)).rejects.toThrow("menus");
    expect(
      (await one(env, "SELECT settings FROM profiles WHERE id=?", f.profile))
        .settings,
    ).toBe(before);
    await expect(apply(f, { mode: "overwrite" })).rejects.toThrow(
      "Modo inválido",
    );
    await expect(
      perform(
        env,
        f.admin,
        f.profile,
        "service-template.apply",
        { id: "inexistente" },
        uid(),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("só administrador aplica, com Idempotency-Key, e a repetição devolve o mesmo resumo", async () => {
    const f = await fixture(),
      admin = await bearer(f.admin),
      operator = await bearer(f.member),
      app = await application(f, ["conversations:read", "conversations:write"]),
      path = `/profiles/${f.profile}/service-templates/central-aplicativos/apply`;
    await expect(apply(f, {}, f.member)).rejects.toMatchObject({ status: 403 });
    expect((await api(operator, path, "POST", {})).status).toBe(403);
    expect((await api(app.token, path, "POST", {})).status).toBe(403);
    expect((await settings(env, f.profile)).menus).toEqual([]);
    // Administrator of the installation without the header.
    const missing = await SELF.fetch("https://test/api/v1" + path, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + admin,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(missing.status).toBe(400);
    const key = uid();
    const first = await api(admin, path, "POST", { mode: "merge" }, key);
    expect(first.status).toBe(200);
    const summary = await first.json<any>();
    expect(summary.created.menus).toHaveLength(wanted.menus.length);
    const replay = await api(admin, path, "POST", { mode: "merge" }, key);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await replay.json()).toEqual(summary);
    expect(
      (await api(admin, path, "POST", { mode: "replace" }, key)).status,
    ).toBe(409);
    expect(
      (
        await api(
          admin,
          `/profiles/${f.profile}/service-templates/outro/apply`,
          "POST",
          {},
        )
      ).status,
    ).toBe(404);
    expect(
      await all(
        env,
        "SELECT operation FROM audit WHERE profile_id=? AND operation='service-template.apply' AND resource_id='central-aplicativos'",
        f.profile,
      ),
    ).toHaveLength(1);
  });
});
