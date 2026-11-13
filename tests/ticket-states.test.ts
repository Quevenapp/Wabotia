import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { json, now, uid, type Actor } from "../src/types";
import {
  conversation,
  handoff,
  inbound,
  openTicket,
  perform,
} from "../src/service";
import { processInbox } from "../src/engine";
import { processPush, prunePush, PUSH_LOG_RETENTION_MS } from "../src/push";
import { lookupProtocols, protocolSummary } from "../src/protocol-lookup";
import {
  activeTicketSql,
  isActiveTicket,
  ticketStatuses,
} from "../src/protocols";
import {
  api,
  application,
  bearer,
  claim,
  configure,
  drain,
  fixture,
  receive,
  tickets,
  type Fixture,
} from "./service-center-fixture";

const update = (f: Fixture, actor: Actor, id: string, body: any) =>
  perform(env, actor, f.profile, "ticket.update", { id, ...body }, uid());
const status = async (id: string) =>
  (await one(env, "SELECT status FROM tickets WHERE id=?", id)).status;
const ticketEvents = async (f: Fixture, id: string) =>
  (
    await all(
      env,
      "SELECT payload FROM events WHERE profile_id=? AND kind='ticket.updated' AND resource_id=? ORDER BY id",
      f.profile,
      id,
    )
  ).map((row) => json(row.payload));
/** One conversation owned by `member`, with a protocol opened by the team. */
async function owned(f: Fixture, phone = "5511999998888") {
  const c = await receive(f, f.line, "pedido", phone);
  await claim(f, f.member, c.id);
  const ticket = await openTicket(
    env,
    await conversation(env, c.id, f.profile),
    f.member.id,
    "Pedido",
  );
  return { c, ticket };
}
async function insertTicket(
  f: Fixture,
  conversationId: string,
  state: string,
  extra: { due?: number | null; category?: string | null } = {},
) {
  const id = uid();
  await exec(
    env,
    "INSERT INTO tickets(id,number,profile_id,conversation_id,title,status,response_due_at,category,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)",
    id,
    "WA-T-" + id.slice(0, 8).toUpperCase(),
    f.profile,
    conversationId,
    "Estado " + state,
    state,
    extra.due === undefined ? now() - 60000 : extra.due,
    extra.category || null,
    now(),
    now(),
  );
  return id;
}

describe("seis estados do protocolo", () => {
  it("define ativo como diferente de resolved e closed", () => {
    expect(ticketStatuses).toEqual([
      "open",
      "in_progress",
      "waiting_customer",
      "waiting_third",
      "resolved",
      "closed",
    ]);
    expect(ticketStatuses.filter(isActiveTicket)).toEqual([
      "open",
      "in_progress",
      "waiting_customer",
      "waiting_third",
    ]);
    expect(activeTicketSql("t.")).toBe("t.status NOT IN ('resolved','closed')");
  });
  it("aceita qualquer transição entre os seis estados e recusa estado desconhecido", async () => {
    const f = await fixture(),
      { ticket } = await owned(f);
    for (const from of ticketStatuses)
      for (const to of ticketStatuses) {
        await exec(
          env,
          "UPDATE tickets SET status=? WHERE id=?",
          from,
          ticket.id,
        );
        const saved = await update(f, f.member, ticket.id, { status: to });
        expect(saved.status).toBe(to);
      }
    await expect(
      update(f, f.member, ticket.id, { status: "paused" }),
    ).rejects.toThrow("Estado inválido");
    const events = await ticketEvents(f, ticket.id);
    expect(events).toHaveLength(36);
    expect(events.at(-1)).toMatchObject({
      status: "closed",
      previous_status: "closed",
      actor: f.member.id,
    });
  });
  it("mantém as permissões: só o responsável ou um administrador altera", async () => {
    const f = await fixture(),
      { ticket } = await owned(f);
    await expect(
      update(f, f.other, ticket.id, { status: "waiting_third" }),
    ).rejects.toThrow("Somente o responsável");
    expect(
      (await update(f, f.admin, ticket.id, { status: "waiting_third" })).status,
    ).toBe("waiting_third");
  });
  it("só permite mudar o prazo de um protocolo ativo e sem primeira resposta", async () => {
    const f = await fixture(),
      { ticket } = await owned(f);
    const due = now() + 3600000;
    for (const state of ["waiting_customer", "waiting_third"]) {
      await update(f, f.member, ticket.id, { status: state });
      expect(
        (await update(f, f.member, ticket.id, { response_due_at: due }))
          .response_due_at,
      ).toBe(due);
    }
    for (const state of ["resolved", "closed"]) {
      await update(f, f.member, ticket.id, { status: state });
      await expect(
        update(f, f.member, ticket.id, { response_due_at: due + 1 }),
      ).rejects.toThrow("prazo");
    }
  });
});

