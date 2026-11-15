// Suporte pago no WhatsApp: o item de menu "Atendimento humano (pago)"
// identifica o pagador (telefone vinculado ou CPF/CNPJ digitado), confere a
// situação na Mensalidade e libera, cobra a parcela em aberto ou vende
// suporte avulso ou plano mensal. Só o pagamento confirmado pelo provedor (ou
// a equipe) libera; nenhuma mensagem do cliente libera.
import { all, one } from "../../db";
import { ApiError, type Conversation, type Env, now } from "../../types";
import { modulesApi, type InteractiveSpec, type ModuleContext } from "../api";
import {
  chargeInstallment,
  chargesReady,
  contractPlan,
  mensalidadeAvailable,
  sellablePlans,
  situationByDocument,
  situationByPayer,
  situationByPhone,
  validDocument,
  type InstallmentPaid,
  type PayerSituation,
} from "../mensalidade/public";
import { dayLabel, phoneDigits } from "../mensalidade/model";
import {
  METHOD_LABELS,
  money,
  normalize,
  packageValidity,
  suporteSettings,
  type SuporteSettings,
} from "./model";
import {
  activeSession,
  buyPackage,
  loadSession,
  openSession,
  release,
  sessionOptions,
  updateSession,
} from "./store";
import { activeRelease, passToTeam } from "./handoff";

export const PREFIX = "suporte:";
const CANCEL = new Set(["menu", "voltar", "sair", "cancelar"]);

const say = (ctx: ModuleContext, c: Conversation, text: string, key: string) =>
  ctx.sendMessage(c, { text }, { key });

const customerOf = (c: Conversation) =>
  `customer:${phoneDigits(c.phone || c.external_id)}`;

/** Lista interativa com as opções guardadas na sessão (número na linha QR). */
async function choose(
  ctx: ModuleContext,
  c: Conversation,
  session: any,
  step: string,
  body: string,
  button: string,
  sections: {
    title?: string;
    rows: { id: string; title: string; description?: string }[];
  }[],
  key: string,
) {
  const rows = sections.flatMap((s) => s.rows);
  await updateSession(ctx, session, {
    step,
    options: JSON.stringify(rows.map((r) => ({ id: r.id, title: r.title }))),
  });
  const spec: InteractiveSpec = {
    type: "list",
    body: Array.from(body).slice(0, 1000).join(""),
    button,
    sections: sections.filter((s) => s.rows.length),
  };
  await ctx.sendInteractive(c, spec, { key });
}

const clip = (value: string, max: number) =>
  Array.from(value).slice(0, max).join("");

// ---------------------------------------------------------------------------
// Início (item de menu)

export async function startFlow(
  ctx: ModuleContext,
  c: Conversation,
  rowId: string,
  at = now(),
) {
  if (c.chat_type === "group") return;
  const existing = await activeRelease(ctx, c, at);
  if (existing) {
    await say(
      ctx,
      c,
      "Seu atendimento já está liberado. Vamos chamar um atendente.",
      `ja-liberado:${rowId}`,
    );
    await passToTeam(
      ctx,
      c,
      existing.summary || "Suporte pago: liberação ativa.",
    );
    return;
  }
  const session = await openSession(ctx, c, "start", at);
  if (!(await mensalidadeAvailable(ctx.env, ctx.profile)))
    return showOffers(ctx, c, session, rowId);
  const found = await situationByPhone(
    ctx.env,
    ctx.profile,
    c.phone || c.external_id,
    at,
  );
  if (found) return onSituation(ctx, c, session, found, rowId);
  return askDocument(ctx, c, session, "identify", rowId);
}

async function askDocument(
  ctx: ModuleContext,
  c: Conversation,
  session: any,
  purpose: "identify" | "purchase",
  rowId: string,
) {
  await updateSession(ctx, session, { step: "ask_document", purpose });
  await say(
    ctx,
    c,
    purpose === "identify"
      ? "Para conferir o seu suporte, digite o CPF ou o CNPJ de quem paga (só os números)."
      : "Para a compra, digite o CPF ou o CNPJ de quem paga (só os números).",
    `pedir-documento:${rowId}`,
  );
}

