// Revisão de segurança A3: o gancho onPaymentUpdated não se perde quando
// falha depois de a cobrança virar "paga". Antes, o reenvio do webhook via
// "já paga" e não chamava o gancho: o cliente pagava e a parcela seguia aberta.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { exec, one } from "../src/db";
import { paymentHook, registerPaymentHook } from "../src/modules/hooks";
import { retryPaymentHooks } from "../src/payments";
import { configure } from "./service-center-fixture";
import {
  approve,
  remoteStatus,
  useMercadoPago,
  webhook,
} from "./mensalidade-mp";
import { payerEmAtraso, setupSuporte, talk, tap } from "./suporte-fixture";

useMercadoPago();

/** Pagador em atraso pede humano, cai na parcela e escolhe Pix. */
async function pixDaParcela() {
  const s = await setupSuporte();
  const { f } = s;
  await configure(f, {
    menus: [
      {
        id: "pago",
        label: "Atendimento humano (pago)",
        type: "suporte_humano",
      },
    ],
  });
  const phone = "5511979000001";
  await payerEmAtraso(s, phone);
  await talk(f, "oi", phone);
  await talk(f, "1", phone);
  await tap(f, phone, "suporte:method:pix");
  const pay = await one(
    env,
    "SELECT * FROM payments WHERE profile_id=? AND module_id='mensalidade' ORDER BY created DESC LIMIT 1",
    f.profile,
  );
  expect(pay).toBeTruthy();
  return { s, f, pay, account: (s.account as any).id as string };
}

/** Troca o gancho da Mensalidade por um que falha `times` vezes. */
function failing(times: number, seen: string[] = []) {
  const original = paymentHook("mensalidade")!;
  let left = times;
  registerPaymentHook("mensalidade", async (e, profile, payment, previous) => {
    seen.push(`${payment.status}<${previous}`);
    if (left-- > 0) throw new Error("falha transitória");
    return original(e, profile, payment, previous);
  });
  return () => registerPaymentHook("mensalidade", original);
}

const installment = async (id: string) =>
  (await one(env, "SELECT status FROM mensalidade_installments WHERE id=?", id))
    .status;
const hookState = (id: string) =>
  one(
    env,
    "SELECT status,hook_pending,hook_attempts,hook_error FROM payments WHERE id=?",
    id,
  );

describe("gancho de pagamento durável (revisão A3)", () => {
  it("H: falha depois de gravar 'paga' é repetida no reenvio do webhook", async () => {
    const { pay, account } = await pixDaParcela();
    const restore = failing(1);
    try {
      await approve(account, pay.id);
      const after = await hookState(pay.id);
      expect(after.status).toBe("paid");
      expect(JSON.parse(after.hook_pending)).toHaveLength(1);
      expect(after.hook_attempts).toBe(1);
      expect(after.hook_error).toBe("falha transitória");
      expect(await installment(pay.ref_id)).not.toBe("paid");
      // O Mercado Pago reenvia: sem mudança de estado, o gancho pendente roda.
      const again = await webhook(account, pay.provider_ref);
      expect(again.status).toBe(200);
    } finally {
      restore();
    }
    expect(await installment(pay.ref_id)).toBe("paid");
    expect(await hookState(pay.id)).toMatchObject({
      hook_pending: null,
      hook_attempts: 0,
      hook_error: null,
    });
  });

  it("o alarme repete o gancho pendente, respeitando o intervalo", async () => {
    const { f, pay, account } = await pixDaParcela();
    const restore = failing(1);
    try {
      await approve(account, pay.id);
      // Antes do intervalo, nada roda.
      await retryPaymentHooks(env, f.profile);
      expect(await installment(pay.ref_id)).not.toBe("paid");
      await exec(env, "UPDATE payments SET hook_next_at=0 WHERE id=?", pay.id);
      await retryPaymentHooks(env, f.profile);
    } finally {
      restore();
    }
    expect(await installment(pay.ref_id)).toBe("paid");
    expect((await hookState(pay.id)).hook_pending).toBeNull();
  });

  it("estorno com o 'paga' pendente: os dois ganchos rodam, em ordem", async () => {
    const { pay, account } = await pixDaParcela();
    const seen: string[] = [];
    const restore = failing(1, seen);
    try {
      await approve(account, pay.id);
      await remoteStatus(account, pay.id, "refunded");
    } finally {
      restore();
    }
    // Primeira tentativa do "paga" falhou; no estorno, "paga" e depois
    // "estornada", cada uma com o próprio estado.
    expect(seen).toEqual(["paid<created", "paid<created", "refunded<paid"]);
    expect(await hookState(pay.id)).toMatchObject({
      status: "refunded",
      hook_pending: null,
    });
  });

  it("sem falha, nada fica pendente e o gancho roda uma vez", async () => {
    const { pay, account } = await pixDaParcela();
    const seen: string[] = [];
    const restore = failing(0, seen);
    try {
      await approve(account, pay.id, 3);
    } finally {
      restore();
    }
    expect(seen).toEqual(["paid<created"]);
    expect(await installment(pay.ref_id)).toBe("paid");
    expect((await hookState(pay.id)).hook_pending).toBeNull();
  });
});