describe("regra de protocolo ativo", () => {
  it("a abertura automática reaproveita o protocolo ativo e abre outro quando ele está resolvido ou encerrado", async () => {
    const f = await fixture();
    const c = await receive(f, f.line, "preciso de uma pessoa");
    // Nobody is present: the handoff opens a protocol.
    await handoff(env, c, "Sem equipe");
    const [first] = await tickets(c.id);
    expect(first.status).toBe("open");
    for (const state of ["in_progress", "waiting_customer", "waiting_third"]) {
      await exec(
        env,
        "UPDATE tickets SET status=? WHERE id=?",
        state,
        first.id,
      );
      await handoff(
        env,
        await conversation(env, c.id, f.profile),
        "Sem equipe",
      );
      expect(await tickets(c.id)).toHaveLength(1);
    }
    await exec(
      env,
      "UPDATE tickets SET status='resolved' WHERE id=?",
      first.id,
    );
    await handoff(env, await conversation(env, c.id, f.profile), "De novo");
    const second = (await tickets(c.id)).filter((t) => t.id !== first.id);
    expect(second).toHaveLength(1);
    await exec(
      env,
      "UPDATE tickets SET status='closed' WHERE id=?",
      second[0].id,
    );
    await handoff(env, await conversation(env, c.id, f.profile), "Terceira");
    expect(await tickets(c.id)).toHaveLength(3);
  });
  it("assumir a conversa torna a pessoa responsável só pelos protocolos ativos sem dono", async () => {
    const f = await fixture(),
      c = await receive(f, f.line, "pedido");
    const ids: Record<string, string> = {};
    for (const state of ticketStatuses)
      ids[state] = await insertTicket(f, c.id, state);
    await claim(f, f.member, c.id);
    for (const state of ticketStatuses)
      expect(
        (await one(env, "SELECT owner FROM tickets WHERE id=?", ids[state]))
          .owner,
      ).toBe(isActiveTicket(state) ? f.member.id : null);
    // Sending the conversation back to the queue releases only the active ones.
    await exec(
      env,
      "UPDATE tickets SET owner=? WHERE profile_id=?",
      f.member.id,
      f.profile,
    );
    await handoff(env, await conversation(env, c.id, f.profile), "Fila");
    for (const state of ticketStatuses)
      expect(
        (await one(env, "SELECT owner FROM tickets WHERE id=?", ids[state]))
          .owner,
      ).toBe(isActiveTicket(state) ? null : f.member.id);
  });
  it("a resposta humana marca a primeira resposta só nos protocolos ativos", async () => {
    const f = await fixture(),
      c = await receive(f, f.line, "pedido");
    const ids: Record<string, string> = {};
    for (const state of ticketStatuses)
      ids[state] = await insertTicket(f, c.id, state);
    await claim(f, f.member, c.id);
    await perform(
      env,
      f.member,
      f.profile,
      "conversation.action",
      { id: c.id, action: "reply", text: "Olá, já estou vendo." },
      uid(),
    );
    for (const state of ticketStatuses) {
      const row = await one(
        env,
        "SELECT first_response_at FROM tickets WHERE id=?",
        ids[state],
      );
      if (isActiveTicket(state)) expect(row.first_response_at).toBeTruthy();
      else expect(row.first_response_at).toBeNull();
    }
  });
});

