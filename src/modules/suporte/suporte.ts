// Suporte pago (módulo "suporte"): ganchos e rotas. Conversa no WhatsApp em
// ./flow.ts; banco em ./store.ts; passagem para humano em ./handoff.ts.
// Depende da Mensalidade por src/modules/mensalidade/public.ts (até o núcleo
// formalizar `requires`). Uso: docs/SUPORTE.md.
import { one } from "../../db";
import { ApiError, type Actor, now } from "../../types";
import {
  moduleError,
  modulesApi,
  onCommand,
  onConversationTurn,
  onHandoffRequest,
  onMenuChoice,
  onPaymentUpdated,
  onRead,
  onRoute,
  onSchedule,
  onSettingsSave,
  type ModuleContext,
} from "../api";
import {
  chargesReady,
  linkPhone,
  mensalidadeAvailable,
  onInstallmentPaid,
  onInstallmentRefunded,
  sellablePlans,
} from "../mensalidade/public";
import {
  packageValidity,
  phoneDigits,
  suporteSettings,
  validateSuporteSettings,
} from "./model";
import {
  confirmByTeam,
  handleTurn,
  installmentPaid,
  recentSessions,
  startFlow,
} from "./flow";
import {
  activeRelease,
  handoffGate,
  settleByRef,
  settleReleases,
} from "./handoff";
import {
  endRelease,
  listPurchases,
  listReleases,
  purchasePaymentUpdated,
  purchaseView,
  release,
  releaseView,
  sessionView,
} from "./store";

onSettingsSave("suporte", "suporte", validateSuporteSettings);

// Item de menu "Atendimento humano (pago)".
onMenuChoice("suporte_humano", (ctx, c, _item, { rowId }) =>
  startFlow(ctx, c, rowId),
);

// Toda passagem automática para humano (item "humano" do menu, palavra-chave,
// bot de IA que transfere, falha do bot, anexo) só segue com liberação ativa
// ou pagador em dia; senão o Suporte segura e conduz a liberação.
onHandoffRequest("suporte", async (ctx, c, request) => {
  if (c.chat_type === "group") return "allow";
  const at = now();
  if ((await handoffGate(ctx, c, at, { settle: true })).allowed) return "allow";
  await startFlow(ctx, c, `gate:${request.source}:${at}`, at);
  return "hold";
});

// Liberações que deixaram de valer (prazo, protocolo fechado, conversa
// resolvida, assinatura fora do dia) são encerradas mesmo sem o cliente voltar.
onSchedule("suporte", async (ctx, tick) => {
  await settleReleases(ctx, tick.now);
});

// Estorno da parcela que liberou o atendimento: a liberação acaba.
onInstallmentRefunded("suporte", async (env, profile, inst) => {
  const ctx = modulesApi(env, profile, "suporte");
  if (!(await ctx.enabled())) return;
  await settleByRef(ctx, inst.id, "Pagamento da mensalidade estornado.");
});

// Respostas do cliente durante a liberação (documento, nome, opção, pagamento).
onConversationTurn("suporte", (ctx, c, turn) => handleTurn(ctx, c, turn));

// Compras avulsas: só o pagamento confirmado pelo provedor libera.
onPaymentUpdated("suporte", (ctx, payment) =>
  purchasePaymentUpdated(ctx, payment),
);

// Mensalidade paga (plano contratado ou parcela em atraso): libera quem esperava.
onInstallmentPaid("suporte", installmentPaid);

/** Atendente da conversa, administrador ou integração. */
function mayAct(actor: Actor, c: { owner: string | null }) {
  if (actor.kind === "app") return;
  if (actor.kind === "user" && (actor.role === "admin" || c.owner === actor.id))
    return;
  throw new ApiError(
    403,
    "forbidden",
    "Assuma a conversa antes de liberar o suporte.",
  );
}

