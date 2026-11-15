// Formulários (módulo "forms"): cadastro nas configurações da área (chave
// "forms"), envio pelo passo web e reação à conclusão. Fala com o núcleo só
// pela interface de src/modules/api.ts, como uma vertical da onda 2.
import {
  ApiError,
  type Actor,
  type Conversation,
  requireValue,
} from "../../types";
import { validateFields, type WebField } from "../../web-steps";
import {
  onCommand,
  onConversationAction,
  onMenuChoice,
  onRead,
  onRoute,
  onSettingsSave,
  onWebStepCompleted,
  type ModuleContext,
} from "../api";

export const FORMS_LIMIT = 30;

export interface FormDefinition {
  id: string;
  /** Nome interno, visto pela equipe. */
  name: string;
  /** Título da página aberta pelo cliente. */
  title: string;
  intro?: string;
  fields: WebField[];
  submit_label?: string;
  done_text?: string;
  return_text?: string;
  /** Texto da mensagem que leva o link. */
  message?: string;
  /** Rótulo do botão com URL nas linhas oficiais. */
  button?: string;
  ticket: "attach" | "open" | "none";
  ticket_category?: string | null;
  /** Validade do link, em horas (1 a 168). */
  expires_hours: number;
  enabled: boolean;
  /**
   * Flow publicado na conta WhatsApp Business (src/whatsapp-flows.ts) com os
   * mesmos campos: nas linhas oficiais, o formulário abre dentro do WhatsApp.
   * Os nomes dos campos do Flow são os ids dos campos daqui.
   */
  flow_id?: string;
  flow_cta?: string;
  flow_screen?: string;
}

const text = (
  value: unknown,
  max: number,
  what: string,
  required = false,
): string => {
  if (value === undefined || value === null || value === "") {
    requireValue(!required, `Formulário: informe ${what}.`);
    return "";
  }
  requireValue(
    typeof value === "string" && Array.from(value.trim()).length <= max,
    `Formulário: ${what} com até ${max} caracteres.`,
  );
  return (value as string).trim();
};

/** Validação estrita da chave "forms" em PUT /settings. */
export function validateForms(value: unknown): FormDefinition[] {
  requireValue(
    Array.isArray(value) && value.length <= FORMS_LIMIT,
    `Cadastre até ${FORMS_LIMIT} formulários.`,
  );
  const ids = new Set<string>();
  return (value as any[]).map((raw) => {
    requireValue(raw && typeof raw === "object", "Formulário inválido.");
    const id = text(raw.id, 100, "o identificador", true);
    requireValue(
      /^[A-Za-z0-9_-]+$/.test(id) && !ids.has(id),
      "Identificador de formulário inválido ou repetido.",
    );
    ids.add(id);
    const name = text(raw.name, 80, "o nome", true);
    const form: FormDefinition = {
      id,
      name,
      title: text(raw.title, 120, "o título") || name,
      fields: validateFields(raw.fields),
      ticket: raw.ticket ?? "attach",
      expires_hours: raw.expires_hours ?? 24,
      enabled: raw.enabled === undefined ? true : raw.enabled === true,
    };
    requireValue(
      ["attach", "open", "none"].includes(form.ticket),
      `Formulário "${name}": protocolo deve ser attach, open ou none.`,
    );
    requireValue(
      Number.isInteger(form.expires_hours) &&
        form.expires_hours >= 1 &&
        form.expires_hours <= 168,
      `Formulário "${name}": validade de 1 a 168 horas.`,
    );
    for (const [key, max, what] of [
      ["intro", 1500, "a introdução"],
      ["submit_label", 30, "o texto do botão de envio"],
      ["done_text", 600, "o texto de conclusão"],
      ["return_text", 900, "a mensagem de retorno"],
      ["message", 900, "a mensagem com o link"],
      ["button", 20, "o rótulo do botão do WhatsApp"],
      ["flow_id", 100, "o Flow publicado"],
      ["flow_cta", 30, "o botão do Flow"],
      ["flow_screen", 100, "a tela inicial do Flow"],
    ] as const) {
      const value = text(raw[key], max, what);
      if (value) form[key] = value;
    }
    if (raw.ticket_category)
      form.ticket_category = text(raw.ticket_category, 100, "a categoria");
    return form;
  });
}

export const formsOf = (cfg: any): FormDefinition[] =>
  Array.isArray(cfg?.forms) ? cfg.forms : [];