async function onSituation(
  ctx: ModuleContext,
  c: Conversation,
  session: any,
  situation: PayerSituation,
  rowId: string,
) {
  const cfg = suporteSettings(await ctx.settings());
  const linked = situation.phone_linked !== false;
  session = await updateSession(ctx, session, {
    payer_id: situation.payer.id,
    matched_by: situation.matched_by,
    phone_linked: linked ? 1 : 0,
    name: situation.payer.name,
    document: situation.payer.document,
  });
  await ctx.publish(
    "suporte.identified",
    session.id,
    {
      session_id: session.id,
      conversation_id: c.id,
      payer_id: situation.payer.id,
      matched_by: situation.matched_by,
      phone_linked: linked,
      status: situation.status,
    },
    { key: `${session.id}:identified` },
  );
  const payer = {
    id: situation.payer.id,
    name: situation.payer.name,
    document_display: situation.payer.document_display,
  };
  if (!linked && cfg.identify === "linked_only") {
    await updateSession(ctx, session, {
      status: "awaiting_team",
      step: "awaiting_team",
    });
    await ctx.publish(
      "suporte.awaiting_team",
      session.id,
      { session_id: session.id, conversation_id: c.id, payer_id: payer.id },
      { key: `${session.id}:awaiting_team` },
    );
    await say(
      ctx,
      c,
      "Este número ainda não está autorizado para este CPF/CNPJ. Vamos passar para a nossa equipe confirmar antes de continuar.",
      `confirmar:${rowId}`,
    );
    await passToTeam(
      ctx,
      c,
      `Suporte pago NÃO liberado: confirme a identidade antes de atender. Telefone não vinculado ao pagador ${payer.name || ""}${payer.document_display ? ` (${payer.document_display})` : ""}; situação ${situation.status.replace("_", " ")}. Em Dados da conversa → Suporte pago, confirme e vincule.`,
    );
    return;
  }
  if (situation.status === "em_dia") {
    await release(ctx, {
      c,
      session,
      kind: "subscription",
      ref: situation.subscriptions[0]?.id ?? null,
      payer,
      phone_linked: linked,
      until_ticket: true,
      actor: "system",
      sourceKey: `sessao:${session.id}`,
      detail: situation.subscriptions
        .map((s) => s.plan_name)
        .filter(Boolean)
        .join(", "),
    });
    return;
  }
  if (situation.status === "em_atraso" && situation.open_installment) {
    const inst = situation.open_installment;
    session = await updateSession(ctx, session, {
      offer_kind: "installment",
      offer_ref: inst.id,
      installment_id: inst.id,
    });
    const what = `${inst.plan_name ? inst.plan_name + " " : ""}${inst.period_label}`;
    const head = inst.upfront
      ? `A primeira mensalidade (${what}, ${money(inst.amount_cents)}) ainda não foi paga.`
      : `A mensalidade ${what} de ${money(inst.amount_cents)} venceu em ${dayLabel(inst.due_date)} e está em aberto.`;
    return askMethod(
      ctx,
      c,
      session,
      `${head} Para liberar o atendimento, pague agora:`,
      rowId,
    );
  }
  return showOffers(ctx, c, session, rowId);
}

// ---------------------------------------------------------------------------
// Ofertas (sem assinatura)

async function offers(ctx: ModuleContext, cfg: SuporteSettings) {
  if (!(await chargesReady(ctx.env, ctx.profile))) return [];
  const sections: {
    title: string;
    rows: { id: string; title: string; description: string }[];
  }[] = [];
  const packages = cfg.packages.filter((p) => p.active);
  if (packages.length)
    sections.push({
      title: "Suporte avulso",
      rows: packages.map((p) => ({
        id: `${PREFIX}pkg:${p.id}`,
        title: clip(p.name, 24),
        description: clip(
          `${money(p.price_cents)} · ${packageValidity(p)}`,
          72,
        ),
      })),
    });
  if (cfg.offer_plans && (await mensalidadeAvailable(ctx.env, ctx.profile))) {
    const plans = (await sellablePlans(ctx.env, ctx.profile)).filter(
      (p) => !cfg.plan_ids.length || cfg.plan_ids.includes(p.id),
    );
    if (plans.length)
      sections.push({
        title: "Plano mensal",
        rows: plans.slice(0, 10 - packages.length).map((p) => ({
          id: `${PREFIX}plan:${p.id}`,
          title: clip(p.name, 24),
          description: clip(
            `${money(p.amount_cents)} por ${p.period === "monthly" ? "mês" : p.period === "quarterly" ? "trimestre" : "ano"}${p.description ? ` · ${p.description}` : ""}`,
            72,
          ),
        })),
      });
  }
  return sections;
}

