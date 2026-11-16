// Caixa (módulo "caixa", docs/CAIXA.md): frente de caixa para o tablet do
// balcão. Sem sessão aberta, escolhe o caixa e abre com o troco inicial; com
// a sessão aberta, vende por toque na grade de produtos (categorias com cor,
// fotos) ou pelo leitor de código de barras, cobra em uma ou mais formas com
// troco, imprime o comprovante, faz sangria, suprimento, devolução e o
// fechamento com o dinheiro contado. Escritas com Idempotency-Key.
import React, { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Banknote,
  Delete,
  Keyboard,
  Lock,
  LogOut,
  Minus,
  Pencil,
  Plus,
  Printer,
  ScanBarcode,
  ShoppingCart,
  Store,
  Trash2,
  Undo2,
} from "lucide-react";
import { useApp } from "../../app/AppContext";
import { useMedia } from "../../app/hooks";
import type { Row } from "../../lib/api";
import {
  Button,
  Card,
  Dialog,
  Empty,
  Field,
  IconButton,
  Notice,
  Pill,
  Segmented,
  SkeletonBlock,
  SkeletonRows,
  Switch,
  toast,
} from "../../ui";
import { FormDialog, useResource } from "../../admin/shared";
import {
  cents,
  centsInput,
  clock,
  decimal,
  lineCents,
  money,
  onlineMethods,
  paymentLabels,
  ProductThumb,
  qty,
  ReceiptDialog,
  ReturnDialog,
  useModuleWrite,
} from "../vendas/shared";
import "../vendas/vendas.css";
import "./caixa.css";

type CartLine = { product: Row; quantity: number };

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const storageKey = (profile: string) => `wabotia:caixa:${profile}`;
function remembered(profile: string) {
  try {
    return localStorage.getItem(storageKey(profile));
  } catch {
    return null;
  }
}
function remember(profile: string, id: string | null) {
  try {
    if (id) localStorage.setItem(storageKey(profile), id);
    else localStorage.removeItem(storageKey(profile));
  } catch {
    /* lembrete opcional */
  }
}

// ---------------------------------------------------------------------------
// Escolher e abrir o caixa

function RegisterDialog({ initial, onClose, onSaved }: { initial: Row; onClose: () => void; onSaved: () => void }) {
  const write = useModuleWrite();
  const [name, setName] = useState(initial.name || "");
  const [active, setActive] = useState(initial.active !== false);
  return (
    <FormDialog
      title={initial.id ? `Editar ${initial.name}` : "Novo caixa"}
      size="sm"
      onClose={onClose}
      onSubmit={async () => {
        if (initial.id) await write(`caixa/registers/${initial.id}`, "PUT", { name, active });
        else await write("caixa/registers", "POST", { name });
        toast("Caixa salvo.");
        onSaved();
      }}
    >
      <Field label="Nome" value={name} onChange={setName} maxLength={40} required placeholder="Ex.: Caixa 1, Balcão" />
      {initial.id && (
        <label className="vendas-toggle">
          <Switch label="Caixa ativo" checked={active} onChange={setActive} />
          {active ? "Ativo" : "Desativado: não pode ser aberto"}
        </label>
      )}
    </FormDialog>
  );
}

function OpenDialog({ register, onClose, onOpened }: { register: Row; onClose: () => void; onOpened: () => void }) {
  const write = useModuleWrite();
  const [opening, setOpening] = useState("");
  const [note, setNote] = useState("");
  return (
    <FormDialog
      title={`Abrir ${register.name}`}
      subtitle="Conte o dinheiro da gaveta antes de começar."
      submitLabel="Abrir caixa"
      size="sm"
      onClose={onClose}
      onSubmit={async () => {
        const value = opening.trim() ? cents(opening) : 0;
        if (value === null) throw new Error("Troco inicial inválido. Use, por exemplo, 100,00.");
        try {
          await write(`caixa/registers/${register.id}/open`, "POST", { opening_cents: value, note });
          toast(`${register.name} aberto.`);
        } catch (error: any) {
          // Aberto por outra pessoa enquanto isso: usa a sessão aberta.
          if (error?.code !== "session_open") throw error;
          toast(error.message, { tone: "info" });
        }
        onOpened();
      }}
    >
      <div className="caixa-money-field">
        <Field label="Troco inicial (R$)" value={opening} onChange={setOpening} placeholder="0,00" />
      </div>
      <Field label="Observação (opcional)" value={note} onChange={setNote} maxLength={300} />
    </FormDialog>
  );
}

