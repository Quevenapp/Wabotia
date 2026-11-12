import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { exec } from "../src/db";
import { now, uid } from "../src/types";
import { perform } from "../src/service";
import {
  api,
  application,
  bearer,
  claim,
  fixture,
  receive,
  type Fixture,
} from "./service-center-fixture";

let clock = now() + 1000;
/** Adds a message after every other one of the conversation. */
async function message(
  f: Fixture,
  conversationId: string,
  direction: string,
  text: string,
  extra: {
    attachments?: string[];
    content?: any;
    delivery_status?: string;
  } = {},
) {
  const id = uid();
  clock = Math.max(clock, now());
  await exec(
    env,
    "INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,attachments,created,content,delivery_status) VALUES(?,?,?,?,?,?,?,?,?,?)",
    id,
    f.profile,
    conversationId,
    direction,
    direction === "customer" ? "customer:test" : f.member.id,
    text,
    JSON.stringify(extra.attachments || []),
    ++clock,
    JSON.stringify(extra.content || {}),
    extra.delivery_status || "",
  );
  return { id, created: clock };
}
async function media(f: Fixture, type: string) {
  const id = uid();
  await exec(
    env,
    "INSERT INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,?,?,?,?,?,?)",
    id,
    f.profile,
    "arquivo",
    type,
    10,
    `${f.profile}/${id}`,
    f.member.id,
    now(),
  );
  return id;
}
async function list(f: Fixture, token: string, query = "") {
  const response = await api(
    token,
    `/profiles/${f.profile}/conversations${query}`,
  );
  expect(response.status).toBe(200);
  return response.json<any>();
}
const preview = async (f: Fixture, token: string, id: string) =>
  (await list(f, token)).data.find((row: any) => row.id === id).last_message;

