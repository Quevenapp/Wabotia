import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { all, one } from "../src/db";
import { now, uid } from "../src/types";
import {
  listNotices,
  noticeCommand,
  sendDueNotices,
} from "../src/modules/condominio/notices";
import { condFixture } from "./condominio-fixture";

describe("Condomínio: comunicados", () => {
  it("exige revisão de público, deduplica telefone e não envia rascunho", async () => {
    const f = await condFixture();
    await f.create("membership", {
      person_id: f.person,
      unit_id: f.unit2,
      role: "inquilino",
      starts_at: now() - 100,
      notices: true,
    });
    const n = await noticeCommand(
      f.ctx,
      f.admin,
      "create",
      { title: "Aviso", body: "Texto", audience: "all" },
      uid(),
    );
    await expect(
      noticeCommand(f.ctx, f.admin, "send", n, uid()),
    ).rejects.toMatchObject({ code: "not_approved" });
    await expect(
      noticeCommand(f.ctx, f.admin, "approve", n, uid()),
    ).rejects.toMatchObject({ code: "review_required" });
    await noticeCommand(
      f.ctx,
      f.admin,
      "approve",
      { ...n, reviewed_public_content: true },
      uid(),
    );
    await noticeCommand(f.ctx, f.admin, "send", n, uid());
    await noticeCommand(f.ctx, f.admin, "send", n, uid());
    expect(
      await all(
        env,
        "SELECT phone FROM cond_notice_recipients WHERE profile_id=? AND notice_id=?",
        f.profile,
        n.id,
      ),
    ).toHaveLength(1);
  });
  it("filtra todos/bloco/lista e nega público de outra área", async () => {
    const f = await condFixture(),
      other = await condFixture();
    for (const [audience, targets] of [
      ["all", []],
      ["block", [f.block]],
      ["units", [f.unit]],
      ["units", [f.unit2]],
    ] as const) {
      const n = await noticeCommand(
        f.ctx,
        f.admin,
        "create",
        { title: audience, body: "Comunicado", audience, targets },
        uid(),
      );
      await noticeCommand(
        f.ctx,
        f.admin,
        "approve",
        { ...n, reviewed_public_content: true },
        uid(),
      );
    }
    expect(
      (await listNotices(f.ctx, f.customer, {}, f.accessId)).data,
    ).toHaveLength(3);
    await expect(
      noticeCommand(
        f.ctx,
        f.admin,
        "create",
        { title: "X", body: "Y", audience: "units", targets: [other.unit] },
        uid(),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(listNotices(f.ctx, f.member, {})).rejects.toMatchObject({
      code: "forbidden",
    });
  });
  it("usa fila com notification e chave estável; conteúdo livre nunca entra na mensagem", async () => {
    const f = await condFixture();
    const n = await noticeCommand(
      f.ctx,
      f.admin,
      "create",
      { title: "TITULO_PRIVADO", body: "CONTEUDO_PRIVADO", audience: "all" },
      uid(),
    );
    await noticeCommand(
      f.ctx,
      f.admin,
      "approve",
      { ...n, reviewed_public_content: true },
      uid(),
    );
    await noticeCommand(f.ctx, f.admin, "send", n, uid());
    const send = vi.fn().mockResolvedValue("message");
    const ctx = {
      ...f.ctx,
      sendMessage: send,
      conversationByPhone: vi.fn().mockResolvedValue(f.c),
      wake: vi.fn(),
    };
    await sendDueNotices(ctx);
    await sendDueNotices(ctx);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][2]).toMatchObject({
      notification: true,
      key: `notice:${n.id}:5511960010203`,
    });
    expect(JSON.stringify(send.mock.calls)).not.toContain("CONTEUDO_PRIVADO");
    expect(JSON.stringify(send.mock.calls)).not.toContain("TITULO_PRIVADO");
    expect(
      (await one(
        env,
        "SELECT status FROM cond_notice_recipients WHERE profile_id=? AND notice_id=?",
        f.profile,
        n.id,
      ))!.status,
    ).toBe("queued");
  });
  it("recusa de consentimento fica pendente visível; revogação não envia e falhas têm limite", async () => {
    const f = await condFixture();
    const n = await noticeCommand(
      f.ctx,
      f.admin,
      "create",
      { title: "Aviso", body: "Texto", audience: "all" },
      uid(),
    );
    await noticeCommand(
      f.ctx,
      f.admin,
      "approve",
      { ...n, reviewed_public_content: true },
      uid(),
    );
    await noticeCommand(f.ctx, f.admin, "send", n, uid());
    const send = vi.fn().mockRejectedValue(new Error("consent_required"));
    const ctx = {
      ...f.ctx,
      sendMessage: send,
      conversationByPhone: vi.fn().mockResolvedValue(f.c),
      wake: vi.fn(),
    };
    for (let i = 0; i < 4; i++) {
      await sendDueNotices(ctx);
      await noticeCommand(ctx, f.admin, "retry", n, uid());
    }
    expect(send).toHaveBeenCalledTimes(3);
    expect(
      await one(
        env,
        "SELECT status,attempts FROM cond_notice_recipients WHERE profile_id=? AND notice_id=?",
        f.profile,
        n.id,
      ),
    ).toMatchObject({ status: "failed", attempts: 3 });
    const second = await noticeCommand(
      f.ctx,
      f.admin,
      "create",
      { title: "Segundo", body: "Texto", audience: "all" },
      uid(),
    );
    await noticeCommand(
      f.ctx,
      f.admin,
      "approve",
      { ...second, reviewed_public_content: true },
      uid(),
    );
    await noticeCommand(f.ctx, f.admin, "send", second, uid());
    await f.create("end-membership", { id: f.membership });
    await sendDueNotices(ctx);
    expect(send).toHaveBeenCalledTimes(3);
    expect(
      (await one(
        env,
        "SELECT status FROM cond_notice_recipients WHERE profile_id=? AND notice_id=?",
        f.profile,
        second.id,
      ))!.status,
    ).toBe("skipped");
  });
});
