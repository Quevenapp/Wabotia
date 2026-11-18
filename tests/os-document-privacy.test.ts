import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, exec } from "../src/db";
import { authorizedMedia } from "../src/media";
import { now, uid, type Actor } from "../src/types";
import { hex } from "../src/security";
import { onBinaryRead, onRead } from "../src/modules/api";
import * as motor from "../src/modules/os/public";
import {
  projectChildForBot,
  projectChildForCustomer,
} from "../src/modules/os/privacy";
import { documentsExtension } from "../src/modules/os/documents/extension";
import {
  documentMetadata,
  objectKey,
  UPLOAD_TTL,
  type DocumentRow,
} from "../src/modules/os/documents/model";
import {
  listDocuments,
  reserveDocument,
} from "../src/modules/os/documents/store";
import {
  downloadDocument,
  uploadHandler,
} from "../src/modules/os/documents/transport";
import { receiveDocument, sendDocument } from "../src/modules/os/documents/delivery";
import { api, receive } from "./service-center-fixture";
import {
  MOTOR_SENTINEL,
  motorFixture,
  motorOrder,
  motorWorkType,
} from "./os-motor-fixture";

// Registro só deste isolado de teste; não altera arquivos centrais.
for (const route of documentsExtension.reads)
  onRead("os", route.path, route.handler);
for (const route of documentsExtension.binaryReads!)
  onBinaryRead("os", route.path, route.handler);
afterEach(() => vi.restoreAllMocks());
const SECRET_NAME = `D_NOME_${MOTOR_SENTINEL}.pdf`;
const SECRET_BYTES = `D_CONTEUDO_${MOTOR_SENTINEL}`;

async function setup() {
  const f = await motorFixture();
  const order = await motorOrder(f);
  await exec(
    env,
    "CREATE UNIQUE INDEX IF NOT EXISTS os_document_privacy_test_parent ON os_orders(profile_id,id)",
  );
  const authorize = motor.authorizedOrder;
  vi.spyOn(motor, "authorizedOrder").mockImplementation(async (...args) => ({
    ...(await authorize(...args)),
    type: motorWorkType(),
  }));
  const privileged: Actor = { ...f.member, access: ["*", "os:sensitive"] };
  const at = now();
  const row: DocumentRow = {
    id: uid(),
    order_id: order.id,
    profile_id: f.profile,
    name: SECRET_NAME,
    mime_type: "application/pdf",
    expected_bytes: new TextEncoder().encode(SECRET_BYTES).length,
    byte_length: new TextEncoder().encode(SECRET_BYTES).length,
    sha256: hex(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(SECRET_BYTES),
      ),
    ),
    r2_key: null,
    state: "ready",
    upload_attempt: uid(),
    upload_request_key: uid(),
    upload_lease_until: null,
    upload_expires_at: at + UPLOAD_TTL,
    source_message_id: null,
    source_media_id: null,
    client_visible: 0,
    sensitive: 1,
    version: 2,
    created_by: privileged.id,
    created: at,
    updated: at,
    archived_at: null,
  };
  row.r2_key = objectKey(row, row.upload_attempt!);
  await env.MEDIA.put(row.r2_key, SECRET_BYTES, {
    customMetadata: { sha256: row.sha256! },
  });
  await exec(
    env,
    `INSERT INTO os_documents (${Object.keys(row).join(",")}) VALUES (${Object.keys(
      row,
    )
      .map(() => "?")
      .join(",")})`,
    ...Object.values(row),
  );
  return { ...f, order, privileged, row };
}

