import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, batch, exec, one } from "../src/db";
import { ApiError, now, uid } from "../src/types";
import { readBinaryContent } from "../src/modules/binary";
import * as motor from "../src/modules/os/public";
import { documentsExtension } from "../src/modules/os/documents/extension";
import {
  archiveDocument,
  listDocuments,
  reserveDocument,
} from "../src/modules/os/documents/store";
import {
  beginUpload,
  completeDocument,
  downloadDocument,
  recordUpload,
  uploadHandler,
} from "../src/modules/os/documents/transport";
import { loadDocument } from "../src/modules/os/documents/access";
import { cleanupDocuments } from "../src/modules/os/documents/cleanup";
import {
  receiveDocument,
  sendDocument,
} from "../src/modules/os/documents/delivery";
import {
  DOCUMENT_LIMIT,
  objectKey,
  UPLOAD_LEASE,
  UPLOAD_TTL,
  validateDocument,
} from "../src/modules/os/documents/model";
import { motorFixture, motorOrder, motorWorkType } from "./os-motor-fixture";
import { receive } from "./service-center-fixture";

afterEach(() => vi.restoreAllMocks());
const input = (extra: Record<string, unknown> = {}) => ({
  name: "Documento.pdf",
  mime_type: "application/pdf",
  expected_bytes: 3,
  client_visible: true,
  sensitive: false,
  ...extra,
});

