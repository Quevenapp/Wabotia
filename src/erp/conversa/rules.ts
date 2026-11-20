// Regras puras do envio de documentos do ERP pela conversa: como o envio sai
// pela regra do WhatsApp que o sistema já aplica (janela de 24 horas, modelo
// aprovado, política da linha), os textos da mensagem e o registro "Enviado
// pelo WhatsApp a … por … em …". Sem banco e sem rede: os testes do Node
// importam este arquivo (só sintaxe TypeScript apagável).
import type { ErpConversaDocType } from "./contract.ts";

export const WINDOW_MS = 86_400_000;
/** Anexo de saída: o mesmo teto dos documentos dos módulos (10 MiB). */
export const FILE_LIMIT = 10 * 1024 * 1024;
export const MAX_FILES = 10;
/** Validade do link público (o máximo do passo web, 7 dias). */
export const LINK_TTL_MINUTES = 7 * 24 * 60;

export type WindowState = "aberta" | "fechada" | "sem_janela";
/** arquivo: mensagem com anexo; mensagem: só texto (cobrança); link: botão com o link seguro;
 * modelo: fora da janela, pelo modelo aprovado da área, com o link no texto; bloqueado: não sai. */
export type SendMode = "arquivo" | "mensagem" | "link" | "modelo" | "bloqueado";

export interface LineInfo {
  id: string; name: string; kind: string; number: string;
  /** Número gerenciado pelo roteador (meta_numbers): fora da janela, só modelo pago. */
  managed: boolean;
  /** Política da linha: envio por atendentes e por modelo. */
  human: boolean; templates: boolean;
}
export interface ConversationInfo { id: string; last_customer: number; owner: string | null; state: string }
export interface DecisionInput {
  line: LineInfo;
  conversation: ConversationInfo | null;
  now: number;
  files: readonly { size: number }[];
  /** Modelo de aviso da área (Ajustes → Notificações). */
  notifications: { enabled: boolean; template: string | null };
  /** O cliente autorizou avisos desta finalidade nesta conversa. */
  consent: boolean;
  purpose: "order" | "billing";
}
export interface Decision {
  mode: SendMode;
  window: WindowState;
  /** O que falta ou o que acontece, em português. */
  reason: string | null;
  template: string | null;
  /** Dá para criar o link de leitura e copiar (há ou se abre uma conversa). */
  can_copy_link: boolean;
  /** Não há conversa com o número: abre uma, atribuída a quem envia. */
  new_conversation: boolean;
}

export const official = (kind: string) => kind === "zernio" || kind === "meta";
const PURPOSE_LABEL = { order: "pedidos", billing: "cobranças" } as const;

export function decideSend(input: DecisionInput): Decision {
  const { line, conversation } = input;
  const newConversation = !conversation;
  const canOpen = line.kind === "zernio";
  const base = { template: null, can_copy_link: !!conversation || canOpen, new_conversation: newConversation };
  const window: WindowState = !official(line.kind) ? "sem_janela"
    : conversation && input.now - conversation.last_customer < WINDOW_MS ? "aberta" : "fechada";
  const blocked = (reason: string, extra: Partial<Decision> = {}): Decision => ({ ...base, mode: "bloqueado", window, reason, ...extra });
  if (!line.human)
    return blocked("Esta linha não permite envio por atendentes. Confira as permissões da linha em Conexões.");
  if (!conversation && !canOpen)
    return blocked(official(line.kind)
      ? "Conversa nova com quem nunca escreveu só abre pela linha oficial. Escolha outra linha ou copie o link."
      : "Esta linha (conectada pelo QR) só conversa com quem já escreveu para ela. Escolha a linha oficial da área.",
    { can_copy_link: false });
  if (window !== "fechada") {
    const fits = input.files.length <= MAX_FILES && input.files.every(file => file.size > 0 && file.size <= FILE_LIMIT);
    if (!input.files.length) return { ...base, mode: "mensagem", window, reason: null };
    return fits ? { ...base, mode: "arquivo", window, reason: null }
      : { ...base, mode: "link", window, reason: "O arquivo passa do tamanho que a linha envia; vai um link seguro para o cliente abrir o documento." };
  }
  // Fora da janela de 24 horas: só modelo aprovado. Nada de contornar a janela.
  const closed = newConversation ? "O cliente nunca escreveu para esta linha" : "O cliente não escreve há mais de 24 horas";
  if (line.managed)
    return blocked(`${closed}. Nesta linha gerenciada pelo roteador, fora da janela só sai modelo pago com autorização de cobrança, que não é oferecido aqui. Copie o link e mande por outro meio, ou espere o cliente escrever.`);
  if (!line.templates)
    return blocked(`${closed}, e esta linha não permite envio por modelo. Copie o link e mande por outro meio, ou espere o cliente escrever.`);
  if (!input.notifications.enabled || !input.notifications.template)
    return blocked(`${closed}. Fora da janela de 24 horas só sai mensagem por modelo aprovado, e a área não tem o modelo de aviso ligado (Ajustes → Notificações). Copie o link ou espere o cliente escrever.`);
  if (!input.consent)
    return blocked(`${closed}. Fora da janela de 24 horas o modelo só vai a quem autorizou avisos de ${PURPOSE_LABEL[input.purpose]}, e este cliente ainda não autorizou nesta conversa. Copie o link ou espere o cliente escrever.`);
  return { ...base, mode: "modelo", window, template: input.notifications.template,
    reason: `${closed}: vai pelo modelo aprovado "${input.notifications.template}", com o link seguro do documento no texto (o arquivo não vai anexado).` };
}

