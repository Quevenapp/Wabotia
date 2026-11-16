// Vendas e Caixa no painel: nomes, tons e formatos do mesmo contrato de
// src/modules/vendas/model.ts, escrita com Idempotency-Key, foto do produto,
// impressão do comprovante e a devolução (usada também pelo Caixa).
import React, { useEffect, useState } from "react";
import { Printer } from "lucide-react";
import { useApp } from "../../app/AppContext";
import { useIntents, type Row } from "../../lib/api";
import type { PillTone } from "../../ui/controls";
import {
  Button,
  Dialog,
  Field,
  Notice,
  Segmented,
  SkeletonRows,
  toast,
} from "../../ui";
import { FormDialog } from "../../admin/shared";

// ---------------------------------------------------------------------------
// Valores e quantidades

export const money = (cents: number | null | undefined) =>
  typeof cents === "number"
    ? (cents / 100).toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL",
      })
    : "—";

/** "12,50", "1.234,50" ou "12.5" → centavos; vazio ou inválido → null. */
export function cents(value: string): number | null {
  const clean = String(value ?? "")
    .trim()
    .replace(/[R$\s]/g, "");
  if (!clean) return null;
  const normalized = clean.includes(",")
    ? clean.replace(/\./g, "").replace(",", ".")
    : clean;
  const number = Number(normalized);
  return Number.isFinite(number) && number >= 0
    ? Math.round(number * 100)
    : null;
}
/** 1250 → "12,50" (campo de valor). */
export const centsInput = (value: number | null | undefined) =>
  typeof value === "number" ? (value / 100).toFixed(2).replace(".", ",") : "";

/** "1,5" → 1.5; vazio ou inválido → null. */
export function decimal(value: string): number | null {
  const clean = String(value ?? "")
    .trim()
    .replace(/\s/g, "");
  if (!clean) return null;
  const number = Number(
    clean.includes(",") ? clean.replace(/\./g, "").replace(",", ".") : clean,
  );
  return Number.isFinite(number) ? number : null;
}
/** 1.5 → "1,5"; 2 → "2". */
export const qty = (value: number | null | undefined) =>
  typeof value === "number"
    ? value.toLocaleString("pt-BR", { maximumFractionDigits: 3 })
    : "—";
/** Número para campo editável: 1.5 → "1,5". */
export const numberInput = (value: number | null | undefined) =>
  typeof value === "number" ? String(value).replace(".", ",") : "";

/** Preço × quantidade, arredondado ao centavo (como o servidor). */
export const lineCents = (unitCents: number, quantity: number) =>
  Math.round((unitCents * Math.round(quantity * 1000)) / 1000);

export const day = (at: number | null | undefined) =>
  at
    ? new Date(at).toLocaleDateString("pt-BR", {
        timeZone: "America/Sao_Paulo",
      })
    : "—";
