// Cadastro de clientes: o próprio cliente preenche ou corrige a ficha por um
// link de uso único (passo web) enviado na conversa. As respostas não ficam
// no núcleo (spec.private_answers): só a ficha as guarda.
import { one } from "../../db";
import { ApiError, type Conversation, requireValue } from "../../types";
import type { ModuleContext, WebStep } from "../api";
import {
  addressView,
  documentDisplay,
  maskEmail,
  parseDocument,
  type ClientesSettings,
} from "./model";
import {
  addPhone,
  checkShape,
  createCustomer,
  customerByDocument,
  customerByPhone,
  customerFields,
  customerPhones,
  recordConsent,
  settingsOf,
  updateCustomer,
  type CustomerInput,
} from "./store";

export const SELF_KIND = "cadastro";
const KIND_OPTIONS = ["Pessoa física (CPF)", "Pessoa jurídica (CNPJ)"];
const IE_OPTIONS = [
  "Contribuinte do ICMS (tenho IE)",
  "Isento de inscrição estadual",
  "Não contribuinte",
];
const IE_CODES = ["1", "2", "9"];

/** Campos do formulário; na correção, o atual (mascarado) vai na ajuda. */
export function formFields(settings: ClientesSettings, current: any | null) {
  const update = !!current;
  const keep = (value: string | null | undefined) =>
    update ? (value ? `Atual: ${value}. Em branco, mantém.` : "Em branco, mantém.") : undefined;
  const address = current ? addressView(current, true) : null;
  const req = (needed: boolean) => !update && needed;
  const fields: any[] = [
    {
      id: "tipo",
      type: "choice",
      label: "Tipo de cadastro",
      required: !update,
      options: KIND_OPTIONS,
      ...(update ? { help: "Em branco, mantém." } : {}),
    },
    {
      id: "nome",
      type: "text",
      label: "Nome completo ou razão social",
      required: !update,
      ...(update ? { help: keep(current.name) } : {}),
    },
    {
      id: "nome_fantasia",
      type: "text",
      label: "Nome fantasia (empresa)",
      required: false,
      ...(update ? { help: keep(current.trade_name) } : {}),
    },
    {
      id: "documento",
      type: "text",
      label: "CPF ou CNPJ",
      required: req(settings.require_document),
      help: update
        ? keep(documentDisplay(current, true))
        : "Para a nota fiscal. Só números ou com pontuação.",
    },
    {
      id: "mei",
      type: "accept",
      label: "Meu CNPJ é de MEI ou empresário individual",
      required: false,
    },
    {
      id: "ie_situacao",
      type: "choice",
      label: "Inscrição estadual (empresa)",
      required: false,
      options: IE_OPTIONS,
    },
    {
      id: "ie",
      type: "text",
      label: "Número da inscrição estadual",
      required: false,
      ...(update ? { help: keep(current.ie ? "•••" : "") } : {}),
    },
    {
      id: "im",
      type: "text",
      label: "Inscrição municipal (para nota de serviço)",
      required: false,
    },
    {
      id: "email",
      type: "text",
      label: "E-mail para receber a nota",
      required: false,
      ...(update ? { help: keep(maskEmail(current.email)) } : {}),
    },
    {
      id: "cep",
      type: "text",
      label: "CEP",
      required: req(settings.require_address),
      ...(update ? { help: keep(address?.cep) } : {}),
    },
    {
      id: "logradouro",
      type: "text",
      label: "Rua, avenida…",
      required: req(settings.require_address),
      ...(update ? { help: keep(address?.street) } : {}),
    },
    {
      id: "numero",
      type: "text",
      label: "Número",
      required: req(settings.require_address),
    },
    { id: "complemento", type: "text", label: "Complemento", required: false },
    {
      id: "bairro",
      type: "text",
      label: "Bairro",
      required: req(settings.require_address),
    },
    {
      id: "cidade",
      type: "text",
      label: "Cidade",
      required: req(settings.require_address),
      ...(update ? { help: keep(current.city) } : {}),
    },
    {
      id: "uf",
      type: "text",
      label: "Estado (sigla, ex.: SP)",
      required: req(settings.require_address),
      ...(update ? { help: keep(current.uf) } : {}),
    },
    {
      id: "ibge",
      type: "text",
      label: "Código IBGE da cidade (se souber)",
      required: false,
      help: "7 números. Se não souber, deixe em branco: a equipe completa.",
    },
    {
      id: "aceite",
      type: "accept",
      label: settings.consent_text,
      required: true,
    },
  ];
  return fields.map(({ help, ...f }) => (help ? { ...f, help } : f));
}