async function showOffers(
  ctx: ModuleContext,
  c: Conversation,
  session: any,
  rowId: string,
) {
  const cfg = suporteSettings(await ctx.settings());
  const sections = await offers(ctx, cfg);
  if (!sections.length) {
    await updateSession(ctx, session, { status: "closed" });
    await say(
      ctx,
      c,
      "O atendimento humano é para clientes com suporte contratado, e no momento não é possível contratar pelo WhatsApp. Envie MENU para ver as outras opções.",
      `sem-oferta:${rowId}`,
    );
    return;
  }
  await choose(
    ctx,
    c,
    session,
    "choose_offer",
    cfg.texts.offer,
    "Ver opções",
    sections,
    `ofertas:${rowId}`,
  );
}

async function askMethod(
  ctx: ModuleContext,
  c: Conversation,
  session: any,
  body: string,
  rowId: string,
) {
  const cfg = suporteSettings(await ctx.settings());
  if (cfg.methods.length === 1) {
    if (body) await say(ctx, c, body, `forma-texto:${rowId}`);
    return charge(ctx, c, session, cfg.methods[0], rowId);
  }
  await choose(
    ctx,
    c,
    session,
    "choose_method",
    body || "Como prefere pagar?",
    "Forma de pagamento",
    [
      {
        rows: cfg.methods.map((m) => ({
          id: `${PREFIX}method:${m}`,
          title: METHOD_LABELS[m],
          description:
            m === "pix"
              ? "Código copia e cola aqui na conversa"
              : "Página de pagamento do Mercado Pago",
        })),
      },
    ],
    `formas:${rowId}`,
  );
}

/** Depois de escolher a oferta: documento, nome e forma de pagamento. */
async function continuePurchase(
  ctx: ModuleContext,
  c: Conversation,
  session: any,
  rowId: string,
) {
  if (!session.payer_id && !session.document)
    return askDocument(ctx, c, session, "purchase", rowId);
  if (!session.payer_id && !session.name) {
    await updateSession(ctx, session, { step: "ask_name" });
    await say(
      ctx,
      c,
      "Qual o nome completo ou a razão social de quem paga?",
      `pedir-nome:${rowId}`,
    );
    return;
  }
  return askMethod(ctx, c, session, "", rowId);
}

async function chooseOffer(
  ctx: ModuleContext,
  c: Conversation,
  session: any,
  id: string,
  rowId: string,
) {
  const cfg = suporteSettings(await ctx.settings());
  const [, kind, ref] = id.split(":");
  if (kind === "pkg" && cfg.packages.some((p) => p.id === ref && p.active))
    session = await updateSession(ctx, session, {
      offer_kind: "package",
      offer_ref: ref,
    });
  else if (
    kind === "plan" &&
    (await sellablePlans(ctx.env, ctx.profile)).some((p) => p.id === ref)
  )
    session = await updateSession(ctx, session, {
      offer_kind: "plan",
      offer_ref: ref,
    });
  else {
    await say(
      ctx,
      c,
      "Esta opção não está mais disponível. Escolha Atendimento humano (pago) no menu de novo.",
      `indisponivel:${rowId}`,
    );
    await updateSession(ctx, session, { status: "closed" });
    return;
  }
  return continuePurchase(ctx, c, session, rowId);
}

// ---------------------------------------------------------------------------
// Cobrança