describe("retorno automático de waiting_customer", () => {
  it("volta para in_progress quando o cliente escreve e gera um único ticket.updated", async () => {
    const f = await fixture(),
      { c, ticket } = await owned(f);
    await update(f, f.member, ticket.id, { status: "waiting_customer" });
    const other = await insertTicket(f, c.id, "waiting_third");
    const before = (await ticketEvents(f, ticket.id)).length;
    const message = uid();
    const send = () =>
      inbound(
        env,
        f.profile,
        {
          external_id: "5511999998888",
          phone: "5511999998888",
          message_id: message,
          text: "Segue o comprovante",
        },
        `channel:${f.line}`,
        f.line,
      );
    const received = await send();
    expect(await status(ticket.id)).toBe("in_progress");
    expect(await status(other)).toBe("waiting_third");
    const events = await ticketEvents(f, ticket.id);
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)).toEqual({
      status: "in_progress",
      previous_status: "waiting_customer",
      owner: f.member.id,
      previous_owner: f.member.id,
      text_added: false,
      actor: "system",
      number: ticket.number,
      reason: "customer_message",
      conversation_id: c.id,
      message_id: received.message_id,
    });
    // The provider repeats the webhook and the engine replays its repair step.
    expect((await send()).duplicate).toBe(true);
    await drain(f);
    await exec(
      env,
      "UPDATE inbox SET status='pending' WHERE conversation_id=?",
      c.id,
    );
    await processInbox(env, f.profile);
    await drain(f);
    expect(await ticketEvents(f, ticket.id)).toHaveLength(before + 1);
    // A later message finds nothing waiting and changes nothing.
    await receive(f, f.line, "obrigado");
    expect(await ticketEvents(f, ticket.id)).toHaveLength(before + 1);
    expect(await ticketEvents(f, other)).toHaveLength(0);
  });
  it("não mexe nos outros estados nem em protocolos de outra conversa", async () => {
    const f = await fixture(),
      c = await receive(f, f.line, "pedido"),
      elsewhere = await receive(f, f.line, "outro", "5511999997777");
    const ids: Record<string, string> = {};
    for (const state of ticketStatuses)
      ids[state] = await insertTicket(f, c.id, state);
    const foreign = await insertTicket(f, elsewhere.id, "waiting_customer");
    await receive(f, f.line, "resposta do cliente");
    for (const state of ticketStatuses)
      expect(await status(ids[state])).toBe(
        state === "waiting_customer" ? "in_progress" : state,
      );
    expect(await status(foreign)).toBe("waiting_customer");
  });
});