const text = (value: unknown, max: number, what: string) => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Array.from(value.trim()).length > max
  )
    throw moduleError(
      400,
      "invalid_request",
      `Informe ${what} (até ${max} caracteres).`,
    );
  return value.trim();
};

/** Estado do suporte numa conversa, para o painel "Dados da conversa" e os apps. */
async function conversationStatus(
  ctx: ModuleContext,
  conversationId: string,
  actor: Actor,
) {
  const c = await ctx.conversation(conversationId, actor);
  const at = now();
  const rel = await activeRelease(ctx, c, at);
  const sessions = await recentSessions(ctx, c.id);
  const current = sessions[0] || null;
  const gate = await handoffGate(ctx, c, at);
  const unlinked =
    (rel && !rel.phone_linked && rel.payer_id) ||
    (current && current.phone_linked === 0 && current.payer_id)
      ? {
          payer_id: rel?.payer_id || current?.payer_id,
          payer_name: rel?.payer_name || current?.name || "",
        }
      : null;
  const purchases = await listPurchases(ctx, {
    conversation_id: c.id,
    limit: "5",
  });
  return {
    conversation_id: c.id,
    phone: phoneDigits(c.phone || c.external_id),
    allowed: gate.allowed,
    reason: gate.reason,
    release: rel ? releaseView(rel) : null,
    session: sessionView(current),
    awaiting_team: current?.status === "awaiting_team",
    unlinked_phone: unlinked,
    purchases: purchases.data,
  };
}

// ---------------------------------------------------------------------------
// Rotas: /api/v1/profiles/:profile/suporte…

onRead("suporte", "suporte/releases", async (ctx, actor, { query }) => {
  ctx.access(actor, "conversations:read");
  return listReleases(ctx, query);
});

onRead("suporte", "suporte/purchases", async (ctx, actor, { query }) => {
  ctx.access(actor, "conversations:read");
  return listPurchases(ctx, query);
});

// Ofertas como o cliente vê: pacotes avulsos e planos mensais.
onRead("suporte", "suporte/offers", async (ctx, actor) => {
  ctx.access(actor, "conversations:read");
  const cfg = suporteSettings(await ctx.settings());
  const plansOn =
    cfg.offer_plans && (await mensalidadeAvailable(ctx.env, ctx.profile));
  return {
    payments_ready: await chargesReady(ctx.env, ctx.profile),
    mensalidade: await mensalidadeAvailable(ctx.env, ctx.profile),
    methods: cfg.methods,
    packages: cfg.packages
      .filter((p) => p.active)
      .map((p) => ({ ...p, validity: packageValidity(p) })),
    plans: plansOn
      ? (await sellablePlans(ctx.env, ctx.profile)).filter(
          (p) => !cfg.plan_ids.length || cfg.plan_ids.includes(p.id),
        )
      : [],
  };
});

onRead(
  "suporte",
  "suporte/conversations/:id",
  async (ctx, actor, { params }) => {
    ctx.access(actor, "conversations:read");
    return conversationStatus(ctx, params.id, actor);
  },
);

// Cortesia: o atendente libera sem pagamento, com motivo registrado.
onRoute("suporte", {
  method: "POST",
  path: "suporte/conversations/:id/courtesy",
  op: "suporte.courtesy",
});
onCommand(
  "suporte",
  "suporte.courtesy",
  async (ctx, actor, data, { requestId }) => {
    ctx.access(actor, "conversations:write");
    const c = await ctx.conversation(data.id, actor);
    mayAct(actor, c);
    const reason = text(data.reason, 300, "o motivo da cortesia");
    const hours =
      data.hours === undefined || data.hours === null
        ? null
        : Number(data.hours);
    if (
      hours !== null &&
      !(Number.isInteger(hours) && hours >= 1 && hours <= 720)
    )
      throw moduleError(
        400,
        "invalid_request",
        "Horas da cortesia de 1 a 720.",
      );
    const session = await one(
      ctx.env,
      "SELECT * FROM suporte_sessions WHERE conversation_id=? AND profile_id=? AND status IN ('active','awaiting_team') ORDER BY created DESC LIMIT 1",
      c.id,
      ctx.profile,
    );
    const { release: row } = await release(ctx, {
      c,
      session,
      kind: "courtesy",
      payer: session?.payer_id
        ? {
            id: session.payer_id,
            name: session.name || "",
            document_display: null,
          }
        : null,
      phone_linked: session ? session.phone_linked !== 0 : true,
      valid_until: hours ? now() + hours * 3_600_000 : null,
      reason,
      actor: actor.id,
      sourceKey: `cortesia:${actor.id}:${requestId}`,
    });
    return releaseView(row);
  },
);