describe("documentos: sigilo independente de bot.masked e de nomes de campos", () => {
  it("telefone corrigido revoga envio, consulta e recebimento pela conversa antiga, mesmo vinculada", async () => {
    const f = await setup();
    vi.spyOn(f.ctx, "settings").mockResolvedValue({ os_work_types: [motorWorkType()] });
    const old = await receive(f, f.line, "oi", "5511960010203");
    const current = await receive(f, f.line, "oi", "5511960010999");
    await exec(env,
      "UPDATE os_orders SET conversation_id=?,phone=? WHERE profile_id=? AND id=?",
      old.id, "5511960010999", f.profile, f.order.id,
    );
    const sharedBytes = new TextEncoder().encode("Documento público");
    const shared = {
      ...f.row, id: uid(), name: "Público.pdf", sensitive: 0, client_visible: 1,
      upload_attempt: uid(), upload_request_key: uid(),
      expected_bytes: sharedBytes.length, byte_length: sharedBytes.length,
      sha256: hex(await crypto.subtle.digest("SHA-256", sharedBytes)),
    };
    // Documento público independente: não reutilizar chave nem conteúdo sensível.
    shared.r2_key = objectKey(shared, shared.upload_attempt);
    await env.MEDIA.put(shared.r2_key, sharedBytes, {
      customMetadata: { sha256: shared.sha256 },
    });
    await exec(env,
      `INSERT INTO os_documents (${Object.keys(shared).join(",")}) VALUES (${Object.keys(shared).map(() => "?").join(",")})`,
      ...Object.values(shared),
    );
    const get = vi.fn(env.MEDIA.get.bind(env.MEDIA));
    f.ctx = { ...f.ctx, env: { ...f.ctx.env, MEDIA: { get } as unknown as R2Bucket } };
    const media = vi.spyOn(f.ctx, "outgoingAttachment");
    const commits = vi.spyOn(motor, "commitChild");
    const open = vi.fn(async () => { throw new Error("Anexo de outro titular"); });
    vi.spyOn(f.ctx, "inboundAttachments").mockResolvedValue([
      { id: uid(), name: "Entrada.pdf", mime_type: "application/pdf", byte_length: 3, open },
    ]);
    const message = vi.spyOn(f.ctx, "sendMessage").mockResolvedValue("resposta");
    for (const phone of ["5511960010203", null]) {
      const verified = vi.spyOn(f.ctx, "verifiedPhone").mockReturnValue(phone);
      await expect(listDocuments(f.ctx, f.member, f.order.id, {}, { conversation_id: old.id }))
        .rejects.toMatchObject({ code: "not_found" });
      await expect(downloadDocument(f.ctx, f.member, f.order.id, shared.id, { conversation_id: old.id }))
        .rejects.toMatchObject({ code: "not_found" });
      await expect(sendDocument(f.ctx, f.member, f.order.id, shared.id, 2))
        .rejects.toMatchObject({ code: "not_found" });
      const handled = await receiveDocument(f.ctx, old, {
        text: `DOCUMENTO ${f.order.number}`, replyId: null, rowId: uid(),
      });
      expect(handled).toBe(phone !== null);
      verified.mockRestore();
    }
    expect(get).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(media).not.toHaveBeenCalled();
    expect(commits).not.toHaveBeenCalled();
    expect(message).toHaveBeenCalledTimes(1);
    expect(message.mock.calls[0][1].text).not.toContain(shared.name);
    const denied = await api(f.token,
      `/profiles/${f.profile}/service-orders/conversation/${old.id}/orders/${f.order.id}/documents`,
    );
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain(shared.name);
    const page = await listDocuments(f.ctx, f.member, f.order.id, {}, { conversation_id: current.id });
    expect(page.data.map((row) => row.id)).toEqual([shared.id]);
  });

  it("não revela documento sensível na rota comum, nem para quem tem o papel", async () => {
    const f = await setup();
    expect(await listDocuments(f.ctx, f.privileged, f.order.id)).toEqual({
      data: [],
      next_cursor: null,
    });
    await expect(
      downloadDocument(f.ctx, f.privileged, f.order.id, f.row.id),
    ).rejects.toMatchObject({ code: "not_found" });
    const root = `/profiles/${f.profile}/service-orders/${f.order.id}/documents`;
    const common = await api(f.token, root);
    expect(common.status).toBe(200);
    expect(await common.json()).toEqual({ data: [], next_cursor: null });
    const denied = await api(f.token, `${root}/${f.row.id}/content`);
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain(MOTOR_SENTINEL);
    const anonymous = await api("", `${root}/${f.row.id}/content`);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.text()).not.toContain(MOTOR_SENTINEL);
    // Nenhum registro de mídia comum, portanto nenhum endpoint /media resolve o documento.
    await expect(
      authorizedMedia(env, f.privileged, f.profile, f.row.id),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      await all(env, "SELECT * FROM media WHERE profile_id=?", f.profile),
    ).toEqual([]);
    const hidden = projectChildForBot(documentMetadata(f.row));
    expect(hidden).toBeNull();
    expect(projectChildForCustomer(documentMetadata(f.row))).toBeNull();
  });

  it("autoriza pessoa com papel explícito somente na rota privada", async () => {
    const f = await setup();
    const privatePage = await listDocuments(
      f.ctx,
      f.privileged,
      f.order.id,
      {},
      { private: true },
    );
    expect(privatePage.data[0].name).toBe(SECRET_NAME);
    const binary = await downloadDocument(
      f.ctx,
      f.privileged,
      f.order.id,
      f.row.id,
      { private: true },
    );
    expect(await new Response(binary.body).text()).toBe(SECRET_BYTES);
    expect(new Headers(binary.headers).get("Cache-Control")).toBe("no-store");
    expect(new Headers(binary.headers).get("Content-Disposition")).toContain(
      "attachment;",
    );
    expect(f.row.r2_key).toContain("/sensitive/");
    for (const actor of [f.member, f.admin]) {
      await expect(
        listDocuments(f.ctx, actor, f.order.id, {}, { private: true }),
      ).rejects.toMatchObject({ code: "sensitive_forbidden" });
      await expect(
        downloadDocument(f.ctx, actor, f.order.id, f.row.id, { private: true }),
      ).rejects.toMatchObject({ code: "sensitive_forbidden" });
    }
  });

  it("bloqueia app, conector, bot e via com ou sem máscara antes de abrir R2", async () => {
    const f = await setup();
    const get = vi.fn(env.MEDIA.get.bind(env.MEDIA));
    const ctx = {
      ...f.ctx,
      env: { ...env, MEDIA: { get } as unknown as R2Bucket },
    };
    const actors: Actor[] = [
      {
        ...f.privileged,
        kind: "app",
        scopes: ["conversations:read", "conversations:write"],
      },
      { ...f.privileged, kind: "connector" },
      { ...f.privileged, id: "bot:teste" },
      { ...f.privileged, module: { id: "os", reach: [] } },
      ...[true, false].map((masked): Actor => ({
        ...f.privileged,
        via: { kind: "bot", bot_id: "bot", run_id: "run", masked },
      })),
    ];
    for (const actor of actors) {
      expect(await listDocuments(ctx, actor, f.order.id)).toEqual({
        data: [],
        next_cursor: null,
      });
      await expect(
        downloadDocument(ctx, actor, f.order.id, f.row.id, { private: true }),
      ).rejects.toMatchObject({ code: "sensitive_forbidden" });
      await expect(
        uploadHandler(true).authorize(ctx, actor, {
          params: { id: f.order.id, document_id: f.row.id },
          query: {},
          request: new Request("https://test.invalid"),
        }),
      ).rejects.toMatchObject({ code: "sensitive_forbidden" });
      await expect(
        reserveDocument(
          ctx,
          actor,
          f.order.id,
          {
            name: SECRET_NAME,
            mime_type: "application/pdf",
            expected_bytes: 3,
            sensitive: true,
            client_visible: false,
          },
          uid(),
          { private: true },
        ),
      ).rejects.toMatchObject({ code: "sensitive_forbidden" });
    }
    expect(get).not.toHaveBeenCalled();
  });

  it("recusa reserva sensível pelo comando comum e impede encaminhamento a mídia/WhatsApp", async () => {
    const f = await setup();
    const media = vi.spyOn(f.ctx, "outgoingAttachment");
    const messages = vi.spyOn(f.ctx, "sendMessage");
    const commits = vi.spyOn(motor, "commitChild");
    await expect(
      reserveDocument(
        f.ctx,
        f.privileged,
        f.order.id,
        {
          name: SECRET_NAME,
          mime_type: "application/pdf",
          expected_bytes: 3,
          sensitive: true,
          client_visible: false,
        },
        uid(),
      ),
    ).rejects.toMatchObject({ code: "sensitive_forbidden" });
    await expect(
      sendDocument(f.ctx, f.privileged, f.order.id, f.row.id, 2),
    ).rejects.toMatchObject({ code: "document_not_shareable" });
    expect(media).not.toHaveBeenCalled();
    expect(messages).not.toHaveBeenCalled();
    expect(commits).not.toHaveBeenCalled();
    for (const table of ["events", "os_history", "messages", "media"]) {
      const rows = await all(
        env,
        `SELECT * FROM ${table} WHERE profile_id=?`,
        f.profile,
      );
      expect(JSON.stringify(rows)).not.toContain(MOTOR_SENTINEL);
    }
    // A única ferramenta tem IDs/cursor; sem rota privada, upload, media_id ou valores.
    expect(JSON.stringify(documentsExtension.tools)).not.toMatch(
      /private-documents|sensitive|media_id/,
    );
    const tool = documentsExtension.tools![0];
    const call = tool.call(
      { conversation_id: "conversa", order_id: f.order.id },
      f.profile,
    );
    expect(call.path).toContain("/conversation/conversa/orders/");
  });

  it("rota do titular omite sensíveis/internos/pendentes e não aceita outro titular", async () => {
    const f = await setup();
    const customer = await receive(f, f.line, "oi", "5511960010203");
    const stranger = await receive(f, f.line, "oi", "5511960010999");
    const context = { conversation_id: customer.id };
    expect(
      await listDocuments(f.ctx, f.member, f.order.id, {}, context),
    ).toEqual({ data: [], next_cursor: null });
    const visibleId = uid();
    await exec(
      env,
      `INSERT INTO os_documents(id,profile_id,order_id,name,mime_type,expected_bytes,
      byte_length,sha256,r2_key,state,upload_expires_at,client_visible,sensitive,created_by,created,updated)
      VALUES(?,?,?,'Público.pdf','application/pdf',3,3,?,'objeto-publico','ready',?,1,0,'equipe',?,?)`,
      visibleId,
      f.profile,
      f.order.id,
      "a".repeat(64),
      now() + UPLOAD_TTL,
      now(),
      now(),
    );
    await exec(
      env,
      `INSERT INTO os_documents(id,profile_id,order_id,name,mime_type,expected_bytes,
      upload_expires_at,client_visible,sensitive,created_by,created,updated)
      VALUES(?,?,?,'Pendente.pdf','application/pdf',3,?,1,0,'equipe',?,?)`,
      uid(),
      f.profile,
      f.order.id,
      now() + UPLOAD_TTL,
      now(),
      now(),
    );
    const page = await listDocuments(
      f.ctx,
      f.member,
      f.order.id,
      { limit: "1" },
      context,
    );
    expect(page.data.map((x) => x.id)).toEqual([visibleId]);
    expect(page.next_cursor).toBeNull();
    expect(page.data[0]).not.toHaveProperty("created_by");
    expect(JSON.stringify(page)).not.toContain(MOTOR_SENTINEL);
    await expect(
      listDocuments(
        f.ctx,
        f.member,
        f.order.id,
        {},
        { conversation_id: stranger.id },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    // A rota pública usa os parâmetros do caminho, sem telefone alegado no corpo.
    const result = await api(
      f.token,
      `/profiles/${f.profile}/service-orders/conversation/${customer.id}/orders/${f.order.id}/documents`,
    );
    expect(result.status).toBe(200);
    expect(await result.text()).not.toContain(MOTOR_SENTINEL);
  });

  it("cursor privado não pode ser reutilizado no catálogo comum e não carrega nomes", async () => {
    const f = await setup();
    await exec(
      env,
      `INSERT INTO os_documents(id,profile_id,order_id,name,mime_type,expected_bytes,
      upload_expires_at,client_visible,sensitive,created_by,created,updated)
      VALUES(?,?,?,?,'application/pdf',3,?,0,1,'equipe',?,?)`,
      uid(),
      f.profile,
      f.order.id,
      SECRET_NAME,
      now() + UPLOAD_TTL,
      now(),
      now(),
    );
    const page = await listDocuments(
      f.ctx,
      f.privileged,
      f.order.id,
      { limit: "1" },
      { private: true },
    );
    expect(page.next_cursor).not.toBeNull();
    expect(decodeURIComponent(atob(page.next_cursor!))).not.toContain(
      MOTOR_SENTINEL,
    );
    await expect(
      listDocuments(f.ctx, f.privileged, f.order.id, {
        cursor: page.next_cursor!,
      }),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
  });
});