describe("last_message na lista de conversas", () => {
  it("traz a mensagem mais recente com direção, entrega, anexos e tipo", async () => {
    const f = await fixture(),
      token = await bearer(f.member);
    const c = await receive(f, f.line, "Primeira mensagem do cliente");
    const row = (await list(f, token)).data.find((x: any) => x.id === c.id);
    expect(row.last_message).toEqual({
      text: "Primeira mensagem do cliente",
      direction: "customer",
      created: expect.any(Number),
      delivery_status: "",
      attachments: 0,
      kind: "text",
    });
    // The conversation row itself is unchanged and no helper column leaks.
    expect(row).toMatchObject({ id: c.id, state: "ai", phone: c.phone });
    expect(Object.keys(row).filter((key) => key.startsWith("lm_"))).toEqual([]);
    const sent = await message(f, c.id, "outbound", "Já estou verificando.", {
      delivery_status: "read",
    });
    expect(await preview(f, token, c.id)).toEqual({
      text: "Já estou verificando.",
      direction: "outbound",
      created: sent.created,
      delivery_status: "read",
      attachments: 0,
      kind: "text",
    });
  });
  it("devolve null para conversa sem mensagens e corta textos longos em 300 caracteres", async () => {
    const f = await fixture(),
      token = await bearer(f.member),
      empty = uid();
    await exec(
      env,
      "INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,phone,session,last_customer,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)",
      empty,
      f.profile,
      f.line,
      `channel:${f.line}`,
      "5511900000001",
      "5511900000001",
      uid(),
      now(),
      now(),
      now(),
    );
    expect(await preview(f, token, empty)).toBeNull();
    const c = await receive(f, f.line, "á".repeat(1000));
    expect((await preview(f, token, c.id)).text).toBe("á".repeat(300));
  });
  it("resume o conteúdo em kind", async () => {
    const f = await fixture(),
      token = await bearer(f.member),
      c = await receive(f, f.line, "oi");
    const image = await media(f, "image/png"),
      pdf = await media(f, "application/pdf"),
      webp = await media(f, "image/webp");
    const cases: [any, string, number][] = [
      [{ attachments: [image] }, "image", 1],
      [{ attachments: [pdf, image] }, "document", 2],
      [{ attachments: [webp], content: { type: "text" } }, "sticker", 1],
      [{ attachments: [uid()] }, "document", 1],
      [{ attachments: [image], content: { type: "voice" } }, "audio", 1],
      [{ attachments: [pdf], content: { type: "video" } }, "video", 1],
      [{ content: { type: "location", location: {} } }, "location", 0],
      [{ content: { type: "contacts", contacts: [] } }, "contacts", 0],
      [{ content: { type: "interactive", interactive: {} } }, "interactive", 0],
      [{ content: { type: "audio" }, attachments: [image] }, "audio", 1],
      [{ content: { type: "file" }, attachments: [pdf] }, "document", 1],
      [{ content: { type: "reaction" } }, "text", 0],
      [{ content: { type: "image", deleted: true } }, "text", 0],
      [{ content: { participant: "5511" } }, "text", 0],
    ];
    for (const [extra, kind, attachments] of cases) {
      await message(f, c.id, "customer", "legenda", extra);
      expect(
        await preview(f, token, c.id),
        JSON.stringify(extra),
      ).toMatchObject({ kind, attachments, text: "legenda" });
    }
  });
  it("só mostra nota interna a quem pode ler notas", async () => {
    const f = await fixture(),
      person = await bearer(f.member),
      reader = await application(f, ["conversations:read", "notes:read"]),
      plain = await application(f, ["conversations:read"]);
    const c = await receive(f, f.line, "Preciso de ajuda com a nota fiscal");
    await claim(f, f.member, c.id);
    await perform(
      env,
      f.member,
      f.profile,
      "conversation.action",
      { id: c.id, action: "note", text: "Cliente já ligou duas vezes." },
      uid(),
    );
    const note = {
      text: "Cliente já ligou duas vezes.",
      direction: "note",
      kind: "text",
    };
    expect(await preview(f, person, c.id)).toMatchObject(note);
    expect(await preview(f, reader.token, c.id)).toMatchObject(note);
    // Without notes:read the preview is the latest message that is not a note.
    expect(await preview(f, plain.token, c.id)).toMatchObject({
      text: "Preciso de ajuda com a nota fiscal",
      direction: "customer",
    });
    // A conversation holding only notes has no preview for that caller.
    const only = uid();
    await exec(
      env,
      "INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,phone,session,last_customer,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)",
      only,
      f.profile,
      f.line,
      `channel:${f.line}`,
      "5511900000002",
      "5511900000002",
      uid(),
      now(),
      now(),
      now(),
    );
    await message(f, only, "note", "Só uma anotação");
    expect(await preview(f, plain.token, only)).toBeNull();
    expect(await preview(f, person, only)).toMatchObject({ direction: "note" });
    // No conversation is dropped from the page because of the note filter.
    expect((await list(f, plain.token)).data).toHaveLength(2);
  });
  it("mantém a paginação por cursor, a ordem e os filtros", async () => {
    const f = await fixture(),
      token = await bearer(f.member);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const c = await receive(f, f.line, `mensagem ${i}`, "55119000001" + i);
      await exec(
        env,
        "UPDATE conversations SET updated=? WHERE id=?",
        1000 + (i === 3 ? 2 : i),
        c.id,
      );
      ids.push(c.id);
    }
    // Conversations 2 and 3 share `updated`: the id breaks the tie.
    const order = [...ids].sort((a, b) => {
      const at = (id: string) => (ids.indexOf(id) === 3 ? 2 : ids.indexOf(id));
      return at(b) - at(a) || (a < b ? 1 : -1);
    });
    const seen: any[] = [];
    let cursor: string | null = null,
      pages = 0;
    do {
      const page: any = await list(
        f,
        token,
        `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(page.data.length).toBeLessThanOrEqual(2);
      seen.push(...page.data);
      cursor = page.next_cursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen.map((row) => row.id)).toEqual(order);
    for (const row of seen)
      expect(row.last_message.text).toBe(`mensagem ${ids.indexOf(row.id)}`);
    const found = await list(f, token, "?q=551190000013&state=ai");
    expect(found.data.map((row: any) => row.id)).toEqual([ids[3]]);
    expect(found.data[0].last_message.text).toBe("mensagem 3");
    expect((await list(f, token, "?state=human")).data).toEqual([]);
    expect(
      (await api(token, `/profiles/${f.profile}/conversations?cursor=%25`))
        .status,
    ).toBe(400);
  });
});