/** Respostas do formulário → campos da ficha (só os preenchidos). */
export function answersToInput(answers: Record<string, any>): CustomerInput {
  const s = (key: string) =>
    typeof answers[key] === "string" ? answers[key].trim() : "";
  const input: CustomerInput = {};
  const kind = KIND_OPTIONS.indexOf(s("tipo"));
  if (kind >= 0) input.kind = kind === 0 ? "pf" : "pj";
  const doc = s("documento");
  if (doc) {
    input.document = doc;
    // Sem o tipo marcado (correção), o documento decide.
    const parsed = parseDocument(doc);
    if (parsed && input.kind === undefined)
      input.kind = parsed.type === "cpf" ? "pf" : "pj";
  }
  if (s("nome")) input.name = s("nome");
  if (s("nome_fantasia")) input.trade_name = s("nome_fantasia");
  if (answers.mei === true) input.individual_business = true;
  const ie = IE_OPTIONS.indexOf(s("ie_situacao"));
  if (ie >= 0) input.ie_indicator = IE_CODES[ie];
  if (s("ie")) input.ie = s("ie");
  if (s("im")) input.im = s("im");
  if (s("email")) input.email = s("email");
  for (const [from, to] of [
    ["cep", "cep"],
    ["logradouro", "street"],
    ["numero", "number"],
    ["complemento", "complement"],
    ["bairro", "district"],
    ["cidade", "city"],
    ["uf", "uf"],
    ["ibge", "city_ibge"],
  ] as const)
    if (s(from)) (input as any)[to] = s(from);
  return input;
}

/** Ficha da conversa: pelo telefone autenticado pelo canal. */
export async function customerOfConversation(
  ctx: ModuleContext,
  c: Conversation,
) {
  const phone = ctx.verifiedPhone(c);
  return phone ? customerByPhone(ctx, phone) : null;
}

/**
 * Envia (ou reenvia) o link do cadastro na conversa. Com ficha, o link
 * corrige a ficha; sem ficha, cria uma. `sourceKey`: idempotência.
 */
export async function sendRegistrationLink(
  ctx: ModuleContext,
  c: Conversation,
  options: {
    trigger: "menu" | "agent" | "module";
    actor: string;
    sourceKey: string;
  },
) {
  requireValue(c.chat_type !== "group", "O cadastro é feito em conversa individual.");
  if (!ctx.verifiedPhone(c))
    throw new ApiError(
      409,
      "phone_unverified",
      "Esta conversa não tem telefone confirmado pelo WhatsApp: o cadastro precisa ser enviado na conversa do próprio cliente.",
    );
  const settings = await settingsOf(ctx);
  const current = await customerOfConversation(ctx, c);
  if (current && current.status !== "active")
    throw new ApiError(
      409,
      "customer_erasing",
      "A exclusão dos dados deste cliente está em andamento.",
    );
  const opened = await ctx.openWebStep(c, {
    kind: SELF_KIND,
    ref: current?.id ?? null,
    trigger: options.trigger,
    actor: options.actor,
    sourceKey: options.sourceKey,
    ttlMinutes: 48 * 60,
    text: current
      ? "Para conferir ou corrigir o seu cadastro, abra o link. Os dados atuais aparecem parcialmente escondidos."
      : "Para fazer o seu cadastro (usado também na nota fiscal), abra o link.",
    button: current ? "Corrigir cadastro" : "Fazer cadastro",
    spec: {
      title: current ? "Corrigir meu cadastro" : "Meu cadastro",
      intro: current
        ? "Preencha só o que quiser mudar. Para excluir seus dados, escreva " +
          settings.erase_keywords[0] +
          " na conversa."
        : "Seus dados ficam protegidos: a equipe vê parte deles escondida. Você pode corrigir ou pedir a exclusão quando quiser.",
      fields: formFields(settings, current),
      submit_label: "Salvar cadastro",
      done_text: "Cadastro salvo. Pode voltar ao WhatsApp.",
      return_message: "module",
      ticket: "none",
      private_answers: true,
    } as any,
  });
  return { ...opened, customer_id: current?.id ?? null };
}