async function charge(
  ctx: ModuleContext,
  c: Conversation,
  session: any,
  method: "pix" | "link",
  rowId: string,
) {
  const cfg = suporteSettings(await ctx.settings());
  session = await updateSession(ctx, session, {
    method,
    step: "awaiting_payment",
  });
  try {
    if (session.offer_kind === "package") {
      const pkg = cfg.packages.find((p) => p.id === session.offer_ref)!;
      const purchase = await buyPackage(ctx, {
        c,
        session,
        pkg,
        method,
        payer_id: session.payer_id,
        document: session.document,
        name: session.name,
        sourceKey: `compra:${c.id}:${rowId}`,
      });
      await updateSession(ctx, session, { purchase_id: purchase.id });
    } else if (session.offer_kind === "plan") {
      const result = await contractPlan(ctx.env, ctx.profile, {
        conversation: c,
        plan_id: session.offer_ref,
        payer_id: session.payer_id,
        document: session.payer_id ? null : session.document,
        name: session.name,
        method,
        sourceKey: `suporte:${session.id}`,
        actor: customerOf(c),
      });
      await updateSession(ctx, session, {
        installment_id: result.installment.id,
        payer_id: result.payer.id,
      });
      await ctx.publish(
        "suporte.plan_contracted",
        session.id,
        {
          session_id: session.id,
          conversation_id: c.id,
          payer_id: result.payer.id,
          subscription_id: result.subscription.id,
          installment_id: result.installment.id,
          amount_cents: result.installment.amount_cents,
        },
        { key: `${session.id}:plan` },
      );
    } else {
      await chargeInstallment(ctx.env, ctx.profile, {
        conversation: c,
        installment_id: session.installment_id,
        method,
        key: `turno:${rowId}`,
      });
    }
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    await updateSession(ctx, session, { status: "closed" });
    await say(
      ctx,
      c,
      error.code === "nothing_to_pay"
        ? "Sua assinatura já está em dia. Escolha Atendimento humano (pago) no menu de novo para ser atendido."
        : "Não conseguimos gerar o pagamento agora. Tente de novo em alguns minutos ou envie MENU para voltar.",
      `erro-cobranca:${rowId}`,
    );
    return;
  }
  await say(
    ctx,
    c,
    "Assim que o pagamento for confirmado pelo banco, o atendimento é liberado aqui mesmo. Para receber o código de novo, responda 1; para trocar a forma de pagamento, 2.",
    `aguardando:${rowId}`,
  );
}

