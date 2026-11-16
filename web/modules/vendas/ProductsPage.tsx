// Gestão → Produtos e estoque (módulo "vendas", docs/VENDAS.md): catálogo com
// foto, preço, unidade, códigos e saldo; categorias com cor; produto com os
// dados fiscais da NF-e/NFC-e; entrada, saída e ajuste de estoque e o
// histórico de movimentos. A equipe vê e dá entrada; só administradores
// editam produtos e categorias, e fazem saída e ajuste.
import React, { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Boxes,
  Package,
  Pencil,
  Plus,
  Tags,
  Trash2,
} from "lucide-react";
import { useApp } from "../../app/AppContext";
import { useAction } from "../../app/hooks";
import type { Row } from "../../lib/api";
import {
  Button,
  Chip,
  Confirm,
  Dialog,
  Empty,
  Field,
  Notice,
  Pill,
  SearchBox,
  Segmented,
  SkeletonRows,
  Switch,
  Table,
  toast,
} from "../../ui";
import { FormDialog, Pager, useList, useResource } from "../../admin/shared";
import {
  cents,
  centsInput,
  dateTime,
  decimal,
  money,
  moveTones,
  numberInput,
  ProductThumb,
  qty,
  upload,
  mediaUrl,
  useModuleWrite,
} from "./shared";
import {
  csosnOptions,
  icmsCstOptions,
  ipiCstOptions,
  isSimples,
  originOptions,
  pisCofinsOptions,
  withCurrent,
} from "./fiscal";
import "./vendas.css";

const units = ["UN", "KG", "G", "L", "ML", "M", "M2", "CX", "PC", "PCT", "DZ", "KIT"];

/** Saldo com o destaque de estoque baixo e sem saldo. */
export function StockPill({ product }: { product: Row }) {
  if (!product.track_stock || product.stock === null)
    return <Pill tone="muted">Sem controle de estoque</Pill>;
  const label = `${qty(product.stock)} ${product.unit}`;
  if (product.out_of_stock)
    return <Pill tone="danger">Sem saldo · {label}</Pill>;
  if (product.low_stock)
    return <Pill tone="warn">Estoque baixo · {label}</Pill>;
  return <Pill tone="ok">{label}</Pill>;
}

// ---------------------------------------------------------------------------
// Produto

const fiscalTexts = [
  "ncm",
  "cest",
  "cfop",
  "icms_cst",
  "icms_csosn",
  "pis_cst",
  "cofins_cst",
  "ipi_cst",
  "tax_unit",
  "tax_ean",
  "cbenef",
  "ibs_cbs_cst",
  "cclasstrib",
];
const fiscalNumbers: [string, string][] = [
  ["icms_rate", "Alíquota do ICMS"],
  ["icms_base_reduction", "Redução da base do ICMS"],
  ["fcp_rate", "Alíquota do FCP"],
  ["pis_rate", "Alíquota do PIS"],
  ["cofins_rate", "Alíquota da COFINS"],
  ["ipi_rate", "Alíquota do IPI"],
  ["tax_factor", "Fator da unidade tributável"],
];

function fiscalDraft(fiscal: Row = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of fiscalTexts) out[key] = fiscal[key] ?? "";
  for (const [key] of fiscalNumbers) out[key] = numberInput(fiscal[key]);
  out.origin = fiscal.origin === undefined ? "" : String(fiscal.origin);
  return out;
}

function fiscalBody(draft: Record<string, string>, mode: "csosn" | "cst") {
  const out: Row = {};
  for (const key of fiscalTexts) {
    if (key === (mode === "csosn" ? "icms_cst" : "icms_csosn")) continue;
    const value = (draft[key] || "").trim();
    if (value) out[key] = key === "tax_ean" || key === "cbenef" || key === "tax_unit" ? value.toUpperCase() : value;
  }
  for (const [key, label] of fiscalNumbers) {
    if (!(draft[key] || "").trim()) continue;
    const value = decimal(draft[key]);
    if (value === null) throw new Error(`${label}: informe um número (ex.: 18 ou 1,65).`);
    out[key] = value;
  }
  if (draft.origin !== "") out.origin = Number(draft.origin);
  return out;
}