/** Mensagem de recusa para a página (o link continua aberto) ou null. */
export async function validateSelfService(
  ctx: ModuleContext,
  step: WebStep,
  answers: Record<string, any>,
): Promise<string | null> {
  const settings = await settingsOf(ctx);
  const input = answersToInput(answers);
  try {
    const c = await ctx.conversation(step.conversation_id);
    const mine = step.ref_id
      ? await one(
          ctx.env,
          "SELECT * FROM clientes_customers WHERE id=? AND profile_id=?",
          step.ref_id,
          ctx.profile,
        )
      : await customerOfConversation(ctx, c);
    if (mine && mine.status !== "active")
      return "Seu pedido de exclusão está em andamento: o cadastro não pode ser alterado.";
    const fields = customerFields(input, !!mine);
    if (!mine && settings.require_document && !fields.document)
      return "Informe o CPF ou CNPJ.";
    checkShape({ ...(mine || {}), ...fields });
    if (fields.document) {
      const other = await customerByDocument(ctx, fields.document);
      if (other && other.id !== mine?.id) {
        // Ficha da equipe sem telefone confirmado: o cliente assume.
        const phones = await customerPhones(ctx, other.id);
        if (phones.some((p) => p.verified) || other.status !== "active")
          return "Este CPF/CNPJ já está cadastrado com outro telefone. Fale com a equipe.";
      }
    }
  } catch (error) {
    if (error instanceof ApiError) return error.message;
    throw error;
  }
  return null;
}

/** Conclusão do link: cria ou corrige a ficha e registra o aceite. */
export async function completeSelfService(
  ctx: ModuleContext,
  step: WebStep,
  answers: Record<string, any>,
) {
  const settings = await settingsOf(ctx);
  const c = await ctx.conversation(step.conversation_id);
  const phone = ctx.verifiedPhone(c);
  const actor = `customer:${c.id}`;
  const input = answersToInput(answers);
  let row: any = null;
  if (step.ref_id)
    row = await one(
      ctx.env,
      "SELECT * FROM clientes_customers WHERE id=? AND profile_id=?",
      step.ref_id,
      ctx.profile,
    );
  if (!row && phone) row = await customerByPhone(ctx, phone);
  if (!row && input.document) {
    const doc = parseDocument(input.document);
    if (doc) row = await customerByDocument(ctx, doc.document);
  }
  let created = false;
  if (row) {
    if (row.status !== "active")
      return "Seu pedido de exclusão está em andamento: o cadastro não foi alterado.";
    row = (
      await updateCustomer(ctx, row, input, {
        actor,
        checkVersion: false,
      })
    ).row;
  } else {
    row = await createCustomer(
      ctx,
      { ...input, name: input.name },
      { source: "self", actor, verifiedPhone: phone },
    );
    created = true;
  }
  if (phone)
    await addPhone(ctx, row.id, phone, { verified: true, actor });
  await recordConsent(ctx, row.id, {
    source: "web_step",
    settings,
    key: `step:${step.id}`,
    evidence: {
      web_step_id: step.id,
      conversation_id: c.id,
      accepted: answers.aceite === true,
      channel: phone ? "whatsapp_link" : "link",
    },
  });
  const erase = settings.erase_keywords[0];
  return created
    ? `Cadastro feito! Para corrigir, escolha "Meu cadastro" no menu. Para excluir seus dados, escreva ${erase}.`
    : `Cadastro atualizado! Para excluir seus dados, escreva ${erase}.`;
}