// Vincular com um toque o telefone da conversa ao pagador identificado.
onRoute("suporte", {
  method: "POST",
  path: "suporte/conversations/:id/link-phone",
  op: "suporte.link_phone",
});
onCommand("suporte", "suporte.link_phone", async (ctx, actor, data) => {
  ctx.access(actor, "conversations:write");
  const c = await ctx.conversation(data.id, actor);
  const status = await conversationStatus(ctx, c.id, actor);
  if (!status.unlinked_phone)
    throw moduleError(
      409,
      "nothing_to_link",
      "Não há pagador aguardando vínculo nesta conversa.",
    );
  const phone = phoneDigits(c.phone || c.external_id);
  await linkPhone(
    ctx.env,
    ctx.profile,
    status.unlinked_phone.payer_id,
    phone,
    actor.id,
    "Vinculado pelo atendimento",
  );
  await ctx.env.DB.prepare(
    "UPDATE suporte_releases SET phone_linked=1 WHERE conversation_id=? AND profile_id=? AND payer_id=?",
  )
    .bind(c.id, ctx.profile, status.unlinked_phone.payer_id)
    .run();
  await ctx.env.DB.prepare(
    "UPDATE suporte_sessions SET phone_linked=1 WHERE conversation_id=? AND profile_id=? AND payer_id=?",
  )
    .bind(c.id, ctx.profile, status.unlinked_phone.payer_id)
    .run();
  await ctx.publish(
    "suporte.phone_linked",
    c.id,
    {
      conversation_id: c.id,
      payer_id: status.unlinked_phone.payer_id,
      phone,
      actor: actor.id,
    },
    { key: `${c.id}:${status.unlinked_phone.payer_id}:${phone}` },
  );
  return conversationStatus(ctx, c.id, actor);
});

// Modo "só telefone vinculado": a equipe confirma (e vincula) e libera.
onRoute("suporte", {
  method: "POST",
  path: "suporte/conversations/:id/confirm",
  op: "suporte.confirm",
});
onCommand("suporte", "suporte.confirm", async (ctx, actor, data) => {
  ctx.access(actor, "conversations:write");
  const c = await ctx.conversation(data.id, actor);
  mayAct(actor, c);
  const { release: row } = await confirmByTeam(
    ctx,
    c,
    actor.id,
    { link: data.link !== false },
    (payerId, phone) =>
      linkPhone(
        ctx.env,
        ctx.profile,
        payerId,
        phone,
        actor.id,
        "Confirmado pelo atendimento",
      ),
  );
  return releaseView(row);
});

onRoute("suporte", {
  method: "POST",
  path: "suporte/releases/:id/end",
  op: "suporte.release_end",
});
onCommand("suporte", "suporte.release_end", async (ctx, actor, data) => {
  ctx.access(actor, "conversations:write");
  if (actor.kind === "user" && actor.role !== "admin")
    throw new ApiError(
      403,
      "admin_required",
      "Somente administradores encerram liberações.",
    );
  return endRelease(
    ctx,
    data.id,
    actor.id,
    typeof data.reason === "string" ? data.reason : "",
  );
});

export { purchaseView };