export const dateTime = (at: number | null | undefined) =>
  at
    ? new Date(at).toLocaleString("pt-BR", {
        timeZone: "America/Sao_Paulo",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
export const clock = (at: number | null | undefined) =>
  at
    ? new Date(at).toLocaleTimeString("pt-BR", {
        timeZone: "America/Sao_Paulo",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

export const phoneLabel = (digits: string | null | undefined) => {
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(digits || "");
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : digits || "";
};

// ---------------------------------------------------------------------------
// Rótulos

export const paymentLabels: Record<string, string> = {
  cash: "Dinheiro",
  card_credit: "Cartão de crédito",
  card_debit: "Cartão de débito",
  pix_manual: "Pix (chave da loja)",
  pix: "Pix (cobrança pelo WhatsApp)",
  link: "Link de pagamento",
  other: "Outra",
};
export const paymentOrder = [
  "cash",
  "card_credit",
  "card_debit",
  "pix_manual",
  "pix",
  "link",
  "other",
];
/** Formas confirmadas pelo Mercado Pago (módulo Cobrança). */
export const onlineMethods = ["pix", "link"];

export const saleLabels: Record<string, string> = {
  awaiting_payment: "Aguardando pagamento",
  completed: "Concluída",
  cancelled: "Cancelada",
  returned: "Devolvida",
};
export const saleTones: Record<string, PillTone> = {
  awaiting_payment: "warn",
  completed: "ok",
  cancelled: "muted",
  returned: "ticket",
};
export const quoteLabels: Record<string, string> = {
  draft: "Rascunho",
  sent: "Enviado",
  approved: "Aprovado",
  declined: "Recusado",
  expired: "Vencido",
  converted: "Virou venda",
  cancelled: "Cancelado",
};
export const quoteTones: Record<string, PillTone> = {
  draft: "muted",
  sent: "brand",
  approved: "ok",
  declined: "danger",
  expired: "warn",
  converted: "ticket",
  cancelled: "muted",
};
export const sourceLabels: Record<string, string> = {
  panel: "Painel",
  caixa: "Caixa",
  quote: "Orçamento",
  api: "Integração",
};
export const moveTones: Record<string, PillTone> = {
  entrada: "ok",
  saida: "warn",
  ajuste: "bot",
  venda: "brand",
  devolucao: "ticket",
  cancelamento: "muted",
};

// ---------------------------------------------------------------------------
// API

/** Escrita com Idempotency-Key em `{root}/{path}` (vendas/…, caixa/…). */
export function useModuleWrite() {
  const app = useApp();
  const write = useIntents(app.api);
  return (path: string, method: string, body: Row = {}) =>
    write(`${app.root}/${path}`, method, body);
}

/** Envia um arquivo pelo caminho de mídia do núcleo e devolve o id. */
export async function upload(app: ReturnType<typeof useApp>, file: File) {
  const data = new FormData();
  data.set("file", file);
  return (await app.api(app.root + "/media", "POST", data)).id as string;
}
export const mediaUrl = (app: ReturnType<typeof useApp>, id: string) =>
  `/api/${app.root}/media/${encodeURIComponent(id)}/content?inline=1`;

/** Foto do produto ou a inicial do nome sobre um fundo neutro. */
export function ProductThumb({
  product,
  className = "vendas-thumb",
}: {
  product: Row;
  className?: string;
}) {
  const app = useApp();
  const [broken, setBroken] = useState(false);
  if (product.photo_media_id && !broken)
    return (
      <img
        className={className}
        src={mediaUrl(app, product.photo_media_id)}
        alt=""
        loading="lazy"
        onError={() => setBroken(true)}
      />
    );
  return (
    <span className={className + " initial"} aria-hidden>
      {Array.from(String(product.name || "?").trim())[0]?.toUpperCase() || "?"}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Impressão: só o comprovante sai no papel (CSS de impressão em vendas.css).

export function printText(text: string) {
  const root = document.createElement("div");
  root.className = "vendas-print-root";
  const pre = document.createElement("pre");
  pre.textContent = text;
  root.appendChild(pre);
  document.body.appendChild(root);
  document.body.classList.add("vendas-printing");
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    document.body.classList.remove("vendas-printing");
    root.remove();
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  try {
    window.print();
  } finally {
    // Navegadores que não avisam afterprint: limpa depois de um tempo.
    setTimeout(cleanup, 60_000);
  }
}

/**
 * Comprovante, orçamento ou relatório em colunas fixas: lê `url` com
 * `columns`, mostra o texto e imprime só ele.
 */
export function ReceiptDialog({
  title,
  url,
  onClose,
  columns: initial = "32",
  footer,
}: {
  title: string;
  /** Caminho sem o parâmetro columns (ex.: `${root}/vendas/sales/{id}/receipt`). */
  url: string;
  onClose: () => void;
  columns?: "32" | "48";
  footer?: React.ReactNode;
}) {
  const app = useApp();
  const [columns, setColumns] = useState<"32" | "48">(initial);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setText(null);
    setError("");
    app
      .api(`${url}${url.includes("?") ? "&" : "?"}columns=${columns}`)
      .then((result) => alive && setText(String(result.text || "")))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [url, columns, attempt]);
  return (
    <Dialog
      title={title}
      onClose={onClose}
      size="md"
      footer={
        <>
          {footer}
          <Button secondary onClick={onClose}>
            Fechar
          </Button>
          <Button
            icon={<Printer size={16} />}
            disabled={!text}
            onClick={() => text && printText(text)}
            data-autofocus
          >
            Imprimir
          </Button>
        </>
      }
    >
      <div className="toolbar">
        <Segmented
          label="Largura do papel"
          value={columns}
          onChange={setColumns}
          options={[
            { value: "32", label: "58 mm (32 colunas)" },
            { value: "48", label: "80 mm (48 colunas)" },
          ]}
        />
      </div>
      {error ? (
        <Notice tone="error" onRetry={() => setAttempt((n) => n + 1)}>
          {error}
        </Notice>
      ) : text === null ? (
        <SkeletonRows rows={5} avatar={false} />
      ) : (
        <pre className="vendas-receipt">{text}</pre>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Devolução (venda no painel ou no Caixa)

/**
 * Escolhe itens e quantidades a devolver e a forma de devolução.
 * `submit` recebe `{items, method, reason}` e grava na rota de quem chama.
 */
export function ReturnDialog({
  sale,
  methods,
  defaultMethod,
  title,
  subtitle,
  onClose,
  submit,
}: {
  sale: Row;
  methods: string[];
  defaultMethod?: string;
  title?: string;
  subtitle?: React.ReactNode;
  onClose: () => void;
  submit: (body: Row) => Promise<any>;
}) {
  const lines: Row[] = (sale.lines || []).filter(
    (line: Row) => line.quantity - (line.returned_quantity || 0) > 0,
  );
  const [amounts, setAmounts] = useState<Record<number, string>>({});
  const payments: Row[] = sale.payments || [];
  const [method, setMethod] = useState(
    defaultMethod ||
      (payments.length === 1 ? payments[0].method : methods[0] || "cash"),
  );
  const [reason, setReason] = useState("");
  const left = (line: Row) =>
    Math.round((line.quantity - (line.returned_quantity || 0)) * 1000) / 1000;
  const chosen = lines
    .map((line) => ({ line, quantity: decimal(amounts[line.index] || "") }))
    .filter((item) => item.quantity && item.quantity > 0);
  const estimate = chosen.reduce(
    (sum, { line, quantity }) =>
      sum +
      (Math.abs(quantity! - left(line)) < 1e-9
        ? line.net_cents - (line.returned_cents || 0)
        : Math.round((line.net_cents * quantity!) / line.quantity)),
    0,
  );
  const methodOptions = [...new Set([...methods, method])].map((id) => ({
    id,
    name: paymentLabels[id] || id,
  }));
  return (
    <FormDialog
      title={title || `Devolução da venda nº ${sale.number}`}
      subtitle={
        subtitle ||
        "O estoque volta e o valor devolvido fica registrado, proporcional ao desconto da venda."
      }
      submitLabel={chosen.length ? `Devolver ${money(estimate)}` : "Devolver"}
      size="lg"
      disabled={!chosen.length}
      onClose={onClose}
      onSubmit={async () => {
        for (const { line, quantity } of chosen)
          if (quantity! > left(line) + 1e-9)
            throw new Error(
              `"${line.name}": só restam ${qty(left(line))} ${line.unit} para devolver.`,
            );
        const result = await submit({
          items: chosen.map(({ line, quantity }) => ({
            index: line.index,
            quantity,
          })),
          method,
          reason,
        });
        toast(
          `Devolução registrada: ${money(result?.return?.amount_cents ?? estimate)} em ${paymentLabels[method] || method}.`,
        );
      }}
    >
      {!lines.length ? (
        <Notice tone="warn">Não há itens para devolver nesta venda.</Notice>
      ) : (
        <div className="vendas-return-lines">
          {lines.map((line) => (
            <div className="vendas-return-line" key={line.index}>
              <div className="info">
                <strong>{line.name}</strong>
                <small>
                  Vendido {qty(line.quantity)} {line.unit}
                  {line.returned_quantity
                    ? ` · já devolvido ${qty(line.returned_quantity)}`
                    : ""}{" "}
                  · {money(line.net_cents)}
                </small>
              </div>
              <Field
                label={`Devolver (até ${qty(left(line))})`}
                value={amounts[line.index] || ""}
                placeholder="0"
                onChange={(value) =>
                  setAmounts({ ...amounts, [line.index]: value })
                }
              />
              <Button
                secondary
                size="sm"
                onClick={() =>
                  setAmounts({
                    ...amounts,
                    [line.index]: numberInput(left(line)),
                  })
                }
              >
                Tudo
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="form-field-grid">
        <Field
          label="Devolver o valor em"
          value={method}
          onChange={setMethod}
          options={methodOptions}
          emptyOption={null}
        />
        <Field
          label="Motivo (opcional)"
          value={reason}
          onChange={setReason}
          maxLength={300}
          placeholder="Ex.: produto com defeito"
        />
      </div>
    </FormDialog>
  );
}

// ---------------------------------------------------------------------------
// Conversa do WhatsApp (orçamento)

/** Enter num campo de busca dentro de um formulário não envia o formulário. */
export const stopEnter = (event: React.KeyboardEvent) => {
  if (event.key === "Enter" && (event.target as HTMLElement).tagName === "INPUT")
    event.preventDefault();
};

export function ConversationPicker({
  value,
  onChange,
}: {
  /** Conversa escolhida: {id, contact_name?, phone?} ou só {id}. */
  value: Row | null;
  onChange: (next: Row | null) => void;
}) {
  const app = useApp();
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Row[]>([]);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) return setFound([]);
    let alive = true;
    const timer = setTimeout(() => {
      app
        .api(`${app.root}/conversations?limit=6&q=${encodeURIComponent(q)}`)
        .then(
          (result) =>
            alive &&
            setFound(
              (result.data || []).filter((c: Row) => c.chat_type !== "group"),
            ),
        )
        .catch(() => alive && setFound([]));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query]);
  const label = (c: Row) =>
    [c.contact_name || c.title, phoneLabel(c.phone)]
      .filter(Boolean)
      .join(" · ") || "Conversa ligada";
  if (value)
    return (
      <div className="vendas-picked">
        <span>
          Conversa do WhatsApp: <strong>{label(value)}</strong>. O orçamento
          e as respostas Aprovar/Recusar vão por ela.
        </span>
        <button
          type="button"
          className="text-link"
          onClick={() => onChange(null)}
        >
          Desligar
        </button>
      </div>
    );
  return (
    <div onKeyDown={stopEnter}>
      <Field
        label="Conversa do WhatsApp (opcional)"
        value={query}
        onChange={setQuery}
        placeholder="Nome ou telefone do cliente"
        help="Ligado a uma conversa, o orçamento é enviado ao cliente com os botões Aprovar e Recusar."
      />
      {found.length > 0 && (
        <div className="vendas-picker">
          {found.map((c) => (
            <button
              key={c.id}
              type="button"
              className="chip"
              onClick={() => {
                onChange(c);
                setQuery("");
              }}
            >
              {label(c)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