/** Envia o link de um formulário na conversa (menu, atendente ou bot). */
export async function sendForm(
  ctx: ModuleContext,
  c: Conversation,
  formId: unknown,
  options: {
    trigger: "menu" | "agent" | "bot";
    actor: string;
    sourceKey: string;
  },
) {
  await ctx.requireEnabled();
  const form = formsOf(await ctx.settings()).find((f) => f.id === formId);
  requireValue(form, "Formulário não encontrado.");
  if (!form.enabled)
    throw new ApiError(
      409,
      "form_disabled",
      `O formulário "${form.name}" está desativado.`,
    );
  return ctx.openWebStep(c, {
    kind: "form",
    ref: form.id,
    trigger: options.trigger,
    actor: options.actor,
    sourceKey: options.sourceKey,
    ttlMinutes: form.expires_hours * 60,
    text: form.message,
    button: form.button || "Abrir formulário",
    flow: form.flow_id
      ? {
          flow_id: form.flow_id,
          flow_cta: form.flow_cta || form.button || "Abrir formulário",
          screen: form.flow_screen,
        }
      : null,
    spec: {
      title: form.title,
      intro: form.intro,
      fields: form.fields,
      submit_label: form.submit_label,
      done_text: form.done_text,
      return_text: form.return_text,
      ticket: form.ticket,
      ticket_category: form.ticket_category,
    },
  });
}

/** GET /profiles/:profile/forms: formulários ativos, para apps e bots. */
async function formsView(ctx: ModuleContext, actor: Actor) {
  ctx.access(actor, "conversations:read");
  return {
    data: formsOf(await ctx.settings())
      .filter((f) => f.enabled)
      .map((f) => ({
        id: f.id,
        name: f.name,
        title: f.title,
        fields: f.fields.map((field) => ({
          id: field.id,
          type: field.type,
          label: field.label,
          required: field.required,
        })),
      })),
  };
}

// ---------------------------------------------------------------------------
// Ganchos (carregados por src/modules/runtime.ts)

onSettingsSave("forms", "forms", validateForms);

// Item de menu "Responder formulário".
onMenuChoice("form", async (ctx, c, item, { rowId }) => {
  try {
    await sendForm(ctx, c, item.form_id, {
      trigger: "menu",
      actor: "system",
      sourceKey: `menu:${rowId}`,
    });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    await ctx.sendMessage(
      c,
      {
        text: "Este formulário não está disponível agora. Envie MENU para ver as opções.",
      },
      { key: `menu-unavailable:${rowId}` },
    );
  }
});

// Ação do atendente (painel), de uma integração ou de um bot (MCP send_form).
onConversationAction("forms", "form", async (ctx, actor, c, data, request) => {
  const bot = actor.id.startsWith("bot:");
  requireValue(
    c.owner === actor.id ||
      (actor.kind === "user" && actor.role === "admin") ||
      (bot && c.state === "ai"),
    "Assuma a conversa antes de enviar um formulário.",
  );
  const result = await sendForm(ctx, c, data.form_id, {
    trigger: actor.kind === "user" && !bot ? "agent" : "bot",
    actor: actor.id,
    sourceKey: `action:${actor.id}:${request.requestId}`,
  });
  return result.step;
});

// GET /profiles/:profile/forms (leitura do módulo, fora do Coordinator).
onRead("forms", "forms", (ctx, actor) => formsView(ctx, actor));

// POST /profiles/:profile/forms/:id/send {conversation_id}: o mesmo envio da
// ação de conversa, como recurso REST para integrações.
onRoute("forms", { method: "POST", path: "forms/:id/send", op: "form.send" });
onCommand("forms", "form.send", async (ctx, actor, data, request) => {
  ctx.access(actor, "conversations:write");
  requireValue(
    typeof data.conversation_id === "string",
    "Informe conversation_id.",
  );
  const c = await ctx.conversation(data.conversation_id, actor);
  const bot = actor.id.startsWith("bot:");
  requireValue(
    c.owner === actor.id ||
      (actor.kind === "user" && actor.role === "admin") ||
      (bot && c.state === "ai"),
    "Assuma a conversa antes de enviar um formulário.",
  );
  const result = await sendForm(ctx, c, data.id, {
    trigger: actor.kind === "user" && !bot ? "agent" : "bot",
    actor: actor.id,
    sourceKey: `command:${actor.id}:${request.requestId}`,
  });
  return result.step;
});

// Conclusão: publica form.submitted com as respostas, para integrações.
onWebStepCompleted("forms", async (ctx, step, answers) => {
  await ctx.publish("form.submitted", step.id, {
    form_id: step.ref_id,
    web_step_id: step.id,
    conversation_id: step.conversation_id,
    contact_id: step.contact_id,
    ticket_id: step.ticket_id,
    answers,
  });
});