async function resend(
  ctx: ModuleContext,
  c: Conversation,
  session: any,
  rowId: string,
) {
  if (session.offer_kind === "package") {
    const purchase = session.purchase_id
      ? await one(
          ctx.env,
          "SELECT * FROM suporte_purchases WHERE id=?",
          session.purchase_id,
        )
      : null;
    if (
      purchase?.status === "pending" &&
      (purchase.payment_expires_at || 0) > now() + 60_000 &&
      (purchase.pix_code || purchase.pay_url)
    ) {
      await say(
        ctx,
        c,
        [
          `Suporte avulso: ${purchase.package_name}, ${money(purchase.price_cents)}.`,
          purchase.pay_url ? `Pagar: ${purchase.pay_url}` : "",
          purchase.pix_code ? `Pix copia e cola:\n${purchase.pix_code}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        `reenvio:${rowId}`,
      );
      return;
    }
    return charge(ctx, c, session, session.method || "pix", rowId);
  }
  try {
    await chargeInstallment(ctx.env, ctx.profile, {
      conversation: c,
      installment_id: session.installment_id,
      method: session.method || undefined,
      key: `reenvio:${rowId}`,
    });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    await say(
      ctx,
      c,
      "Não conseguimos gerar o pagamento agora. Tente de novo em alguns minutos.",
      `erro-reenvio:${rowId}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Respostas do cliente (onConversationTurn)

async function onDocument(
  ctx: ModuleContext,
  c: Conversation,
  session: any,
  text: string,
  rowId: string,
) {
  const cfg = suporteSettings(await ctx.settings());
  const doc = validDocument(text);
  if (!doc) {
    const attempts = session.attempts + 1;
    if (attempts >= cfg.max_attempts) {
      await updateSession(ctx, session, { attempts, status: "closed" });
      await ctx.publish(
        "suporte.identification_failed",
        session.id,
        { session_id: session.id, conversation_id: c.id, attempts },
        { key: `${session.id}:failed` },
      );
      await say(
        ctx,
        c,
        "Não conseguimos conferir o CPF ou CNPJ. Envie MENU para voltar às opções ou fale com a IA, que é grátis.",
        `documento-limite:${rowId}`,
      );
      return;
    }
    await updateSession(ctx, session, { attempts });
    await say(
      ctx,
      c,
      `CPF ou CNPJ inválido. Confira os números e envie de novo (tentativa ${attempts + 1} de ${cfg.max_attempts}).`,
      `documento-invalido:${rowId}`,
    );
    return;
  }
  if (await mensalidadeAvailable(ctx.env, ctx.profile)) {
    const situation = await situationByDocument(
      ctx.env,
      ctx.profile,
      doc.document,
      {
        phone: c.phone || c.external_id,
      },
    );
    if (situation) {
      // Já tinha escolhido a compra e o pagador existe: segue a compra se ele
      // não tem assinatura; senão vale a situação dele.
      if (
        session.purpose === "purchase" &&
        situation.status === "sem_assinatura"
      ) {
        session = await updateSession(ctx, session, {
          payer_id: situation.payer.id,
          matched_by: "document",
          phone_linked: situation.phone_linked === false ? 0 : 1,
          document: doc.document,
          name: situation.payer.name,
        });
        return continuePurchase(ctx, c, session, rowId);
      }
      return onSituation(ctx, c, session, situation, rowId);
    }
  }
  session = await updateSession(ctx, session, {
    document: doc.document,
    matched_by: "document",
  });
  if (session.purpose === "purchase")
    return continuePurchase(ctx, c, session, rowId);
  // Documento sem cadastro: oferece a contratação.
  return showOffers(ctx, c, session, rowId);
}

async function onName(
  ctx: ModuleContext,
  c: Conversation,
  session: any,
  text: string,
  rowId: string,
) {
  const name = (text || "").trim().replace(/\s+/g, " ");
  if (
    Array.from(name).length < 3 ||
    Array.from(name).length > 120 ||
    /^\d+$/.test(name)
  ) {
    await say(
      ctx,
      c,
      "Envie o nome completo ou a razão social (de 3 a 120 letras).",
      `nome-invalido:${rowId}`,
    );
    return;
  }
  session = await updateSession(ctx, session, { name });
  return continuePurchase(ctx, c, session, rowId);
}

async function onOption(
  ctx: ModuleContext,
  c: Conversation,
  session: any,
  id: string,
  rowId: string,
) {
  if (id.startsWith(`${PREFIX}method:`)) {
    const method = id.slice(`${PREFIX}method:`.length);
    if (method !== "pix" && method !== "link") return;
    return charge(ctx, c, session, method, rowId);
  }
  return chooseOffer(ctx, c, session, id, rowId);
}

/**
 * Devolve true quando a mensagem é do Suporte: toque numa opção `suporte:…`
 * ou resposta a uma sessão aberta (documento, nome, número da opção,
 * pagamento pendente). MENU/VOLTAR fecha a sessão e segue para o menu.
 */
export async function handleTurn(
  ctx: ModuleContext,
  c: Conversation,
  turn: { text: string; replyId: string | null; rowId: string },
) {
  if (c.chat_type === "group") return false;
  const at = now();
  if (turn.replyId) {
    if (!turn.replyId.startsWith(PREFIX)) return false;
    const session = await activeSession(ctx, c, at);
    if (
      !session ||
      !sessionOptions(session).some((o) => o.id === turn.replyId)
    ) {
      await say(
        ctx,
        c,
        "Esta opção não está mais disponível. Escolha Atendimento humano (pago) no menu de novo.",
        `opcao-antiga:${turn.rowId}`,
      );
      return true;
    }
    await onOption(ctx, c, session, turn.replyId, turn.rowId);
    return true;
  }
  const session = await activeSession(ctx, c, at);
  if (!session) return false;
  const value = normalize(turn.text || "");
  if (CANCEL.has(value)) {
    await updateSession(ctx, session, { status: "closed" });
    return false;
  }
  if (session.step === "ask_document")
    await onDocument(ctx, c, session, turn.text, turn.rowId);
  else if (session.step === "ask_name")
    await onName(ctx, c, session, turn.text, turn.rowId);
  else if (
    session.step === "choose_offer" ||
    session.step === "choose_method"
  ) {
    const options = sessionOptions(session);
    const chosen = /^\d+$/.test(value)
      ? options[Number(value) - 1]
      : options.find((o) => normalize(o.title) === value);
    if (!chosen) {
      await say(
        ctx,
        c,
        "Responda com o número de uma das opções ou envie MENU para voltar.",
        `opcao-invalida:${turn.rowId}`,
      );
      return true;
    }
    await onOption(ctx, c, session, chosen.id, turn.rowId);
  } else if (session.step === "awaiting_payment") {
    if (value === "1") await resend(ctx, c, session, turn.rowId);
    else if (value === "2")
      await askMethod(ctx, c, session, "Como prefere pagar?", turn.rowId);
    else
      await say(
        ctx,
        c,
        "Ainda não recebemos a confirmação do pagamento. Ela chega sozinha do banco e o atendimento é liberado aqui mesmo. Responda 1 para receber o código de novo, 2 para trocar a forma de pagamento, ou MENU para voltar.",
        `aguardando-confirmacao:${turn.rowId}`,
      );
  } else return false;
  return true;
}

// ---------------------------------------------------------------------------
// Parcela paga (aviso da Mensalidade)

/**
 * Parcela da Mensalidade paga (webhook ou baixa manual): libera as sessões
 * que esperavam por ela (plano contratado ou mensalidade em atraso).
 */
export async function installmentPaid(
  env: Env,
  profile: string,
  inst: InstallmentPaid,
) {
  const ctx = modulesApi(env, profile, "suporte");
  if (!(await ctx.enabled())) return;
  const sessions = await all(
    env,
    "SELECT * FROM suporte_sessions WHERE profile_id=? AND installment_id=? AND status='active'",
    profile,
    inst.id,
  );
  for (const session of sessions) {
    let c: Conversation;
    try {
      c = await ctx.conversation(session.conversation_id);
    } catch {
      continue;
    }
    const payer = inst.payer_id
      ? (await situationByPayer(env, profile, inst.payer_id)).payer
      : null;
    await release(ctx, {
      c,
      session,
      kind: session.offer_kind === "plan" ? "subscription" : "installment",
      ref: inst.id,
      payer: payer
        ? {
            id: payer.id,
            name: payer.name,
            document_display: payer.document_display,
          }
        : null,
      phone_linked: session.phone_linked !== 0,
      until_ticket: true,
      actor: inst.paid_via === "manual" ? inst.paid_by : "provider",
      sourceKey: `sessao:${session.id}`,
      detail: `${money(inst.amount_cents)} pago${inst.paid_via === "manual" ? " (baixa manual)" : ""}`,
    });
  }
}

/** Confirmação da equipe no modo "só telefone vinculado". */
export async function confirmByTeam(
  ctx: ModuleContext,
  c: Conversation,
  actor: string,
  options: { link: boolean },
  linkPhoneFn: (payerId: string, phone: string) => Promise<unknown>,
) {
  const session = await one(
    ctx.env,
    "SELECT * FROM suporte_sessions WHERE conversation_id=? AND profile_id=? AND status='awaiting_team' ORDER BY created DESC LIMIT 1",
    c.id,
    ctx.profile,
  );
  if (!session?.payer_id)
    throw new ApiError(
      409,
      "nothing_to_confirm",
      "Esta conversa não espera confirmação do suporte pago.",
    );
  const phone = phoneDigits(c.phone || c.external_id);
  if (options.link) await linkPhoneFn(session.payer_id, phone);
  const situation = await situationByPayer(
    ctx.env,
    ctx.profile,
    session.payer_id,
    { phone },
  );
  if (situation.status !== "em_dia")
    throw new ApiError(
      409,
      "payment_required",
      situation.status === "em_atraso"
        ? "O pagador está com a mensalidade em atraso. Peça para escolher Atendimento humano (pago) no menu e pagar, ou libere como cortesia."
        : "O pagador não tem assinatura ativa. Peça para contratar pelo menu ou libere como cortesia.",
    );
  return release(ctx, {
    c,
    session: await loadSession(ctx, session.id),
    kind: "team",
    ref: situation.subscriptions[0]?.id ?? null,
    payer: {
      id: situation.payer.id,
      name: situation.payer.name,
      document_display: situation.payer.document_display,
    },
    phone_linked: options.link || situation.phone_linked === true,
    until_ticket: true,
    actor,
    sourceKey: `confirmado:${session.id}`,
    pass: false,
  });
}

export const recentSessions = (ctx: ModuleContext, conversationId: string) =>
  all(
    ctx.env,
    "SELECT * FROM suporte_sessions WHERE conversation_id=? AND profile_id=? ORDER BY created DESC LIMIT 5",
    conversationId,
    ctx.profile,
  );