describe("prazo, alertas e filtros ignoram resolvidos e encerrados", () => {
  beforeEach(async () => {
    await exec(env, "DELETE FROM devices");
    await exec(env, "DELETE FROM secrets WHERE id='push:config'");
    vi.stubGlobal("fetch", async () => {
      throw new Error("Nenhum envio externo é esperado neste teste.");
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  const alerts = async (id: string) =>
    (
      await all(
        env,
        "SELECT kind FROM ticket_alerts WHERE ticket_id=? ORDER BY kind",
        id,
      )
    ).map((row) => row.kind);

  it("o primeiro ciclo e os alertas de prazo só consideram protocolos ativos", async () => {
    const f = await fixture(),
      c = await receive(f, f.line, "pedido");
    const old: Record<string, string> = {};
    for (const state of ticketStatuses)
      old[state] = await insertTicket(f, c.id, state);
    // First run: every active overdue protocol is marked as already alerted.
    await processPush(env, f.profile);
    for (const state of ticketStatuses)
      expect(await alerts(old[state])).toEqual(
        isActiveTicket(state) ? ["due_soon", "overdue"] : [],
      );
    const fresh: Record<string, string> = {};
    for (const state of ticketStatuses)
      fresh[state] = await insertTicket(f, c.id, state);
    const soon = await insertTicket(f, c.id, "waiting_third", {
      due: now() + 10 * 60000,
    });
    const resolvedSoon = await insertTicket(f, c.id, "resolved", {
      due: now() + 10 * 60000,
    });
    await processPush(env, f.profile);
    for (const state of ticketStatuses)
      expect(await alerts(fresh[state])).toEqual(
        isActiveTicket(state) ? ["overdue"] : [],
      );
    expect(await alerts(soon)).toEqual(["due_soon"]);
    expect(await alerts(resolvedSoon)).toEqual([]);
    // Alerts of protocols resolved or closed long ago are pruned.
    const long = now() - PUSH_LOG_RETENTION_MS - 1000;
    for (const state of ticketStatuses) {
      await exec(
        env,
        "INSERT OR IGNORE INTO ticket_alerts(ticket_id,kind,created) VALUES(?,'overdue',?)",
        old[state],
        now(),
      );
      await exec(
        env,
        "UPDATE tickets SET updated=? WHERE id=?",
        long,
        old[state],
      );
    }
    await prunePush(env);
    for (const state of ticketStatuses)
      expect((await alerts(old[state])).includes("overdue")).toBe(
        isActiveTicket(state),
      );
  });
  it("GET /tickets filtra por estado, ativos, atrasados e categoria", async () => {
    const f = await fixture(),
      token = await bearer(f.member),
      c = await receive(f, f.line, "pedido");
    await configure(f, {
      ticket_categories: [
        { id: "printher", name: "Printher" },
        { id: "vinki", name: "Vinki" },
      ],
    });
    const ids: Record<string, string> = {};
    for (const state of ticketStatuses)
      ids[state] = await insertTicket(f, c.id, state, {
        category: state === "open" || state === "resolved" ? "printher" : null,
      });
    const onTime = await insertTicket(f, c.id, "in_progress", {
      due: now() + 3600000,
      category: "vinki",
    });
    const list = async (query: string) => {
      const response = await api(
        token,
        `/profiles/${f.profile}/tickets${query}`,
      );
      expect(response.status).toBe(200);
      return ((await response.json<any>()).data as any[])
        .map((row) => row.id)
        .sort();
    };
    const sorted = (...values: string[]) => [...values].sort();
    for (const state of ticketStatuses)
      expect(await list(`?status=${state}`)).toEqual(
        sorted(
          ...(state === "in_progress" ? [ids[state], onTime] : [ids[state]]),
        ),
      );
    const active = ticketStatuses.filter(isActiveTicket).map((s) => ids[s]);
    expect(await list("?active=1")).toEqual(sorted(...active, onTime));
    expect(await list("?overdue=1")).toEqual(sorted(...active));
    expect(await list("?active=1&status=resolved")).toEqual([]);
    expect(await list("?category=printher")).toEqual(
      sorted(ids.open, ids.resolved),
    );
    expect(await list("?category=printher&active=1")).toEqual([ids.open]);
    expect(await list("?category=vinki&overdue=1")).toEqual([]);
    expect(await list("?category=desconhecida")).toEqual([]);
    expect(await list("")).toHaveLength(7);
    expect(
      (await api(token, `/profiles/${f.profile}/tickets?status=paused`)).status,
    ).toBe(400);
  });
  it("GET /tickets aceita vários estados separados por vírgula, combinados com os outros filtros", async () => {
    const f = await fixture(),
      token = await bearer(f.member),
      c = await receive(f, f.line, "pedido", "5511977776666");
    await configure(f, {
      ticket_categories: [{ id: "printher", name: "Printher" }],
    });
    const ids: Record<string, string> = {};
    for (const state of ticketStatuses)
      ids[state] = await insertTicket(f, c.id, state, {
        category:
          state === "waiting_third" || state === "closed" ? "printher" : null,
      });
    const onTime = await insertTicket(f, c.id, "waiting_customer", {
      due: now() + 3600000,
    });
    const elsewhere = await receive(f, f.line, "outro", "5511955554444");
    const other = await insertTicket(f, elsewhere.id, "resolved");
    const list = async (query: string) => {
      const response = await api(
        token,
        `/profiles/${f.profile}/tickets${query}`,
      );
      expect(response.status, query).toBe(200);
      return ((await response.json<any>()).data as any[])
        .map((row) => row.id)
        .sort();
    };
    const sorted = (...values: string[]) => [...values].sort();
    // "Resolvidos" in the apps: resolved + closed.
    expect(await list("?status=resolved,closed")).toEqual(
      sorted(ids.resolved, ids.closed, other),
    );
    expect(await list("?status=waiting_customer,waiting_third")).toEqual(
      sorted(ids.waiting_customer, ids.waiting_third, onTime),
    );
    // Order, spaces and repetition do not matter; one value is the old filter.
    expect(await list("?status=closed,%20resolved,closed")).toEqual(
      sorted(ids.resolved, ids.closed, other),
    );
    expect(await list("?status=open")).toEqual([ids.open]);
    expect(await list(`?status=${ticketStatuses.join(",")}`)).toHaveLength(8);
    // Combined with active, category, overdue and q.
    expect(await list("?status=open,resolved,closed&active=1")).toEqual([
      ids.open,
    ]);
    expect(await list("?status=resolved,closed&active=1")).toEqual([]);
    expect(
      await list("?status=waiting_third,closed,open&category=printher"),
    ).toEqual(sorted(ids.waiting_third, ids.closed));
    expect(await list("?status=waiting_customer,resolved&overdue=1")).toEqual([
      ids.waiting_customer,
    ]);
    expect(await list("?status=resolved,closed&q=5511955554444")).toEqual([
      other,
    ]);
    expect(
      await list("?status=resolved,closed&q=5511977776666&category=printher"),
    ).toEqual([ids.closed]);
    // Every item is validated against the six states.
    for (const wrong of [
      "open,paused",
      "resolved,",
      ",closed",
      "open;closed",
      "RESOLVED,closed",
      "open,,closed",
    ])
      expect(
        (
          await api(
            token,
            `/profiles/${f.profile}/tickets?status=${encodeURIComponent(wrong)}`,
          )
        ).status,
        wrong,
      ).toBe(400);
  });
});

describe("consulta do cliente com os novos estados", () => {
  it("usa os textos para o cliente e só mostra prazo de protocolo ativo", async () => {
    const f = await fixture(),
      c = await receive(f, f.line, "pedido");
    const due = now() + 3600000;
    const text = (state: string) =>
      protocolSummary([
        {
          number: "WA-X-0001",
          title: "Pedido",
          status: state,
          response_due_at: due,
          first_response_at: null,
        },
      ]);
    const labels: Record<string, string> = {
      open: "Recebido",
      in_progress: "Em análise",
      waiting_customer: "Aguardando você",
      waiting_third: "Aguardando atualização",
      resolved: "Resolvido",
      closed: "Encerrado",
    };
    for (const state of ticketStatuses) {
      expect(text(state)).toContain(`WA-X-0001 · ${labels[state]}`);
      expect(text(state).includes("Prazo de primeira resposta")).toBe(
        isActiveTicket(state),
      );
    }
    // A state this server does not know is shown as neutral text.
    expect(text("escalated")).toContain("WA-X-0001 · Em acompanhamento");
    expect(text("escalated")).not.toContain("escalated");
    await insertTicket(f, c.id, "waiting_customer");
    expect((await lookupProtocols(env, c))[0].status).toBe("waiting_customer");
  });
  it("uma aplicação sem tickets:read não lista protocolos", async () => {
    const f = await fixture(),
      app = await application(f, ["conversations:read"]);
    expect(
      (await api(app.token, `/profiles/${f.profile}/tickets?active=1`)).status,
    ).toBe(403);
  });
});