function RegisterPicker({
  registers,
  selected,
  onUse,
  reload,
  error,
}: {
  registers: Row[];
  selected: string | null;
  onUse: (register: Row) => void;
  reload: () => void;
  error?: string;
}) {
  const app = useApp();
  const [opening, setOpening] = useState<Row | null>(null);
  const [editing, setEditing] = useState<Row | null>(null);
  const active = registers.filter((r) => r.active);
  const inactive = registers.filter((r) => !r.active);
  return (
    <div className="caixa-page">
      {error && (
        <Notice tone="error" onRetry={reload}>
          {error}
        </Notice>
      )}
      <div className="toolbar">
        <p className="muted">Escolha o caixa deste aparelho. Ele fica lembrado aqui.</p>
        {app.isAdmin && (
          <Button secondary icon={<Plus size={16} />} onClick={() => setEditing({})}>
            Novo caixa
          </Button>
        )}
      </div>
      {!active.length ? (
        <Card>
          <Empty
            icon={<Store size={28} />}
            title="Nenhum caixa ativo"
            description={app.isAdmin ? "Crie o caixa do balcão (Caixa 1, Balcão…) para começar a vender." : "Peça a um administrador para criar um caixa."}
            action={
              app.isAdmin ? (
                <Button icon={<Plus size={16} />} onClick={() => setEditing({})}>
                  Criar caixa
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <div className="caixa-registers">
          {active.map((register) => {
            const session = register.session;
            return (
              <section className={"card caixa-register" + (selected === register.id ? " selected" : "")} key={register.id}>
                <div className="caixa-register-head">
                  <h2>{register.name}</h2>
                  {session ? <Pill tone="ok">Aberto · sessão nº {session.number}</Pill> : <Pill tone="muted">Fechado</Pill>}
                  {app.isAdmin && (
                    <IconButton label={`Editar ${register.name}`} onClick={() => setEditing(register)}>
                      <Pencil size={18} />
                    </IconButton>
                  )}
                </div>
                <p className="muted">
                  {session
                    ? `Aberto por ${app.names[session.opened_by] || session.opened_by} às ${clock(session.opened_at)} com ${money(session.opening_cents)} de troco.`
                    : "Abra com o troco inicial da gaveta."}
                </p>
                {session ? (
                  <Button size="lg" full icon={<ShoppingCart size={18} />} onClick={() => onUse(register)}>
                    Usar este caixa
                  </Button>
                ) : (
                  <Button size="lg" full icon={<Banknote size={18} />} onClick={() => setOpening(register)}>
                    Abrir caixa
                  </Button>
                )}
              </section>
            );
          })}
        </div>
      )}
      {app.isAdmin && inactive.length > 0 && (
        <Card title="Caixas desativados">
          <div className="vendas-category-list">
            {inactive.map((register) => (
              <div className="vendas-category-row" key={register.id}>
                <strong>{register.name}</strong>
                <span className="spacer" />
                <Button secondary size="sm" onClick={() => setEditing(register)}>
                  Editar
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}
      {opening && (
        <OpenDialog
          register={opening}
          onClose={() => setOpening(null)}
          onOpened={() => {
            const register = opening;
            setOpening(null);
            onUse(register);
            reload();
          }}
        />
      )}
      {editing && (
        <RegisterDialog
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Teclado numérico (produto fracionado)

function QuantityPad({
  product,
  initial,
  onClose,
  onConfirm,
}: {
  product: Row;
  initial?: number;
  onClose: () => void;
  onConfirm: (quantity: number) => void;
}) {
  const [value, setValue] = useState(initial ? String(initial).replace(".", ",") : "");
  const press = (key: string) =>
    setValue((current) => {
      if (key === "back") return current.slice(0, -1);
      if (key === ",") return current.includes(",") ? current : (current || "0") + ",";
      const [, decimals = ""] = current.split(",");
      if (current.includes(",") && decimals.length >= 3) return current;
      if (current.replace(",", "").length >= 9) return current;
      return current === "0" ? key : current + key;
    });
  const quantity = decimal(value);
  const valid = quantity !== null && quantity > 0;
  const confirm = () => valid && onConfirm(round3(quantity!));
  return (
    <Dialog
      title={product.name}
      subtitle={`${money(product.price_cents)} por ${product.unit}`}
      onClose={onClose}
      size="sm"
      className="caixa-pad-dialog"
      footer={
        <>
          <Button secondary size="lg" onClick={onClose}>
            Cancelar
          </Button>
          <Button size="lg" disabled={!valid} onClick={confirm}>
            {initial ? "Alterar" : "Adicionar"}
          </Button>
        </>
      }
    >
      <div
        className="caixa-pad"
        tabIndex={0}
        data-autofocus
        aria-label={`Quantidade em ${product.unit}`}
        onKeyDown={(event) => {
          if (/^[0-9]$/.test(event.key)) press(event.key);
          else if (event.key === "," || event.key === ".") press(",");
          else if (event.key === "Backspace") press("back");
          else if (event.key === "Enter") confirm();
          else return;
          event.preventDefault();
        }}
      >
        <output className="caixa-pad-display" aria-live="polite">
          {value || "0"} <small>{product.unit}</small>
        </output>
        <p className="caixa-pad-total">{valid ? money(lineCents(product.price_cents, round3(quantity!))) : " "}</p>
        <div className="caixa-pad-keys">
          {["7", "8", "9", "4", "5", "6", "1", "2", "3", ",", "0"].map((key) => (
            <button type="button" key={key} onClick={() => press(key)}>
              {key}
            </button>
          ))}
          <button type="button" aria-label="Apagar" onClick={() => press("back")}>
            <Delete size={22} />
          </button>
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Carrinho

function Cart({
  lines,
  setQuantity,
  editQuantity,
  discountMode,
  setDiscountMode,
  discount,
  setDiscount,
  totals,
  onCharge,
  onClear,
}: {
  lines: CartLine[];
  setQuantity: (id: string, quantity: number) => void;
  editQuantity: (line: CartLine) => void;
  discountMode: "value" | "percent";
  setDiscountMode: (mode: "value" | "percent") => void;
  discount: string;
  setDiscount: (value: string) => void;
  totals: { subtotal: number; off: number; total: number; error: string };
  onCharge: () => void;
  onClear: () => void;
}) {
  return (
    <div className="caixa-cart">
      <div className="caixa-cart-head">
        <h2>
          Carrinho <small>{lines.length ? `${lines.length} ${lines.length === 1 ? "item" : "itens"}` : ""}</small>
        </h2>
        {lines.length > 0 && (
          <Button variant="ghost" size="sm" onClick={onClear}>
            Limpar
          </Button>
        )}
      </div>
      <div className="caixa-cart-lines">
        {!lines.length && <p className="muted caixa-cart-empty">Toque num produto ou passe o código de barras.</p>}
        {lines.map((line) => {
          const p = line.product;
          return (
            <div className="caixa-cart-line" key={p.id}>
              <div className="info">
                <strong>{p.name}</strong>
                <small>
                  {money(p.price_cents)}/{p.unit}
                </small>
              </div>
              <div className="caixa-stepper">
                <IconButton
                  label={`Diminuir ${p.name}`}
                  onClick={() => setQuantity(p.id, p.fractional ? 0 : line.quantity - 1)}
                >
                  {line.quantity <= 1 || p.fractional ? <Trash2 size={18} /> : <Minus size={18} />}
                </IconButton>
                {p.fractional ? (
                  <button type="button" className="caixa-qty editable" onClick={() => editQuantity(line)} aria-label={`Quantidade de ${p.name}: ${qty(line.quantity)} ${p.unit}. Alterar`}>
                    {qty(line.quantity)} {p.unit}
                  </button>
                ) : (
                  <span className="caixa-qty" aria-label={`Quantidade de ${p.name}`}>
                    {qty(line.quantity)}
                  </span>
                )}
                {!p.fractional && (
                  <IconButton label={`Aumentar ${p.name}`} onClick={() => setQuantity(p.id, line.quantity + 1)}>
                    <Plus size={18} />
                  </IconButton>
                )}
              </div>
              <span className="caixa-line-total">{money(lineCents(p.price_cents, line.quantity))}</span>
            </div>
          );
        })}
      </div>
      <div className="caixa-cart-foot">
        <div className="caixa-discount">
          <span>Desconto</span>
          <Segmented
            label="Tipo de desconto"
            value={discountMode}
            onChange={setDiscountMode}
            options={[
              { value: "value", label: "R$" },
              { value: "percent", label: "%" },
            ]}
          />
          <input
            aria-label={discountMode === "percent" ? "Desconto em percentual" : "Desconto em reais"}
            inputMode="decimal"
            value={discount}
            onChange={(event) => setDiscount(event.target.value)}
            placeholder={discountMode === "percent" ? "0" : "0,00"}
          />
        </div>
        {totals.error && <p className="caixa-error">{totals.error}</p>}
        <dl className="caixa-totals">
          <dt>Subtotal</dt>
          <dd>{money(totals.subtotal)}</dd>
          {totals.off > 0 && (
            <>
              <dt>Desconto</dt>
              <dd>− {money(totals.off)}</dd>
            </>
          )}
        </dl>
        <div className="caixa-total">
          <span>Total</span>
          <strong>{money(totals.total)}</strong>
        </div>
        <Button size="lg" full disabled={!lines.length || !!totals.error} onClick={onCharge} icon={<Banknote size={20} />}>
          Cobrar {lines.length ? money(totals.total) : ""}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cobrar

type PaymentDraft = { key: string; method: string; amount: string };
const newKey = () => Math.random().toString(36).slice(2);
const bills = [1000, 2000, 5000, 10000];

function ChargeDialog({
  session,
  total,
  body,
  methods,
  onClose,
  onDone,
}: {
  session: Row;
  total: number;
  body: Row;
  methods: Row[];
  onClose: () => void;
  onDone: (sale: Row) => void;
}) {
  const app = useApp();
  const write = useModuleWrite();
  const [payments, setPayments] = useState<PaymentDraft[]>(() =>
    methods.length === 1 ? [{ key: newKey(), method: methods[0].id, amount: centsInput(total) }] : [],
  );
  const [customerDoc, setCustomerDoc] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const amounts = payments.map((p) => cents(p.amount) ?? 0);
  const paid = amounts.reduce((s, n) => s + n, 0);
  const cash = payments.reduce((s, p, i) => s + (p.method === "cash" ? amounts[i] : 0), 0);
  const missing = Math.max(0, total - paid);
  const change = Math.max(0, paid - total);
  const problem =
    total > 0 && !payments.length
      ? "Escolha a forma de pagamento."
      : payments.some((p, i) => !amounts[i])
        ? "Informe o valor de cada forma."
        : missing
          ? `Faltam ${money(missing)}.`
          : change > cash
            ? "Troco só em dinheiro: os valores das outras formas passam do total."
            : "";
  const add = (method: string) => {
    const existing = payments.find((p) => p.method === method);
    if (existing) {
      // Tocar de novo na mesma forma completa o que falta nela.
      setPayments(payments.map((p) => (p === existing ? { ...p, amount: centsInput((cents(p.amount) ?? 0) + missing) } : p)));
      return;
    }
    if (payments.length >= 6) return;
    setPayments([...payments, { key: newKey(), method, amount: missing ? centsInput(missing) : "" }]);
  };
  const setAmount = (key: string, amount: string) => setPayments(payments.map((p) => (p.key === key ? { ...p, amount } : p)));
  const cashRow = payments.find((p) => p.method === "cash");
  const otherPaid = paid - (cashRow ? cents(cashRow.amount) ?? 0 : 0);
  const confirm = async () => {
    if (busy || problem || app.demoBlocked()) return;
    setBusy(true);
    setError("");
    try {
      const sale = await write(`caixa/sessions/${session.id}/sales`, "POST", {
        ...body,
        payments: payments.map((p, i) => ({ method: p.method, amount_cents: amounts[i] })),
        ...(customerDoc.trim() ? { customer_document: customerDoc.trim() } : {}),
      });
      onDone(sale);
    } catch (e: any) {
      setError(e?.message || "Não foi possível concluir a venda.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Cobrar"
      onClose={() => !busy && onClose()}
      size="lg"
      className="caixa-charge"
      footer={
        <>
          <Button secondary size="lg" disabled={busy} onClick={onClose}>
            Voltar
          </Button>
          <Button size="lg" busy={busy} disabled={!!problem} onClick={() => void confirm()} icon={<ShoppingCart size={18} />}>
            Concluir venda
          </Button>
        </>
      }
    >
      <div className="caixa-charge-summary">
        <div>
          <span>Total</span>
          <strong>{money(total)}</strong>
        </div>
        <div>
          <span>Recebido</span>
          <strong>{money(paid)}</strong>
        </div>
        <div className={change ? "change" : missing ? "missing" : ""}>
          <span>{change ? "Troco" : "Falta"}</span>
          <strong>{money(change || missing)}</strong>
        </div>
      </div>
      <div className="caixa-methods" role="group" aria-label="Formas de pagamento">
        {methods.map((m) => (
          <button type="button" key={m.id} className={payments.some((p) => p.method === m.id) ? "active" : ""} onClick={() => add(m.id)}>
            {paymentLabels[m.id] || m.label}
          </button>
        ))}
      </div>
      {payments.map((p) => (
        <div className="caixa-payment" key={p.key}>
          <label className="field">
            <span>{p.method === "cash" ? "Dinheiro recebido (R$)" : `${paymentLabels[p.method] || p.method} (R$)`}</span>
            <input inputMode="decimal" value={p.amount} onChange={(event) => setAmount(p.key, event.target.value)} placeholder="0,00" />
          </label>
          <IconButton label={`Remover ${paymentLabels[p.method] || p.method}`} onClick={() => setPayments(payments.filter((x) => x.key !== p.key))}>
            <Trash2 size={18} />
          </IconButton>
          {p.method === "cash" && (
            <div className="caixa-bills" role="group" aria-label="Notas recebidas">
              {bills.map((bill) => (
                <button type="button" key={bill} onClick={() => setAmount(p.key, centsInput(bill))}>
                  {money(bill).replace(",00", "")}
                </button>
              ))}
              <button type="button" onClick={() => setAmount(p.key, centsInput(Math.max(0, total - otherPaid)))}>
                Valor exato
              </button>
            </div>
          )}
        </div>
      ))}
      <Field label="CPF ou CNPJ na nota (opcional)" value={customerDoc} onChange={setCustomerDoc} maxLength={20} placeholder="Só se o cliente pedir" />
      {problem && payments.length > 0 && <p className="caixa-error">{problem}</p>}
      {error && <Notice tone="error">{error}</Notice>}
    </Dialog>
  );
}

function DoneDialog({ sale, onClose }: { sale: Row; onClose: () => void }) {
  const app = useApp();
  const [printing, setPrinting] = useState(false);
  return (
    <>
      <Dialog
        title={`Venda nº ${sale.number} concluída`}
        onClose={onClose}
        size="md"
        className="caixa-done"
        footer={
          <>
            <Button secondary size="lg" icon={<Printer size={18} />} onClick={() => setPrinting(true)}>
              Imprimir comprovante
            </Button>
            <Button size="lg" onClick={onClose} data-autofocus>
              Nova venda
            </Button>
          </>
        }
      >
        <div className={"caixa-change" + (sale.change_cents ? "" : " none")}>
          <span>{sale.change_cents ? "Troco" : "Sem troco"}</span>
          <strong>{money(sale.change_cents || 0)}</strong>
        </div>
        <dl className="vendas-facts">
          <dt>Total</dt>
          <dd>{money(sale.total_cents)}</dd>
          <dt>Pagamento</dt>
          <dd>{(sale.payments || []).map((p: Row) => `${p.method_label} ${money(p.amount_cents)}`).join(" + ") || "—"}</dd>
        </dl>
      </Dialog>
      {printing && (
        <ReceiptDialog title={`Comprovante da venda nº ${sale.number}`} url={`${app.root}/vendas/sales/${sale.id}/receipt`} onClose={() => setPrinting(false)} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Sangria, suprimento, devolução, fechamento

function MoveDialog({ session, kind, onClose }: { session: Row; kind: "withdrawal" | "supply"; onClose: () => void }) {
  const write = useModuleWrite();
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const withdrawal = kind === "withdrawal";
  return (
    <FormDialog
      title={withdrawal ? "Sangria" : "Suprimento"}
      subtitle={withdrawal ? "Dinheiro retirado da gaveta (ex.: levado ao cofre)." : "Dinheiro colocado na gaveta (ex.: mais troco)."}
      submitLabel={withdrawal ? "Registrar sangria" : "Registrar suprimento"}
      size="sm"
      onClose={onClose}
      onSubmit={async () => {
        const value = cents(amount);
        if (!value) throw new Error("Informe o valor (ex.: 50,00).");
        await write(`caixa/sessions/${session.id}/moves`, "POST", { kind, amount_cents: value, note });
        toast(`${withdrawal ? "Sangria" : "Suprimento"} de ${money(value)} registrado.`);
        onClose();
      }}
    >
      <div className="caixa-money-field">
        <Field label="Valor (R$)" value={amount} onChange={setAmount} placeholder="0,00" required />
      </div>
      <Field label="Observação (opcional)" value={note} onChange={setNote} maxLength={300} />
    </FormDialog>
  );
}

function ReturnFlow({ session, methods, onClose }: { session: Row; methods: string[]; onClose: () => void }) {
  const app = useApp();
  const write = useModuleWrite();
  const detail = useResource(`${app.root}/caixa/sessions/${session.id}`);
  const [number, setNumber] = useState("");
  const [finding, setFinding] = useState(false);
  const [findError, setFindError] = useState("");
  const [sale, setSale] = useState<Row | null>(null);
  const open = async (id: string) => {
    setFinding(true);
    setFindError("");
    try {
      setSale(await app.api(`${app.root}/vendas/sales/${id}`));
    } catch (e: any) {
      setFindError(e.message);
    } finally {
      setFinding(false);
    }
  };
  const find = async () => {
    const n = number.trim();
    if (!/^\d{1,9}$/.test(n)) return setFindError("Digite o número da venda.");
    setFinding(true);
    setFindError("");
    try {
      const result = await app.api(`${app.root}/vendas/sales?q=${n}&limit=20`);
      const found = (result.data || []).find((s: Row) => String(s.number) === n);
      if (!found) setFindError(`Venda nº ${n} não encontrada.`);
      else await open(found.id);
    } catch (e: any) {
      setFindError(e.message);
    } finally {
      setFinding(false);
    }
  };
  if (sale)
    return (
      <ReturnDialog
        sale={sale}
        methods={methods}
        defaultMethod="cash"
        subtitle="O estoque volta e o valor sai da forma escolhida; em dinheiro, sai da gaveta deste caixa."
        onClose={onClose}
        submit={async (body) => {
          const result = await write(`caixa/sessions/${session.id}/returns`, "POST", { sale_id: sale.id, ...body });
          onClose();
          return result;
        }}
      />
    );
  const sales: Row[] = (detail.data?.sales || []).filter((s: Row) => s.status === "completed").slice().reverse();
  return (
    <Dialog
      title="Devolução"
      subtitle="Escolha a venda desta sessão ou digite o número de outra venda."
      onClose={onClose}
      size="md"
      footer={
        <Button secondary onClick={onClose}>
          Cancelar
        </Button>
      }
    >
      <form
        className="caixa-find"
        onSubmit={(event) => {
          event.preventDefault();
          void find();
        }}
      >
        <Field label="Número da venda" value={number} onChange={setNumber} placeholder="Ex.: 128" />
        <Button type="submit" size="lg" busy={finding}>
          Buscar
        </Button>
      </form>
      {findError && <Notice tone="error">{findError}</Notice>}
      <h3 className="vendas-h3">Vendas desta sessão</h3>
      {!detail.data ? (
        detail.error ? (
          <Notice tone="error" onRetry={() => void detail.reload()}>
            {detail.error}
          </Notice>
        ) : (
          <SkeletonRows rows={3} avatar={false} />
        )
      ) : !sales.length ? (
        <p className="muted">Nenhuma venda concluída nesta sessão.</p>
      ) : (
        <div className="caixa-sale-list">
          {sales.map((s) => (
            <button type="button" key={s.id} disabled={finding} onClick={() => void open(s.id)}>
              <strong>Nº {s.number}</strong>
              <span>{clock(s.created)}</span>
              <span>{s.methods.map((m: string) => paymentLabels[m] || m).join(" + ")}</span>
              <strong>{money(s.total_cents)}</strong>
            </button>
          ))}
        </div>
      )}
    </Dialog>
  );
}

function CloseFlow({ session, onClose, onClosed }: { session: Row; onClose: () => void; onClosed: () => void }) {
  const app = useApp();
  const write = useModuleWrite();
  const detail = useResource(`${app.root}/caixa/sessions/${session.id}`);
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [closed, setClosed] = useState<Row | null>(null);
  if (closed)
    return (
      <ReceiptDialog
        title={`Fechamento do caixa · sessão nº ${closed.number}`}
        url={`${app.root}/caixa/sessions/${closed.id}/report`}
        onClose={onClosed}
      />
    );
  const data: Row | null = detail.data;
  const sum: Row | null = data?.summary || null;
  const expected = sum?.cash?.expected_cents ?? 0;
  const countedCents = cents(counted);
  const diff = countedCents === null ? null : countedCents - expected;
  return (
    <FormDialog
      title={`Fechar ${session.register_name || "o caixa"} · sessão nº ${session.number}`}
      subtitle="Conte o dinheiro da gaveta e informe o valor. O resumo fica congelado e vai para o relatório."
      submitLabel="Fechar caixa"
      size="lg"
      disabled={!sum || countedCents === null}
      onClose={onClose}
      onSubmit={async () => {
        if (countedCents === null) throw new Error("Informe o dinheiro contado (ex.: 350,00).");
        const result = await write(`caixa/sessions/${session.id}/close`, "POST", { counted_cents: countedCents, note });
        const d = result.difference_cents || 0;
        toast(d === 0 ? "Caixa fechado sem diferença." : `Caixa fechado com ${d > 0 ? "sobra" : "falta"} de ${money(Math.abs(d))}.`, {
          tone: d === 0 ? "ok" : "info",
        });
        setClosed(result);
      }}
    >
      {!sum ? (
        detail.error ? (
          <Notice tone="error" onRetry={() => void detail.reload()}>
            {detail.error}
          </Notice>
        ) : (
          <SkeletonRows rows={4} avatar={false} />
        )
      ) : (
        <>
          <div className="caixa-close-grid">
            <dl className="vendas-facts">
              <dt>Vendas</dt>
              <dd>
                {sum.sales.count} · {money(sum.sales.total_cents)}
              </dd>
              {sum.sales.discount_cents > 0 && (
                <>
                  <dt>Descontos</dt>
                  <dd>{money(sum.sales.discount_cents)}</dd>
                </>
              )}
              {sum.sales.cancelled_count > 0 && (
                <>
                  <dt>Canceladas</dt>
                  <dd>
                    {sum.sales.cancelled_count} · {money(sum.sales.cancelled_cents)}
                  </dd>
                </>
              )}
              {sum.by_method.map((m: Row) => (
                <React.Fragment key={m.method}>
                  <dt>{m.label}</dt>
                  <dd>
                    {money(m.amount_cents)} <small className="muted">({m.count})</small>
                  </dd>
                </React.Fragment>
              ))}
              {sum.returns.count > 0 && (
                <>
                  <dt>Devoluções</dt>
                  <dd>
                    {sum.returns.count} · − {money(sum.returns.total_cents)}
                  </dd>
                </>
              )}
            </dl>
            <dl className="vendas-facts">
              <dt>Troco inicial</dt>
              <dd>{money(sum.opening_cents)}</dd>
              <dt>Suprimentos</dt>
              <dd>{money(sum.supplies_cents)}</dd>
              <dt>Sangrias</dt>
              <dd>− {money(sum.withdrawals_cents)}</dd>
              <dt>Dinheiro de vendas</dt>
              <dd>{money(sum.cash.sales_cents)}</dd>
              {sum.cash.returns_cents > 0 && (
                <>
                  <dt>Devolvido em dinheiro</dt>
                  <dd>− {money(sum.cash.returns_cents)}</dd>
                </>
              )}
            </dl>
          </div>
          {sum.sales.awaiting_count > 0 && (
            <Notice tone="warn">{sum.sales.awaiting_count} venda(s) ainda aguardando pagamento online não entram no total.</Notice>
          )}
          <div className="caixa-expected">
            <span>Esperado na gaveta</span>
            <strong>{money(expected)}</strong>
          </div>
          <div className="caixa-money-field">
            <Field label="Dinheiro contado (R$)" value={counted} onChange={setCounted} placeholder="0,00" required />
          </div>
          {diff !== null && (
            <p className={"caixa-diff" + (diff === 0 ? " ok" : diff > 0 ? " over" : " short")}>
              {diff === 0 ? "Confere com o esperado." : `${diff > 0 ? "Sobra" : "Falta"} de ${money(Math.abs(diff))}.`}
            </p>
          )}
          <Field label="Observação (opcional)" value={note} onChange={setNote} maxLength={500} />
        </>
      )}
    </FormDialog>
  );
}

// ---------------------------------------------------------------------------
// Frente de caixa (sessão aberta)

function PointOfSale({
  register,
  session,
  methods,
  onLeave,
  onClosed,
}: {
  register: Row;
  session: Row;
  methods: Row[];
  onLeave: () => void;
  onClosed: () => void;
}) {
  const app = useApp();
  const wide = useMedia("(min-width: 900px) and (orientation: landscape), (min-width: 1200px)");
  const grid = useResource(`${app.root}/caixa/grid`);
  const scan = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState("");
  const [typing, setTyping] = useState(false);
  const [looking, setLooking] = useState(false);
  const [category, setCategory] = useState("all");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [discountMode, setDiscountMode] = useState<"value" | "percent">("value");
  const [discount, setDiscount] = useState("");
  const [pad, setPad] = useState<{ product: Row; initial?: number } | null>(null);
  const [dialog, setDialog] = useState<"charge" | "cart" | "withdrawal" | "supply" | "return" | "close" | null>(null);
  const [done, setDone] = useState<Row | null>(null);
  const caixaMethods = methods.filter((m) => !onlineMethods.includes(m.id));

  const focusScan = () => setTimeout(() => scan.current?.focus({ preventScroll: true }), 0);
  // Leitores USB/Bluetooth digitam como teclado e apertam Enter: o campo do
  // código fica focado quando nada mais está, e uma tecla digitada fora de
  // um campo vai para ele (sem abrir o teclado da tela: inputMode none).
  useEffect(() => {
    const modalOpen = () => !!document.querySelector(".modal-backdrop");
    const editable = (el: Element | null) =>
      !!el && el instanceof HTMLElement && (el.isContentEditable || el.matches("input, textarea, select"));
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || modalOpen() || editable(document.activeElement)) return;
      if (event.key.length === 1 && /[0-9A-Za-z.\-_]/.test(event.key)) scan.current?.focus({ preventScroll: true });
    };
    const onFocusOut = () =>
      setTimeout(() => {
        const el = document.activeElement;
        if (!modalOpen() && (!el || el === document.body)) scan.current?.focus({ preventScroll: true });
      }, 0);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusout", onFocusOut);
    scan.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);

  const setQuantity = (id: string, quantity: number) => {
    setCart((current) =>
      quantity <= 0 ? current.filter((l) => l.product.id !== id) : current.map((l) => (l.product.id === id ? { ...l, quantity: round3(quantity) } : l)),
    );
    focusScan();
  };
  const add = (product: Row, quantity?: number) => {
    if (product.out_of_stock) {
      toast(`${product.name} está sem saldo no estoque.`, { tone: "error" });
      return focusScan();
    }
    if (product.fractional && quantity === undefined) return setPad({ product });
    const amount = quantity ?? 1;
    setCart((current) => {
      const existing = current.find((l) => l.product.id === product.id);
      // Mesmo produto de novo (outro toque, outra leitura, outro saco pesado): soma.
      if (existing)
        return current.map((l) => (l === existing ? { ...l, quantity: round3(l.quantity + amount) } : l));
      return [...current, { product, quantity: round3(amount) }];
    });
    focusScan();
  };
  const lookup = async () => {
    const value = code.trim();
    if (!value || looking) return;
    setLooking(true);
    try {
      const product = await app.api(`${app.root}/caixa/lookup?code=${encodeURIComponent(value)}`);
      add(product);
      setCode("");
    } catch (e: any) {
      toast(e?.status === 404 ? `Código ${value} não encontrado no catálogo.` : e.message, { tone: "error" });
      setCode("");
    } finally {
      setLooking(false);
      setTyping(false);
      focusScan();
    }
  };

  const subtotal = cart.reduce((s, l) => s + lineCents(l.product.price_cents, l.quantity), 0);
  let off = 0,
    discountError = "";
  if (discount.trim()) {
    if (discountMode === "percent") {
      const p = decimal(discount);
      if (p === null || p < 0 || p > 100) discountError = "Desconto: de 0 a 100%.";
      else off = Math.round((subtotal * p) / 100);
    } else {
      const value = cents(discount);
      if (value === null) discountError = "Desconto inválido (ex.: 5,00).";
      else off = value;
    }
    if (!discountError && off > subtotal) discountError = "O desconto é maior que o total dos itens.";
  }
  const totals = { subtotal, off: discountError ? 0 : off, total: Math.max(0, subtotal - (discountError ? 0 : off)), error: discountError };
  const saleBody: Row = {
    lines: cart.map((l) => ({ product_id: l.product.id, quantity: l.quantity })),
    ...(off && !discountError ? (discountMode === "percent" ? { discount_percent: decimal(discount) } : { discount_cents: off }) : {}),
  };

  const view: Row | null = grid.data;
  const categories: Row[] = view?.categories || [];
  const products: Row[] = view?.products || [];
  const hasOthers = products.some((p) => !p.category_id || !categories.some((c) => c.id === p.category_id));
  const shown = products.filter((p) =>
    category === "all"
      ? true
      : category === "none"
        ? !p.category_id || !categories.some((c) => c.id === p.category_id)
        : p.category_id === category,
  );
  const inCart = (id: string) => cart.find((l) => l.product.id === id)?.quantity;
  const cartProps = {
    lines: cart,
    setQuantity,
    editQuantity: (line: CartLine) => setPad({ product: line.product, initial: line.quantity }),
    discountMode,
    setDiscountMode,
    discount,
    setDiscount,
    totals,
    onCharge: () => setDialog("charge"),
    onClear: () => {
      setCart([]);
      setDiscount("");
      focusScan();
    },
  };
  const action = (label: string, icon: React.ReactNode, run: () => void, extra = "") => (
    <Button secondary className={"caixa-action " + extra} icon={icon} aria-label={label} title={label} onClick={run}>
      <span className="caixa-label">{label}</span>
    </Button>
  );
  return (
    <div className="caixa-page caixa-pos-page">
      <header className="caixa-bar">
        <div className="caixa-bar-title">
          <strong>
            {register.name} · sessão nº {session.number}
          </strong>
          <small>
            Aberto por {app.names[session.opened_by] || session.opened_by} às {clock(session.opened_at)}
          </small>
        </div>
        <div className="caixa-bar-actions">
          {action("Sangria", <ArrowUpFromLine size={18} />, () => setDialog("withdrawal"))}
          {action("Suprimento", <ArrowDownToLine size={18} />, () => setDialog("supply"))}
          {action("Devolução", <Undo2 size={18} />, () => setDialog("return"))}
          {action("Fechar caixa", <Lock size={18} />, () => setDialog("close"), "close")}
          {action("Trocar de caixa", <LogOut size={18} />, onLeave, "leave")}
        </div>
      </header>
      <div className={"caixa-pos" + (wide ? " wide" : "")}>
        <section className="caixa-main" aria-label="Produtos">
          <form
            className="caixa-scan"
            onSubmit={(event) => {
              event.preventDefault();
              void lookup();
            }}
          >
            <ScanBarcode size={22} aria-hidden />
            <input
              ref={scan}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              inputMode={typing ? "text" : "none"}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="search"
              aria-label="Código de barras ou SKU"
              placeholder={looking ? "Procurando…" : "Passe o código de barras ou digite o SKU e Enter"}
            />
            <IconButton
              label={typing ? "Esconder o teclado" : "Digitar o código"}
              active={typing}
              onClick={() => {
                setTyping(!typing);
                focusScan();
              }}
            >
              <Keyboard size={20} />
            </IconButton>
          </form>
          <div className="caixa-categories" role="group" aria-label="Categorias">
            <button type="button" className={"caixa-category" + (category === "all" ? " active" : "")} onClick={() => setCategory("all")}>
              Todos
            </button>
            {categories.map((c) => (
              <button
                type="button"
                key={c.id}
                className={"caixa-category" + (category === c.id ? " active" : "") + (c.color ? " colored" : "")}
                style={c.color ? ({ "--cat": c.color } as React.CSSProperties) : undefined}
                aria-pressed={category === c.id}
                onClick={() => setCategory(c.id)}
              >
                {c.name}
              </button>
            ))}
            {hasOthers && categories.length > 0 && (
              <button type="button" className={"caixa-category" + (category === "none" ? " active" : "")} onClick={() => setCategory("none")}>
                Outros
              </button>
            )}
          </div>
          {!view ? (
            grid.error ? (
              <Notice tone="error" onRetry={() => void grid.reload()}>
                {grid.error}
              </Notice>
            ) : (
              <SkeletonBlock height={320} />
            )
          ) : !products.length ? (
            <Card>
              <Empty
                icon={<ShoppingCart size={28} />}
                title="Nenhum produto ativo"
                description="Os produtos cadastrados em Produtos e estoque aparecem aqui, com foto e preço."
              />
            </Card>
          ) : (
            <div className="caixa-grid">
              {shown.map((p) => {
                const count = inCart(p.id);
                return (
                  <button
                    type="button"
                    key={p.id}
                    className={"caixa-card" + (p.out_of_stock ? " out" : p.low_stock ? " low" : "")}
                    onClick={() => add(p)}
                    aria-label={`${p.name}, ${money(p.price_cents)} por ${p.unit}${p.out_of_stock ? ", sem saldo" : p.low_stock ? ", estoque baixo" : ""}`}
                  >
                    <ProductThumb product={p} className="caixa-card-photo" />
                    <span className="caixa-card-name">{p.name}</span>
                    <span className="caixa-card-price">
                      {money(p.price_cents)}
                      {p.unit !== "UN" && <small>/{p.unit}</small>}
                    </span>
                    {p.out_of_stock ? (
                      <span className="caixa-card-flag out">Sem saldo</span>
                    ) : p.low_stock ? (
                      <span className="caixa-card-flag low">
                        Baixo: {qty(p.stock)} {p.unit}
                      </span>
                    ) : null}
                    {count ? <span className="caixa-card-count">{qty(count)}</span> : null}
                  </button>
                );
              })}
            </div>
          )}
        </section>
        {wide && (
          <aside className="caixa-side" aria-label="Carrinho">
            <Cart {...cartProps} />
          </aside>
        )}
      </div>
      {!wide && (
        <div className="caixa-cartbar">
          <button type="button" className="caixa-cartbar-open" onClick={() => setDialog("cart")}>
            <ShoppingCart size={20} aria-hidden />
            <span>
              {cart.length ? `${cart.length} ${cart.length === 1 ? "item" : "itens"}` : "Carrinho vazio"}
              <strong>{money(totals.total)}</strong>
            </span>
          </button>
          <Button size="lg" disabled={!cart.length || !!totals.error} onClick={() => setDialog("charge")} icon={<Banknote size={20} />}>
            Cobrar
          </Button>
        </div>
      )}
      {dialog === "cart" && !wide && (
        <Dialog title="Carrinho" onClose={() => setDialog(null)} size="md" className="caixa-cart-dialog">
          <Cart {...cartProps} onCharge={() => setDialog("charge")} />
        </Dialog>
      )}
      {pad && (
        <QuantityPad
          product={pad.product}
          initial={pad.initial}
          onClose={() => {
            setPad(null);
            focusScan();
          }}
          onConfirm={(quantity) => {
            const product = pad.product;
            setPad(null);
            if (pad.initial !== undefined) setQuantity(product.id, quantity);
            else add(product, quantity);
          }}
        />
      )}
      {dialog === "charge" && (
        <ChargeDialog
          session={session}
          total={totals.total}
          body={saleBody}
          methods={caixaMethods}
          onClose={() => setDialog(null)}
          onDone={(sale) => {
            setDialog(null);
            setCart([]);
            setDiscount("");
            setDone(sale);
            void grid.reload();
          }}
        />
      )}
      {done && (
        <DoneDialog
          sale={done}
          onClose={() => {
            setDone(null);
            focusScan();
          }}
        />
      )}
      {(dialog === "withdrawal" || dialog === "supply") && <MoveDialog session={session} kind={dialog} onClose={() => setDialog(null)} />}
      {dialog === "return" && (
        <ReturnFlow
          session={session}
          methods={caixaMethods.map((m) => m.id)}
          onClose={() => {
            setDialog(null);
            void grid.reload();
          }}
        />
      )}
      {dialog === "close" && (
        <CloseFlow
          session={{ ...session, register_name: register.name }}
          onClose={() => setDialog(null)}
          onClosed={() => {
            setDialog(null);
            onClosed();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function CaixaPage() {
  const app = useApp();
  const overview = useResource(`${app.root}/caixa`);
  const [selected, setSelected] = useState<string | null>(() => remembered(app.profile));
  const choose = (id: string | null) => {
    setSelected(id);
    remember(app.profile, id);
  };
  const data: Row | null = overview.data;
  if (!data)
    return overview.error ? (
      <Notice tone="error" onRetry={() => void overview.reload()}>
        {overview.error}
      </Notice>
    ) : (
      <SkeletonRows rows={3} avatar={false} />
    );
  const registers: Row[] = data.registers || [];
  const register = registers.find((r) => r.id === selected && r.active) || null;
  const session = register?.session || null;
  if (!register || !session)
    return (
      <RegisterPicker
        registers={registers}
        selected={selected}
        error={overview.error}
        onUse={(r) => choose(r.id)}
        reload={() => void overview.reload()}
      />
    );
  return (
    <PointOfSale
      key={session.id}
      register={register}
      session={session}
      methods={data.payment_methods || []}
      onLeave={() => choose(null)}
      onClosed={() => void overview.reload()}
    />
  );
}