/** Caminho do documento no painel do ERP (depois de /app/erp). */
export function erpPath(type: ErpConversaDocType, id: string): string {
  if (type === "nota") return `/historico-fiscal?modelo=55&emissao=${id}`;
  if (type === "conta") return `/financeiro-empresa?area=receivable&titulo=${id}`;
  return `/documentos-empresa?tipo=${type === "proposta" ? "sales_proposals" : "sales_orders"}&documento=${id}`;
}

// ---------------------------------------------------------------------------
// Textos

/** Centavos (texto de dígitos) em reais: "R$ 1.234,56". */
export function money(cents: string | number | bigint | null | undefined): string | null {
  const text = typeof cents === "bigint" ? cents.toString() : typeof cents === "number" ? (Number.isSafeInteger(cents) ? String(cents) : "") : cents ?? "";
  if (!/^-?\d{1,15}$/.test(text)) return null;
  const negative = text.startsWith("-"), digits = text.replace("-", "").padStart(3, "0");
  const whole = digits.slice(0, -2).replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}R$ ${whole},${digits.slice(-2)}`;
}
/** Valor decimal com ponto ("1234.5") em centavos. */
export function decimalCents(value: unknown): string | null {
  if (typeof value !== "string" || !/^-?\d{1,13}(\.\d{1,6})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.replace("-", "").split(".");
  const cents = BigInt(whole!) * 100n + BigInt((fraction + "00").slice(0, 2)) + (Number((fraction + "000").charAt(2)) >= 5 ? 1n : 0n);
  return (value.startsWith("-") ? "-" : "") + cents.toString();
}
/** AAAA-MM-DD em DD/MM/AAAA. */
export const day = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10).split("-").reverse().join("/") : null;

/** Telefone para a tela: "(11) 98765-4321" no Brasil, "+<dígitos>" fora. */
export function formatPhone(digits: string): string {
  const br = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(digits);
  return br ? `(${br[1]}) ${br[2]}-${br[3]}` : `+${digits}`;
}
/** Telefone mascarado no registro do documento: "(11) 9…-4321". */
export function maskPhone(digits: string): string {
  const br = /^55(\d{2})(\d)\d*(\d{4})$/.exec(digits);
  return br ? `(${br[1]}) ${br[2]}…-${br[3]}` : `+${digits.slice(0, 2)}…${digits.slice(-4)}`;
}
const firstName = (name: string | null | undefined) => (name ?? "").trim().split(/\s+/)[0] || "";

export interface MessageFacts {
  type: ErpConversaDocType;
  /** "proposta comercial nº 123". */
  label: string;
  customer: string | null;
  total_cents: string | null;
  valid_until?: string | null;
  due_on?: string | null;
  description?: string | null;
  pix?: string | null;
  payment_link?: string | null;
  attachments: number;
}

/** Texto da mensagem ao cliente (sem o link; o link vai no botão ou no fim). */
export function messageText(facts: MessageFacts): string {
  const hello = firstName(facts.customer) ? `Olá, ${firstName(facts.customer)}!` : "Olá!";
  const value = money(facts.total_cents);
  const lines: string[] = [];
  if (facts.type === "conta") {
    lines.push(`${hello} Segue a cobrança${facts.description ? ` de ${facts.description}` : ""}${value ? `, no valor de ${value}` : ""}${day(facts.due_on) ? `, com vencimento em ${day(facts.due_on)}` : ""}.`);
    if (facts.payment_link) lines.push("", `Para pagar: ${facts.payment_link}`);
    if (facts.pix) lines.push("", "Pix copia e cola:", facts.pix);
    if (!facts.pix && !facts.payment_link) lines.push("", "Se tiver dúvida sobre como pagar, responda esta mensagem.");
    return lines.join("\n");
  }
  const what = facts.type === "nota" ? `a ${facts.label}` : `${facts.type === "proposta" ? "a sua" : "o seu"} ${facts.label}`;
  lines.push(`${hello} Segue ${what}${value ? `, no valor de ${value}` : ""}${facts.type === "proposta" && day(facts.valid_until) ? `, válida até ${day(facts.valid_until)}` : ""}.`);
  if (facts.type === "proposta") lines.push("Qualquer dúvida, é só responder por aqui.");
  return lines.join("\n");
}
/** Texto com o link de leitura no fim (modelo fora da janela e link copiado). */
export const withLink = (text: string, url: string) => `${text}\n\nVeja o documento: ${url}`;

// ---------------------------------------------------------------------------
// Estado de entrega e registro

export type DeliveryState = "preparando" | "na_fila" | "enviado" | "entregue" | "lido" | "falhou" | "link";
export interface OutboxState { status: string; error: string | null; delivery_status: string | null }

const RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3, played: 3 };
/** Junta o estado das linhas do outbox (texto e anexos) do envio. */
export function deliveryState(record: { status: string; mode: string; error: string | null }, rows: readonly OutboxState[]): { state: DeliveryState; reason: string | null } {
  if (record.status === "falhou") return { state: "falhou", reason: record.error };
  if (record.mode === "link_copiado") return { state: "link", reason: null };
  if (!rows.length) return { state: record.status === "preparado" ? "preparando" : "na_fila", reason: null };
  const failed = rows.find(row => row.status === "failed" || row.status === "cancelled" || row.delivery_status === "failed");
  if (failed) return { state: "falhou", reason: failed.error || (failed.delivery_status === "failed" ? "O WhatsApp não conseguiu entregar a mensagem ao cliente." : "O envio foi cancelado.") };
  const waiting = rows.find(row => row.status !== "sent");
  if (waiting) return { state: "na_fila", reason: waiting.status === "unknown" ? "O WhatsApp não confirmou o envio; confira na conversa antes de reenviar." : waiting.error };
  const rank = Math.min(...rows.map(row => RANK[row.delivery_status ?? "sent"] ?? 1));
  return { state: rank >= 3 ? "lido" : rank === 2 ? "entregue" : "enviado", reason: null };
}
export const DELIVERY_LABELS: Record<DeliveryState, string> = {
  preparando: "preparando", na_fila: "na fila de envio", enviado: "enviado", entregue: "entregue", lido: "lido", falhou: "falhou", link: "link copiado",
};

const TIME = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
/** "20/11 às 15:02" no horário de Brasília. */
export function when(at: number): string {
  const parts = Object.fromEntries(TIME.formatToParts(new Date(at)).map(part => [part.type, part.value]));
  return `${parts.day}/${parts.month} às ${parts.hour}:${parts.minute}`;
}
/** "Enviado pelo WhatsApp a (11) 9…-4321 por Fulano em 20/11 às 15:02". */
export function sendSummary(record: { phone: string; actor_name: string; created: number; mode: string; outside_record: number | boolean }): string {
  const verb = record.mode === "link_copiado" ? "Link copiado para" : "Enviado pelo WhatsApp a";
  return `${verb} ${maskPhone(record.phone)}${record.outside_record ? " (número fora do cadastro)" : ""} por ${record.actor_name} em ${when(record.created)}`;
}