async function setup() {
  const f = await motorFixture();
  const order = await motorOrder(f);
  // Isolamento local para os cenários da filha; a recuperação com M/Coordinator
  // reais está em os-document-recovery.test.ts. A fixture comum fica intacta.
  await exec(
    env,
    "CREATE UNIQUE INDEX IF NOT EXISTS os_documents_test_parent ON os_orders(profile_id,id)",
  );
  const authorize = motor.authorizedOrder;
  vi.spyOn(motor, "authorizedOrder").mockImplementation(async (...args) => {
    const result = await authorize(...args); // conserva área, escopo, conversa e módulo reais
    return { ...result, type: motorWorkType() };
  });
  const mutations: motor.ChildMutation[] = [];
  const committed = new Map<
    string,
    { id: string; order_id: string; version: number }
  >();
  // Somente commitChild é substituído: as instruções reais da filha rodam no D1.
  vi.spyOn(motor, "commitChild").mockImplementation(
    async (ctx, _actor, parent, mutation) => {
      mutations.push(mutation);
      const replay = committed.get(mutation.mutation_key);
      if (replay) return replay;
      const row = await one(
        env,
        "SELECT version FROM os_documents WHERE profile_id=? AND order_id=? AND id=?",
        ctx.profile,
        parent.row.id,
        mutation.id,
      );
      if (
        mutation.expected_version === null
          ? !!row
          : row?.version !== mutation.expected_version
      )
        throw new ApiError(409, "version_conflict", "Conflito.");
      const result = await batch(env, mutation.statements);
      expect(result[0].meta.changes).toBe(1);
      const ref = {
        id: mutation.id,
        order_id: parent.row.id,
        version: (mutation.expected_version ?? 0) + 1,
      };
      committed.set(mutation.mutation_key, ref);
      return ref;
    },
  );
  return { ...f, order, mutations };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function upload(
  f: Setup,
  id: string,
  key: string = uid(),
  body = "abc",
  intercept?: (op: string, run: () => Promise<unknown>) => Promise<unknown>,
) {
  const content = vi.fn(() =>
    readBinaryContent(
      new Request("https://test.invalid", { method: "PUT", body }),
    ),
  );
  const commands: unknown[] = [];
  const result = await uploadHandler(false, async (_op, data) =>
    beginUpload(f.ctx, f.member, f.order.id, id, data.version, String(data.upload_key)),
  ).upload(f.ctx, f.member, {
    request: new Request("https://test.invalid", { method: "PUT" }),
    params: { id: f.order.id, document_id: id },
    query: {},
    version: 1,
    key,
    content,
    command: async (op, data) => {
      commands.push(data);
      const run = () =>
        op.endsWith(".begin")
          ? beginUpload(
              f.ctx,
              f.member,
              f.order.id,
              id,
              data.version,
              String(data.upload_key),
            )
          : recordUpload(
              f.ctx,
              f.member,
              f.order.id,
              id,
              data.version,
              data.upload_attempt,
            );
      return intercept ? intercept(op, run) : run();
    },
  });
  return {
    result: result as {
      id: string;
      version: number;
      upload_attempt: string;
      sha256: string;
      byte_length: number;
    },
    content,
    commands,
  };
}

describe("documentos: fundação com M", () => {
  it("preserva o embutido com recurso desligado, o módulo desligado e recusa mutação vazia", async () => {
    const f = await motorFixture();
    const order = await motorOrder(f);
    await expect(
      reserveDocument(f.ctx, f.member, order.id, input(), uid()),
    ).rejects.toMatchObject({ code: "feature_disabled" });
    await expect(motor.resolveWorkType(f.ctx, "projeto")).rejects.toMatchObject(
      { status: 404, code: "type_not_found" },
    );
    await expect(
      motor.commitChild(
        f.ctx,
        f.member,
        await motor.authorizedOrder(f.ctx, f.member, order.id),
        {
          entity_kind: "document",
          id: uid(),
          expected_version: null,
          mutation_key: uid(),
          changed_fields: ["state"],
          statements: [],
          event: "os.document_reserved",
        },
      ),
    ).rejects.toMatchObject({ status: 409, code: "version_conflict" });
    expect(await all(env, "SELECT id FROM os_documents WHERE profile_id=?", f.profile)).toEqual([]);
    const disabled = await motorFixture({ enabled: false });
    await expect(
      listDocuments(disabled.ctx, disabled.member, order.id),
    ).rejects.toMatchObject({ code: "module_disabled" });
    const c = await receive(f, f.line, "oi", "5511960010203");
    vi.spyOn(f.ctx, "inboundAttachments").mockResolvedValue([
      {
        id: uid(),
        name: "Anexo.pdf",
        mime_type: "application/pdf",
        byte_length: 3,
        open: async () => {
          throw new Error("Embutido não abre anexos de documentos");
        },
      },
    ]);
    const messages = vi.spyOn(f.ctx, "sendMessage");
    const stranger = await motorOrder(f, { phone: "5511960010999" });
    for (const text of ["segue anexo", `DOCUMENTO ${order.number}`, "DOCUMENTO 999", `DOCUMENTO ${stranger.number}`, "DOCUMENTO 9999999999", "DOCUMENTO inválido"])
      expect(
        await receiveDocument(f.ctx, c, { text, replyId: null, rowId: uid() }),
      ).toBe(false);
    expect(messages).not.toHaveBeenCalled();
    vi.mocked(f.ctx.inboundAttachments).mockResolvedValue([]);
    for (const text of ["DOCUMENTO 999", `DOCUMENTO ${stranger.number}`])
      expect(await receiveDocument(f.ctx, c, { text, replyId: null, rowId: uid() })).toBe(false);
    expect(messages).not.toHaveBeenCalled();
  });
  it("exporta descritor e adaptador binário, sem registradores nos filhos", () => {
    expect(documentsExtension.id).toBe("documents");
    expect(documentsExtension.binaryUploads).toHaveLength(2);
    expect(documentsExtension.binaryReads).toHaveLength(2);
    expect(documentsExtension.commands.map((x) => x.op)).toContain(
      "os.private.document.complete",
    );
    expect(documentsExtension.tools!.map((x) => x.name)).toEqual([
      "os_documentos",
    ]);
  });
});

describe("documentos: D1 e transporte R2", () => {
  it("reserva por 24 horas, repete sem duplicar e confirma tamanho/hash calculado no servidor", async () => {
    const f = await setup(),
      key = uid();
    const reserved = await reserveDocument(
      f.ctx,
      f.member,
      f.order.id,
      input(),
      key,
    );
    expect(reserved.version).toBe(1);
    expect(reserved.expires_at - now()).toBeGreaterThan(UPLOAD_TTL - 10000);
    expect(
      await reserveDocument(f.ctx, f.member, f.order.id, input(), key),
    ).toEqual(reserved);
    expect(
      await all(
        env,
        "SELECT id FROM os_documents WHERE profile_id=? AND order_id=?",
        f.profile,
        f.order.id,
      ),
    ).toHaveLength(1);
    await expect(
      downloadDocument(f.ctx, f.member, f.order.id, reserved.id),
    ).rejects.toMatchObject({ code: "document_not_ready" });
    const transport = await upload(f, reserved.id, key);
    expect(transport.result).toMatchObject({
      id: reserved.id,
      version: 1,
      byte_length: 3,
      sha256:
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    });
    expect(JSON.stringify(transport.commands)).not.toContain("abc");
    expect(JSON.stringify(transport.commands)).not.toContain("bytes");
    expect((await loadDocument(f.ctx, f.order.id, reserved.id)).state).toBe(
      "pending",
    );
    const replay = await upload(
      f,
      reserved.id,
      key,
      "conteúdo diferente ignorado",
    );
    expect(replay.result).toEqual(transport.result);
    expect(replay.content).not.toHaveBeenCalled();
    const completeKey = uid();
    const ref = await completeDocument(
      f.ctx,
      f.member,
      f.order.id,
      reserved.id,
      1,
      transport.result.upload_attempt,
      completeKey,
    );
    expect(ref.version).toBe(2);
    expect(
      await completeDocument(
        f.ctx,
        f.member,
        f.order.id,
        reserved.id,
        1,
        transport.result.upload_attempt,
        completeKey,
      ),
    ).toEqual(ref);
    expect((await upload(f, reserved.id, key)).result).toEqual(
      transport.result,
    );
    const download = await downloadDocument(
      f.ctx,
      f.member,
      f.order.id,
      reserved.id,
    );
    expect(new Headers(download.headers).get("Cache-Control")).toBe("no-store");
    expect(await new Response(download.body).text()).toBe("abc");
    const page = await listDocuments(f.ctx, f.member, f.order.id);
    expect(page.data[0].state).toBe("ready");
    for (const column of [
      "r2_key",
      "upload_attempt",
      "upload_request_key",
      "profile_id",
      "source_media_id",
    ])
      expect(page.data[0]).not.toHaveProperty(column);
    expect(
      f.mutations.map((m) => ({
        event: m.event,
        changed_fields: m.changed_fields,
      })),
    ).toContainEqual({
      event: "os.document_ready",
      changed_fields: ["state", "byte_length", "sha256"],
    });
  });

  it("recusa MIME, tamanho, valores desconhecidos e tamanho real divergente", async () => {
    for (const [extra, code] of [
      [{ mime_type: "text/html" }, "unsupported_media_type"],
      [{ mime_type: "image/svg+xml" }, "unsupported_media_type"],
      [{ expected_bytes: DOCUMENT_LIMIT + 1 }, "document_too_large"],
      [{ expected_bytes: 0 }, "invalid_request"],
      [{ name: "a\r\nb" }, "invalid_request"],
      [{ r2_key: "alegada" }, "invalid_request"],
      [{ source_media_id: "alegada" }, "invalid_request"],
    ] as const) {
      expect(() => validateDocument(input(extra))).toThrow(
        expect.objectContaining({ code }),
      );
    }
    const f = await setup();
    const reserved = await reserveDocument(
      f.ctx,
      f.member,
      f.order.id,
      input(),
      uid(),
    );
    await expect(upload(f, reserved.id, uid(), "quatro")).rejects.toMatchObject(
      { code: "content_mismatch" },
    );
    const row = await loadDocument(f.ctx, f.order.id, reserved.id);
    expect(await env.MEDIA.head(row.r2_key!)).toBeNull();
    await expect(
      completeDocument(
        f.ctx,
        f.member,
        f.order.id,
        row.id,
        1,
        row.upload_attempt,
        uid(),
      ),
    ).rejects.toMatchObject({ code: "upload_incomplete" });
    // O adaptador conta bytes reais, mesmo sem Content-Length confiável.
    await expect(
      readBinaryContent(
        new Request("https://test.invalid", {
          method: "PUT",
          body: new Uint8Array(DOCUMENT_LIMIT + 1),
        }),
      ),
    ).rejects.toMatchObject({ code: "document_too_large" });
  });

  it("recupera PUT que gravou no R2 e perdeu a resposta sem sobrescrever o objeto", async () => {
    const f = await setup();
    const { id } = await reserveDocument(
      f.ctx,
      f.member,
      f.order.id,
      input(),
      uid(),
    );
    const put = vi.fn(async (...args: Parameters<R2Bucket["put"]>) => {
      await env.MEDIA.put(...args);
      throw new Error("Resposta R2 perdida");
    });
    const interrupted = {
      ...f,
      ctx: {
        ...f.ctx,
        env: {
          ...f.ctx.env,
          MEDIA: {
            put,
            head: env.MEDIA.head.bind(env.MEDIA),
            get: env.MEDIA.get.bind(env.MEDIA),
          } as unknown as R2Bucket,
        },
      },
    };
    const key = uid();
    await expect(upload(interrupted, id, key)).rejects.toThrow(
      "Resposta R2 perdida",
    );
    expect((await loadDocument(f.ctx, f.order.id, id)).state).toBe("pending");
    await exec(env,
      "UPDATE os_documents SET upload_lease_until=? WHERE profile_id=? AND order_id=? AND id=?",
      now() - 60000, f.profile, f.order.id, id,
    );
    const attempt = (await loadDocument(f.ctx, f.order.id, id)).upload_attempt;
    const recovered = await upload(interrupted, id, key, "não sobrescrever", (op, run) =>
      op.endsWith(".begin") ? Promise.resolve({ upload_attempt: attempt }) : run(),
    );
    expect(put).toHaveBeenCalledTimes(1);
    expect(recovered.content).not.toHaveBeenCalled();
    expect((await loadDocument(f.ctx, f.order.id, id)).sha256).toBe(recovered.result.sha256);
    await completeDocument(
      f.ctx,
      f.member,
      f.order.id,
      id,
      1,
      recovered.result.upload_attempt,
      uid(),
    );
    expect(
      await new Response(
        (await downloadDocument(f.ctx, f.member, f.order.id, id)).body,
      ).text(),
    ).toBe("abc");
  });

  it("renova a mesma tentativa sem objeto mesmo com recibo begin antigo, mais de uma vez", async () => {
    const f = await setup();
    const { id } = await reserveDocument(f.ctx, f.member, f.order.id, input(), uid());
    const key = uid();
    const grant = await beginUpload(f.ctx, f.member, f.order.id, id, 1, key);
    const cachedBegin = (op: string, run: () => Promise<unknown>) =>
      op.endsWith(".begin") ? Promise.resolve(grant) : run();
    for (let retry = 0; retry < 2; retry++) {
      await exec(env,
        "UPDATE os_documents SET upload_lease_until=? WHERE profile_id=? AND order_id=? AND id=?",
        now() - 60000, f.profile, f.order.id, id,
      );
      // O corpo incorreto interrompe após renovar, sem gravar objeto.
      await expect(upload(f, id, key, "incorreto", cachedBegin)).rejects.toMatchObject({ code: "content_mismatch" });
      const row = await loadDocument(f.ctx, f.order.id, id);
      expect(row.upload_attempt).toBe(grant.upload_attempt);
      expect(row.upload_lease_until).toBeGreaterThan(now());
      expect(await env.MEDIA.head(row.r2_key!)).toBeNull();
      await expect(beginUpload(f.ctx, f.member, f.order.id, id, 1, "concorrente"))
        .rejects.toMatchObject({ code: "upload_busy" });
    }
    const sent = await upload(f, id, key, "abc", cachedBegin);
    expect(sent.result.upload_attempt).toBe(grant.upload_attempt);
    expect(sent.result.byte_length).toBe(3);
  });

  it("bloqueia tentativa concorrente e rejeita tentativa vencida após nova concessão", async () => {
    const f = await setup();
    const { id } = await reserveDocument(
      f.ctx,
      f.member,
      f.order.id,
      input(),
      uid(),
    );
    const old = await beginUpload(
      f.ctx,
      f.member,
      f.order.id,
      id,
      1,
      "primeira",
    );
    await expect(
      beginUpload(f.ctx, f.member, f.order.id, id, 1, "segunda"),
    ).rejects.toMatchObject({ code: "upload_busy" });
    await exec(
      env,
      "UPDATE os_documents SET upload_lease_until=? WHERE profile_id=? AND order_id=? AND id=?",
      now() - 1,
      f.profile,
      f.order.id,
      id,
    );
    const next = await beginUpload(
      f.ctx,
      f.member,
      f.order.id,
      id,
      1,
      "segunda",
    );
    expect(next.upload_attempt).not.toBe(old.upload_attempt);
    await expect(
      recordUpload(f.ctx, f.member, f.order.id, id, 1, old.upload_attempt),
    ).rejects.toMatchObject({ code: "upload_incomplete" });
    await expect(upload(f, id, "primeira")).rejects.toMatchObject({
      code: "upload_busy",
    });
    await exec(
      env,
      "UPDATE os_documents SET upload_expires_at=? WHERE profile_id=? AND order_id=? AND id=?",
      now() - 1,
      f.profile,
      f.order.id,
      id,
    );
    await expect(upload(f, id, "segunda")).rejects.toMatchObject({
      code: "upload_expired",
    });
  });

  it("recupera concessão com resposta perdida e objeto gravado antes de falha do recibo", async () => {
    const f = await setup();
    const { id } = await reserveDocument(
      f.ctx,
      f.member,
      f.order.id,
      input(),
      uid(),
    );
    const key = uid();
    const sent = await upload(f, id, key, "abc", async (op, run) => {
      if (op.endsWith(".begin")) await run();
      throw new ApiError(409, "operation_unknown", "Recibo interrompido.");
    });
    expect(sent.result.byte_length).toBe(3);
    expect((await loadDocument(f.ctx, f.order.id, id)).sha256).toBeNull();
    await exec(env,
      "UPDATE os_documents SET upload_lease_until=? WHERE profile_id=? AND order_id=? AND id=?",
      now() - 60000, f.profile, f.order.id, id,
    );
    // Repetição não sobrescreve os bytes, mesmo sem confirmação técnica no D1.
    const retry = await upload(f, id, key, "outro", async () => {
      throw new Error("indisponível");
    });
    expect(retry.content).not.toHaveBeenCalled();
    expect(retry.result).toEqual(sent.result);
    await completeDocument(
      f.ctx,
      f.member,
      f.order.id,
      id,
      1,
      sent.result.upload_attempt,
      uid(),
    );
    expect((await loadDocument(f.ctx, f.order.id, id)).state).toBe("ready");
  });

  it("rejeita corrupção de hash na confirmação", async () => {
    const f = await setup();
    const { id } = await reserveDocument(
      f.ctx,
      f.member,
      f.order.id,
      input(),
      uid(),
    );
    const sent = await upload(f, id);
    const row = await loadDocument(f.ctx, f.order.id, id);
    await env.MEDIA.put(row.r2_key!, "xyz", {
      customMetadata: { sha256: sent.result.sha256 },
    });
    await expect(
      completeDocument(
        f.ctx,
        f.member,
        f.order.id,
        id,
        1,
        sent.result.upload_attempt,
        uid(),
      ),
    ).rejects.toMatchObject({ code: "content_mismatch" });
    expect((await loadDocument(f.ctx, f.order.id, id)).state).toBe("pending");
  });

  it("isola área/pai, pagina por chave e conta arquivados no limite de 500", async () => {
    const f = await setup();
    const { id } = await reserveDocument(
      f.ctx,
      f.member,
      f.order.id,
      input(),
      uid(),
    );
    const second = await motorOrder(f);
    await expect(
      downloadDocument(f.ctx, f.member, second.id, id),
    ).rejects.toMatchObject({ code: "not_found" });
    const elsewhere = await motorFixture();
    await expect(
      listDocuments(elsewhere.ctx, elsewhere.member, f.order.id),
    ).rejects.toMatchObject({ code: "not_found" });
    await reserveDocument(
      f.ctx,
      f.member,
      f.order.id,
      input({ name: "Segundo.pdf" }),
      uid(),
    );
    const first = await listDocuments(f.ctx, f.member, f.order.id, {
      limit: "1",
    });
    expect(first.data).toHaveLength(1);
    const last = await listDocuments(f.ctx, f.member, f.order.id, {
      limit: "1",
      cursor: first.next_cursor!,
    });
    expect(last.data).toHaveLength(1);
    expect(last.data[0].id).not.toBe(first.data[0].id);
    expect(last.next_cursor).toBeNull();
    await expect(
      listDocuments(f.ctx, f.member, second.id, { cursor: first.next_cursor! }),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(
      listDocuments(f.ctx, f.member, f.order.id, { cursor: "não é cursor" }),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
    await archiveDocument(f.ctx, f.member, f.order.id, id, 1, "arquivar");
    expect(
      await archiveDocument(f.ctx, f.member, f.order.id, id, 1, "arquivar"),
    ).toMatchObject({ version: 2 });
    await exec(
      env,
      `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<498)
      INSERT INTO os_documents(id,profile_id,order_id,name,mime_type,expected_bytes,upload_expires_at,created_by,created,updated,archived_at)
      SELECT ? || x,?,?,'Arquivado','application/pdf',3,?,'test',1,1,1 FROM n`,
      uid(),
      f.profile,
      f.order.id,
      now(),
    );
    await expect(
      reserveDocument(f.ctx, f.member, f.order.id, input(), uid()),
    ).rejects.toMatchObject({ code: "collection_limit" });
  });

  it("limpa pendências e órfãos por prefixo sem eliminar confirmado/arquivado nem outra área", async () => {
    const f = await setup();
    const pending = await reserveDocument(
      f.ctx,
      f.member,
      f.order.id,
      input(),
      uid(),
    );
    await upload(f, pending.id);
    const ready = await reserveDocument(
      f.ctx,
      f.member,
      f.order.id,
      input(),
      uid(),
    );
    const sent = await upload(f, ready.id);
    await completeDocument(
      f.ctx,
      f.member,
      f.order.id,
      ready.id,
      1,
      sent.result.upload_attempt,
      uid(),
    );
    await archiveDocument(f.ctx, f.member, f.order.id, ready.id, 2, uid());
    const readyRow = await loadDocument(f.ctx, f.order.id, ready.id);
    const lostKey = objectKey(
      { profile_id: f.profile, order_id: f.order.id, id: uid(), sensitive: 0 },
      uid(),
    );
    const foreignKey = objectKey(
      { profile_id: uid(), order_id: uid(), id: uid(), sensitive: 1 },
      uid(),
    );
    await env.MEDIA.put(lostKey, "lost");
    await env.MEDIA.put(foreignKey, "elsewhere");
    let remaining = 30;
    const result = await cleanupDocuments(f.ctx, {
      now: now() + UPLOAD_TTL + UPLOAD_LEASE + 10000,
      limit: 10,
      budget: {
        get remaining() {
          return remaining;
        },
        consume(n) {
          expect(n).toBeLessThanOrEqual(remaining);
          remaining -= n;
        },
      },
    });
    expect(result.processed).toBeLessThanOrEqual(10);
    expect((await loadDocument(f.ctx, f.order.id, pending.id)).state).toBe(
      "aborted",
    );
    expect(await env.MEDIA.head(lostKey)).toBeNull();
    expect(await env.MEDIA.head(readyRow.r2_key!)).not.toBeNull();
    expect(await env.MEDIA.head(foreignKey)).not.toBeNull();
    expect(remaining).toBeGreaterThanOrEqual(0);
  });

  it("WhatsApp usa somente anexos da mesma mensagem, número global e titular verificado", async () => {
    const f = await setup();
    vi.spyOn(f.ctx, "settings").mockResolvedValue({
      os_work_types: [motorWorkType()],
    });
    const c = await receive(f, f.line, "DOCUMENTO 1", "5511960010203");
    const key = `test-inbound/${uid()}`;
    await env.MEDIA.put(key, "abc");
    const incoming = vi.spyOn(f.ctx, "inboundAttachments").mockResolvedValue([
      {
        id: uid(),
        name: "Anexo.pdf",
        mime_type: "application/pdf",
        byte_length: 3,
        open: async () => (await env.MEDIA.get(key))!,
      },
    ]);
    const outgoing = vi
      .spyOn(f.ctx, "sendMessage")
      .mockResolvedValue("mensagem");
    const turn = {
      text: `DOCUMENTO ${f.order.number}`,
      replyId: null,
      rowId: uid(),
    };
    await receiveDocument(f.ctx, c, { ...turn, text: "segue" });
    expect(outgoing.mock.calls.at(-1)![1].text).toContain("número global");
    expect(
      await all(
        env,
        "SELECT id FROM os_documents WHERE profile_id=? AND order_id=?",
        f.profile,
        f.order.id,
      ),
    ).toHaveLength(0);
    expect(await receiveDocument(f.ctx, c, turn)).toBe(true);
    expect(await receiveDocument(f.ctx, c, turn)).toBe(true);
    expect(incoming).toHaveBeenCalledWith(c, turn.rowId);
    const rows = await all(
      env,
      "SELECT * FROM os_documents WHERE profile_id=? AND order_id=?",
      f.profile,
      f.order.id,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: "ready",
      sensitive: 0,
      source_message_id: turn.rowId,
    });
    const other = await receive(f, f.line, "DOCUMENTO 1", "5511960010999");
    expect(await receiveDocument(f.ctx, other, { ...turn, rowId: uid() })).toBe(true);
    const denied = outgoing.mock.calls.at(-1)![1].text;
    expect(denied).toContain("Não foi possível localizar");
    expect(await receiveDocument(f.ctx, other, { ...turn, text: "DOCUMENTO 999", rowId: uid() })).toBe(true);
    expect(outgoing.mock.calls.at(-1)![1].text).toBe(denied);
    expect(await all(env, "SELECT id FROM os_documents WHERE profile_id=?", f.profile)).toHaveLength(1);
  });

  it("envia somente pronto/compartilhável e reutiliza chave de documento/versão", async () => {
    const f = await setup();
    const c = await receive(f, f.line, "oi", "5511960010203");
    const { id } = await reserveDocument(
      f.ctx,
      f.member,
      f.order.id,
      input(),
      uid(),
    );
    const sent = await upload(f, id);
    await completeDocument(
      f.ctx,
      f.member,
      f.order.id,
      id,
      1,
      sent.result.upload_attempt,
      uid(),
    );
    const may = vi.spyOn(f.ctx, "mayMessage").mockReturnValue(false);
    const attachment = vi
      .spyOn(f.ctx, "outgoingAttachment")
      .mockImplementation(async (_a, _c, data) => {
        expect(await new Response(data.body).text()).toBe("abc");
        return "media";
      });
    const message = vi.spyOn(f.ctx, "sendMessage").mockResolvedValue("message");
    await expect(
      sendDocument(f.ctx, f.member, f.order.id, id, 2, c.id),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(attachment).not.toHaveBeenCalled();
    may.mockReturnValue(true);
    expect(
      await sendDocument(f.ctx, f.member, f.order.id, id, 2, c.id),
    ).toEqual({ id, message_id: "message" });
    await sendDocument(f.ctx, f.member, f.order.id, id, 2, c.id);
    expect(attachment.mock.calls[0][2]).toMatchObject({
      client_visible: true,
      sensitive: false,
      key: `document:${id}:2`,
    });
    expect(message.mock.calls[0][2]).toEqual(message.mock.calls[1][2]);
  });
});