function ProductDialog({
  initial,
  categories,
  onClose,
  onSaved,
}: {
  initial: Row;
  categories: Row[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const app = useApp();
  const write = useModuleWrite();
  const file = useRef<HTMLInputElement>(null);
  const creating = !initial.id;
  const regime = app.settings.vendas?.fiscal?.regime;
  const fiscal = initial.fiscal || {};
  const [draft, setDraft] = useState<Row>(() => ({
    name: initial.name || "",
    category_id: initial.category_id || "",
    description: initial.description || "",
    price: centsInput(initial.price_cents),
    cost: initial.cost_cents === null || initial.cost_cents === undefined ? "" : centsInput(initial.cost_cents),
    unit: initial.unit || "UN",
    fractional: !!initial.fractional,
    ean: initial.ean || "",
    sku: initial.sku || "",
    photo_media_id: initial.photo_media_id || null,
    active: initial.active !== false,
    track_stock: initial.track_stock !== false,
    allow_negative: !!initial.allow_negative,
    min_stock: numberInput(initial.min_stock || undefined),
    stock: "",
    position: String(initial.position ?? 0),
  }));
  const [tax, setTax] = useState(() => fiscalDraft(fiscal));
  const [icms, setIcms] = useState<"csosn" | "cst">(
    fiscal.icms_cst ? "cst" : fiscal.icms_csosn ? "csosn" : isSimples(regime) || !regime ? "csosn" : "cst",
  );
  const set = (key: string) => (value: any) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const setT = (key: string) => (value: string) =>
    setTax((current) => ({ ...current, [key]: value }));
  const option = (list: [string, string][], key: string) =>
    withCurrent(list, tax[key]);
  return (
    <FormDialog
      title={creating ? "Novo produto" : `Editar ${initial.name}`}
      size="xl"
      onClose={onClose}
      onSubmit={async () => {
        const price = cents(draft.price);
        if (price === null) throw new Error("Preço inválido. Use, por exemplo, 12,90.");
        const cost = draft.cost.trim() ? cents(draft.cost) : null;
        if (draft.cost.trim() && cost === null) throw new Error("Custo inválido. Use, por exemplo, 7,50.");
        const minStock = draft.min_stock.trim() ? decimal(draft.min_stock) : 0;
        if (minStock === null || minStock < 0) throw new Error("Estoque mínimo: informe um número (ex.: 5 ou 2,5).");
        const position = Number(draft.position || 0);
        if (!Number.isInteger(position) || position < 0) throw new Error("Posição: número inteiro de 0 em diante.");
        let photo = draft.photo_media_id;
        const chosen = file.current?.files?.[0];
        if (chosen) photo = await upload(app, chosen);
        const body: Row = {
          name: draft.name,
          category_id: draft.category_id || null,
          description: draft.description,
          price_cents: price,
          cost_cents: cost,
          unit: (draft.unit || "UN").toUpperCase(),
          fractional: draft.fractional,
          ean: draft.ean.trim() || null,
          sku: draft.sku.trim() || null,
          photo_media_id: photo || null,
          active: draft.active,
          track_stock: draft.track_stock,
          allow_negative: draft.allow_negative,
          min_stock: minStock,
          position,
          fiscal: fiscalBody(tax, icms),
        };
        if (creating && draft.track_stock && draft.stock.trim()) {
          const stock = decimal(draft.stock);
          if (stock === null || stock < 0) throw new Error("Estoque inicial: informe um número (ex.: 10 ou 2,5).");
          body.stock = stock;
        }
        if (creating) await write("vendas/products", "POST", body);
        else await write(`vendas/products/${initial.id}`, "PUT", body);
        toast(creating ? "Produto criado." : "Produto atualizado.");
        onSaved();
      }}
    >
      <div className="form-field-grid">
        <Field label="Nome" value={draft.name} onChange={set("name")} maxLength={120} required placeholder="Ex.: Café torrado 500 g" />
        <Field
          label="Categoria"
          value={draft.category_id}
          onChange={set("category_id")}
          options={categories.map((c) => ({ id: c.id, name: c.name }))}
          emptyOption="Sem categoria"
        />
      </div>
      <Field label="Descrição (opcional)" type="textarea" rows={2} value={draft.description} onChange={set("description")} maxLength={500} />
      <div className="vendas-grid-3">
        <Field label="Preço de venda (R$)" value={draft.price} onChange={set("price")} placeholder="0,00" required />
        <Field label="Custo (R$, opcional)" value={draft.cost} onChange={set("cost")} placeholder="0,00" help="Só a equipe vê; não vai ao cliente." />
        <label className="field">
          <span>Unidade</span>
          <input
            list="vendas-units"
            value={draft.unit}
            maxLength={6}
            onChange={(event) => set("unit")(event.target.value.toUpperCase())}
            required
          />
          <datalist id="vendas-units">
            {units.map((unit) => (
              <option key={unit} value={unit} />
            ))}
          </datalist>
          <small>UN, KG, L, M, CX…</small>
        </label>
      </div>
      <label className="vendas-toggle">
        <Switch label="Vende fracionado" checked={draft.fractional} onChange={set("fractional")} />
        Vende fracionado (ex.: 0,5 kg; o caixa pede a quantidade)
      </label>
      <div className="form-field-grid">
        <Field label="Código de barras (EAN/GTIN)" value={draft.ean} onChange={set("ean")} maxLength={14} placeholder="7891234567895" help="8, 12, 13 ou 14 dígitos com o dígito verificador." />
        <Field label="Código interno (SKU)" value={draft.sku} onChange={set("sku")} maxLength={60} placeholder="CAFE-500" />
      </div>
      <label className="field">
        <span>Foto (caixa e painel)</span>
        <div className="vendas-photo-row">
          {draft.photo_media_id && (
            <img src={mediaUrl(app, draft.photo_media_id)} alt="" width={56} height={56} />
          )}
          <input type="file" accept="image/jpeg,image/png,image/webp" ref={file} />
          {draft.photo_media_id && (
            <Button secondary size="sm" onClick={() => set("photo_media_id")(null)}>
              Remover foto
            </Button>
          )}
        </div>
        <small>JPG, PNG ou WebP, guardada nos arquivos da área.</small>
      </label>
      <fieldset className="form-field-editor">
        <legend>Estoque</legend>
        <label className="vendas-toggle">
          <Switch label="Controla estoque" checked={draft.track_stock} onChange={set("track_stock")} />
          {draft.track_stock ? "Controla o saldo: vendas baixam e devoluções voltam" : "Sem controle de saldo (serviço, item sob encomenda)"}
        </label>
        {draft.track_stock && (
          <>
            <label className="vendas-toggle">
              <Switch label="Permite saldo negativo" checked={draft.allow_negative} onChange={set("allow_negative")} />
              Permite vender sem saldo (o saldo fica negativo)
            </label>
            <div className="form-field-grid">
              <Field label="Estoque mínimo" value={draft.min_stock} onChange={set("min_stock")} placeholder="0" help="No mínimo ou abaixo, o produto aparece como estoque baixo." />
              {creating ? (
                <Field label="Estoque inicial" value={draft.stock} onChange={set("stock")} placeholder="0" help="Só agora; depois o saldo muda por movimentos." />
              ) : (
                <div className="field">
                  <span>Saldo atual</span>
                  <p className="vendas-static">
                    {qty(initial.stock)} {initial.unit} · altere por Estoque
                  </p>
                </div>
              )}
            </div>
          </>
        )}
      </fieldset>
      <div className="form-field-grid">
        <label className="vendas-toggle">
          <Switch label="Ativo" checked={draft.active} onChange={set("active")} />
          {draft.active ? "Ativo: aparece no caixa e nos orçamentos" : "Arquivado: não pode ser vendido"}
        </label>
        <Field label="Posição na grade do caixa" type="number" min={0} max={100000} value={draft.position} onChange={set("position")} />
      </div>
      <details className="vendas-fiscal" open={!creating && !!fiscal.ncm}>
        <summary>Dados fiscais (NF-e/NFC-e)</summary>
        <p className="muted">
          Todos opcionais ao salvar. Em branco, a nota usa os padrões do
          emitente (Regras e nota fiscal). A prévia da nota de cada venda
          aponta o que falta. Confira os códigos com a sua contabilidade.
        </p>
        <div className="vendas-grid-3">
          <Field label="NCM" value={tax.ncm} onChange={setT("ncm")} maxLength={10} placeholder="8 dígitos" />
          <Field label="CEST" value={tax.cest} onChange={setT("cest")} maxLength={9} placeholder="7 dígitos" />
          <Field label="CFOP" value={tax.cfop} onChange={setT("cfop")} maxLength={4} placeholder="Ex.: 5102" />
        </div>
        <Field label="Origem da mercadoria" value={tax.origin} onChange={setT("origin")} options={originOptions} emptyOption="Padrão do emitente" />
        <div className="vendas-subhead">
          <strong>ICMS</strong>
          <Segmented
            label="Tributação do ICMS"
            value={icms}
            onChange={setIcms}
            options={[
              { value: "csosn", label: "Simples Nacional (CSOSN)" },
              { value: "cst", label: "Regime normal (CST)" },
            ]}
          />
        </div>
        <div className="vendas-grid-3">
          {icms === "csosn" ? (
            <Field label="CSOSN" value={tax.icms_csosn} onChange={setT("icms_csosn")} options={option(csosnOptions, "icms_csosn")} emptyOption="Padrão do emitente" />
          ) : (
            <Field label="CST do ICMS" value={tax.icms_cst} onChange={setT("icms_cst")} options={option(icmsCstOptions, "icms_cst")} emptyOption="Padrão do emitente" />
          )}
          <Field label="Alíquota do ICMS (%)" value={tax.icms_rate} onChange={setT("icms_rate")} placeholder="Ex.: 18" />
          <Field label="Redução da base (%)" value={tax.icms_base_reduction} onChange={setT("icms_base_reduction")} placeholder="0" />
          <Field label="Alíquota do FCP (%)" value={tax.fcp_rate} onChange={setT("fcp_rate")} placeholder="0" />
          <Field label="cBenef (benefício fiscal)" value={tax.cbenef} onChange={setT("cbenef")} maxLength={10} placeholder="8 ou 10 caracteres" />
        </div>
        <div className="vendas-subhead">
          <strong>PIS, COFINS e IPI</strong>
        </div>
        <div className="form-field-grid">
          <Field label="CST do PIS" value={tax.pis_cst} onChange={setT("pis_cst")} options={option(pisCofinsOptions, "pis_cst")} emptyOption="Padrão do emitente" />
          <Field label="Alíquota do PIS (%)" value={tax.pis_rate} onChange={setT("pis_rate")} placeholder="Ex.: 0,65" />
          <Field label="CST da COFINS" value={tax.cofins_cst} onChange={setT("cofins_cst")} options={option(pisCofinsOptions, "cofins_cst")} emptyOption="Padrão do emitente" />
          <Field label="Alíquota da COFINS (%)" value={tax.cofins_rate} onChange={setT("cofins_rate")} placeholder="Ex.: 3" />
          <Field label="CST do IPI (só NF-e)" value={tax.ipi_cst} onChange={setT("ipi_cst")} options={option(ipiCstOptions, "ipi_cst")} emptyOption="Sem IPI" />
          <Field label="Alíquota do IPI (%)" value={tax.ipi_rate} onChange={setT("ipi_rate")} placeholder="0" />
        </div>
        <div className="vendas-subhead">
          <strong>Unidade tributável</strong>
        </div>
        <div className="vendas-grid-3">
          <Field label="Unidade tributável" value={tax.tax_unit} onChange={setT("tax_unit")} maxLength={6} placeholder={draft.unit || "UN"} />
          <Field label="Fator" value={tax.tax_factor} onChange={setT("tax_factor")} placeholder="1" help="Quantidade tributável = quantidade × fator." />
          <Field label="GTIN tributável" value={tax.tax_ean} onChange={setT("tax_ean")} maxLength={14} placeholder="SEM GTIN" />
        </div>
        <div className="vendas-subhead">
          <strong>Reforma tributária (opcional)</strong>
        </div>
        <div className="form-field-grid">
          <Field label="CST do IBS/CBS" value={tax.ibs_cbs_cst} onChange={setT("ibs_cbs_cst")} maxLength={3} placeholder="3 dígitos" />
          <Field label="cClassTrib" value={tax.cclasstrib} onChange={setT("cclasstrib")} maxLength={6} placeholder="6 dígitos" />
        </div>
      </details>
    </FormDialog>
  );
}

// ---------------------------------------------------------------------------
// Categorias

function CategoryDialog({
  initial,
  onClose,
  onSaved,
}: {
  initial: Row;
  onClose: () => void;
  onSaved: () => void;
}) {
  const write = useModuleWrite();
  const [name, setName] = useState(initial.name || "");
  const [color, setColor] = useState<string>(initial.color || "");
  return (
    <FormDialog
      title={initial.id ? "Editar categoria" : "Nova categoria"}
      size="sm"
      onClose={onClose}
      onSubmit={async () => {
        const body = { name, color: color || "" };
        if (initial.id) await write(`vendas/categories/${initial.id}`, "PUT", body);
        else await write("vendas/categories", "POST", body);
        toast("Categoria salva.");
        onSaved();
      }}
    >
      <Field label="Nome" value={name} onChange={setName} maxLength={40} required placeholder="Ex.: Bebidas, Padaria" />
      <div className="field">
        <span>Cor no caixa</span>
        <div className="vendas-photo-row">
          <input
            type="color"
            aria-label="Cor da categoria"
            value={color || "#008069"}
            onChange={(event) => setColor(event.target.value)}
          />
          {color ? (
            <Button secondary size="sm" onClick={() => setColor("")}>
              Sem cor
            </Button>
          ) : (
            <small className="muted">Sem cor: o botão fica neutro.</small>
          )}
        </div>
      </div>
    </FormDialog>
  );
}

function CategoriesDialog({
  categories,
  onClose,
  reload,
}: {
  categories: Row[];
  onClose: () => void;
  reload: () => void;
}) {
  const write = useModuleWrite();
  const { busy, run } = useAction();
  const [editing, setEditing] = useState<Row | null>(null);
  const [removing, setRemoving] = useState<Row | null>(null);
  const move = (index: number, delta: number) => {
    const other = categories[index + delta];
    if (!other) return;
    void run(async () => {
      await write(`vendas/categories/${categories[index].id}`, "PUT", { position: index + delta });
      await write(`vendas/categories/${other.id}`, "PUT", { position: index });
      reload();
    });
  };
  return (
    <>
      <Dialog
        title="Categorias"
        subtitle="Viram os botões coloridos do caixa, nesta ordem."
        onClose={onClose}
        size="md"
        footer={
          <>
            <Button secondary onClick={onClose}>
              Fechar
            </Button>
            <Button icon={<Plus size={16} />} onClick={() => setEditing({})}>
              Nova categoria
            </Button>
          </>
        }
      >
        {!categories.length ? (
          <Empty compact icon={<Tags size={28} />} title="Nenhuma categoria" description="Bebidas, Padaria, Hortifruti… Sem categoria, o produto fica em Outros." />
        ) : (
          <div className="vendas-category-list">
            {categories.map((category, index) => (
              <div className="vendas-category-row" key={category.id}>
                <span className="vendas-dot" style={category.color ? { background: category.color } : undefined} aria-hidden />
                <strong>{category.name}</strong>
                <span className="spacer" />
                <Button secondary size="sm" aria-label={`Subir ${category.name}`} disabled={busy || index === 0} onClick={() => move(index, -1)}>
                  <ArrowUp size={16} />
                </Button>
                <Button secondary size="sm" aria-label={`Descer ${category.name}`} disabled={busy || index === categories.length - 1} onClick={() => move(index, 1)}>
                  <ArrowDown size={16} />
                </Button>
                <Button secondary size="sm" aria-label={`Editar ${category.name}`} onClick={() => setEditing(category)}>
                  <Pencil size={16} />
                </Button>
                <Button secondary size="sm" aria-label={`Excluir ${category.name}`} onClick={() => setRemoving(category)}>
                  <Trash2 size={16} />
                </Button>
              </div>
            ))}
          </div>
        )}
      </Dialog>
      {editing && (
        <CategoryDialog
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
      {removing && (
        <Confirm
          title={`Excluir ${removing.name}?`}
          confirmLabel="Excluir"
          danger
          busy={busy}
          onClose={() => setRemoving(null)}
          onConfirm={() =>
            void run(
              async () => {
                await write(`vendas/categories/${removing.id}`, "DELETE");
                setRemoving(null);
                reload();
              },
              { success: "Categoria excluída." },
            )
          }
        >
          Os produtos dela ficam sem categoria (em Outros no caixa).
        </Confirm>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Estoque: movimento e histórico

function StockDialog({
  product,
  onClose,
  onChanged,
}: {
  product: Row;
  onClose: () => void;
  onChanged: () => void;
}) {
  const app = useApp();
  const write = useModuleWrite();
  const [current, setCurrent] = useState<Row>(product);
  const [type, setType] = useState<"entrada" | "saida" | "ajuste">("entrada");
  const [quantity, setQuantity] = useState("");
  const [cost, setCost] = useState("");
  const [note, setNote] = useState("");
  const history = useList(`${app.root}/vendas/stock/moves?product_id=${encodeURIComponent(product.id)}&limit=20`);
  const types = [
    { value: "entrada" as const, label: "Entrada" },
    ...(app.isAdmin
      ? [
          { value: "saida" as const, label: "Saída" },
          { value: "ajuste" as const, label: "Ajuste de inventário" },
        ]
      : []),
  ];
  const quantityLabel =
    type === "ajuste" ? `Saldo contado (${current.unit})` : type === "saida" ? `Quantidade que saiu (${current.unit})` : `Quantidade que entrou (${current.unit})`;
  return (
    <FormDialog
      title={`Estoque de ${product.name}`}
      subtitle={
        <>
          Saldo: <StockPill product={current} />
        </>
      }
      submitLabel="Registrar movimento"
      size="lg"
      disabled={!current.track_stock}
      onClose={onClose}
      onSubmit={async () => {
        const amount = decimal(quantity);
        if (amount === null || amount < 0 || (type !== "ajuste" && amount === 0))
          throw new Error(type === "ajuste" ? "Informe o saldo contado (zero ou mais)." : "Informe a quantidade (maior que zero).");
        if (!current.fractional && !Number.isInteger(amount))
          throw new Error(`${current.name} é vendido só em quantidades inteiras.`);
        const item: Row = { product_id: product.id, quantity: amount };
        if (type === "entrada" && cost.trim()) {
          const value = cents(cost);
          if (value === null) throw new Error("Custo unitário inválido. Use, por exemplo, 7,50.");
          item.cost_cents = value;
        }
        await write("vendas/stock/moves", "POST", { type, items: [item], note });
        toast(type === "ajuste" ? "Inventário ajustado." : type === "saida" ? "Saída registrada." : "Entrada registrada.");
        setQuantity("");
        setCost("");
        setNote("");
        const fresh = await app.api(`${app.root}/vendas/products/${product.id}`).catch(() => null);
        if (fresh) setCurrent(fresh);
        void history.reload();
        onChanged();
      }}
    >
      {!current.track_stock ? (
        <Notice tone="warn">
          {product.name} não controla estoque.{" "}
          {app.isAdmin ? "Ligue o controle em Editar produto." : "Peça a um administrador para ligar o controle."}
        </Notice>
      ) : (
        <>
          <div className="toolbar">
            <Segmented label="Tipo de movimento" value={type} onChange={setType} options={types} />
          </div>
          {!app.isAdmin && (
            <p className="muted">Saída e ajuste de inventário: somente administradores.</p>
          )}
          <div className="vendas-grid-3">
            <Field label={quantityLabel} value={quantity} onChange={setQuantity} placeholder={current.fractional ? "Ex.: 2,5" : "Ex.: 10"} required />
            {type === "entrada" && (
              <Field label="Custo unitário (R$, opcional)" value={cost} onChange={setCost} placeholder="0,00" />
            )}
            <Field
              label="Observação"
              value={note}
              onChange={setNote}
              maxLength={300}
              placeholder={type === "entrada" ? "Ex.: NF 1234 do fornecedor" : type === "saida" ? "Ex.: quebra, uso interno" : "Ex.: contagem de fim de mês"}
            />
          </div>
          {type === "ajuste" && (
            <small className="muted">O ajuste grava a diferença entre o saldo atual e o contado.</small>
          )}
        </>
      )}
      <h3 className="vendas-h3">Histórico de movimentos</h3>
      {history.error ? (
        <Notice tone="error" onRetry={() => void history.reload()}>
          {history.error}
        </Notice>
      ) : !history.loaded ? (
        <SkeletonRows rows={3} avatar={false} />
      ) : (
        <Table
          rows={history.rows}
          columns={[
            ["created", "Quando", (row) => dateTime(row.created)],
            ["type", "Tipo", (row) => <Pill tone={moveTones[row.type] || "muted"}>{row.type_label}</Pill>],
            ["quantity", "Quantidade", (row) => `${row.quantity > 0 ? "+" : ""}${qty(row.quantity)} ${row.unit || current.unit}`],
            ["balance", "Saldo depois", (row) => qty(row.balance)],
            ["cost", "Custo", (row) => (row.cost_cents === null || row.cost_cents === undefined ? "—" : money(row.cost_cents))],
            ["note", "Observação", (row) => row.note || "—"],
            ["actor", "Quem", (row) => app.names[row.actor] || (row.actor === "system" ? "Wabotia" : row.actor) || "—"],
          ]}
          empty={<Empty compact icon={<Boxes size={28} />} title="Nenhum movimento" description="Entradas, saídas, ajustes, vendas e devoluções aparecem aqui." />}
        />
      )}
      <Pager cursor={history.cursor} nextCursor={history.nextCursor} setCursor={history.setCursor} />
    </FormDialog>
  );
}

// ---------------------------------------------------------------------------

export function ProductsPage() {
  const app = useApp();
  const write = useModuleWrite();
  const { busy, run } = useAction();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [low, setLow] = useState(false);
  const [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [stock, setStock] = useState<Row | null>(null);
  const [managing, setManaging] = useState(false);
  const [removing, setRemoving] = useState<Row | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const params = new URLSearchParams({ limit: "100" });
  if (query) params.set("q", query);
  if (category) params.set("category_id", category);
  if (low) params.set("low", "1");
  if (archived) params.set("active", "all");
  const list = useList(`${app.root}/vendas/products?${params.toString()}`);
  const categoriesResource = useResource(`${app.root}/vendas/categories`);
  const categories: Row[] = categoriesResource.data?.data || [];
  const categoryName = (id: string | null) => categories.find((c) => c.id === id)?.name;
  const reload = () => void list.reload();
  return (
    <div className="vendas-page">
      <div className="toolbar">
        <SearchBox value={search} onChange={setSearch} placeholder="Buscar por nome, SKU ou código de barras" />
        {app.isAdmin && (
          <div className="card-actions">
            <Button secondary icon={<Tags size={16} />} onClick={() => setManaging(true)}>
              Categorias
            </Button>
            <Button icon={<Plus size={16} />} onClick={() => setEditing({})}>
              Novo produto
            </Button>
          </div>
        )}
      </div>
      <div className="vendas-filters">
        <Field
          label="Categoria"
          value={category}
          onChange={setCategory}
          options={[...categories.map((c) => ({ id: c.id, name: c.name })), { id: "none", name: "Sem categoria" }]}
          emptyOption="Todas"
        />
        <div className="chip-row vendas-chip-wrap" role="group" aria-label="Filtros do catálogo">
          <Chip active={low} tone="warn" onClick={() => setLow(!low)}>
            Só estoque baixo
          </Chip>
          <Chip active={archived} onClick={() => setArchived(!archived)}>
            Mostrar arquivados
          </Chip>
        </div>
      </div>
      {list.error && (
        <Notice tone="error" onRetry={reload}>
          {list.error}
        </Notice>
      )}
      <section className="card">
        {!list.loaded && !list.error ? (
          <SkeletonRows rows={5} avatar />
        ) : !list.rows.length ? (
          <Empty
            compact
            icon={<Package size={28} />}
            title={query || category || low ? "Nenhum produto encontrado" : "Catálogo vazio"}
            description={
              query || category || low
                ? "Mude a busca ou os filtros."
                : app.isAdmin
                  ? "Cadastre os produtos com foto, preço, código de barras e estoque."
                  : "Um administrador cadastra os produtos com preço e estoque."
            }
          />
        ) : (
          <div className="vendas-products">
            {list.rows.map((product) => (
              <div className={"vendas-product" + (product.active ? "" : " archived")} key={product.id}>
                <ProductThumb product={product} />
                <div className="info">
                  <strong>{product.name}</strong>{" "}
                  {!product.active && <Pill tone="muted">Arquivado</Pill>}
                  <small>
                    {[
                      categoryName(product.category_id) || "Sem categoria",
                      product.ean && `EAN ${product.ean}`,
                      product.sku && `SKU ${product.sku}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                </div>
                <span className="price">
                  {money(product.price_cents)}
                  <small> / {product.unit}</small>
                </span>
                <StockPill product={product} />
                <div className="actions">
                  <Button secondary size="sm" icon={<Boxes size={16} />} onClick={() => setStock(product)}>
                    Estoque
                  </Button>
                  {app.isAdmin && (
                    <>
                      <Button secondary size="sm" aria-label={`Editar ${product.name}`} onClick={() => setEditing(product)}>
                        <Pencil size={16} />
                      </Button>
                      {product.active && (
                        <Button secondary size="sm" aria-label={`Arquivar ou excluir ${product.name}`} onClick={() => setRemoving(product)}>
                          <Trash2 size={16} />
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        <Pager cursor={list.cursor} nextCursor={list.nextCursor} setCursor={list.setCursor} />
      </section>
      {editing && (
        <ProductDialog
          initial={editing}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
      {stock && <StockDialog product={stock} onClose={() => setStock(null)} onChanged={reload} />}
      {managing && (
        <CategoriesDialog
          categories={categories}
          onClose={() => setManaging(false)}
          reload={() => {
            void categoriesResource.reload();
            reload();
          }}
        />
      )}
      {removing && (
        <Confirm
          title={`Tirar ${removing.name} do catálogo?`}
          confirmLabel="Arquivar ou excluir"
          danger
          busy={busy}
          onClose={() => setRemoving(null)}
          onConfirm={() =>
            void run(async () => {
              const result = await write(`vendas/products/${removing.id}`, "DELETE");
              toast(result?.archived ? `${removing.name} arquivado: tem histórico de vendas ou estoque.` : `${removing.name} excluído.`);
              setRemoving(null);
              reload();
            })
          }
        >
          Produto com movimentos, vendas ou orçamentos é arquivado (some do caixa e
          pode voltar em Mostrar arquivados); sem histórico, é excluído.
        </Confirm>
      )}
    </div>
  );
}
