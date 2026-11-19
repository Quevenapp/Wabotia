import { integrationAccess, useIntegrationHost } from '../integrations/visibility';
import { CatalogLinkPicker } from '../integrations/CatalogLinkPicker';
// Gestão → Cardápio e loja (módulo "pedido", docs/PEDIDO.md): categorias,
// itens com foto e adicionais, grupos de adicionais com mínimo e máximo,
// imagens do cardápio enviadas no WhatsApp, regras da loja (horário, retirada
// e entrega, taxas, pagamento, prazos, alertas) e mensagens ao cliente.
import React, { useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  FileText,
  ImagePlus,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useApp } from "../../app/AppContext";
import { useAction, useUnsavedGuard } from "../../app/hooks";
import { useIntents, type Row } from "../../lib/api";
import {
  Button,
  Card,
  Confirm,
  Empty,
  Field,
  Notice,
  Pill,
  Segmented,
  SkeletonRows,
  Switch,
  toast,
} from "../../ui";
import { FormDialog, toggled, useResource } from "../../admin/shared";
import { cents, centsInput, money, paymentLabels, weekdays } from "./shared";
import "./pedido.css";

/** Padrões do servidor (src/modules/pedido/model.ts, PEDIDO_DEFAULTS). */
const defaults: Row = {
  store_name: "",
  hours: [],
  pickup: true,
  delivery: false,
  delivery_fee_cents: 0,
  minimum_cents: 0,
  pickup_minutes: 20,
  delivery_minutes: 45,
  pickup_address: "",
  payments: { pix: false, link: false, cash: true, card: true },
  pay_before_prepare: true,
  payment_minutes: 30,
  cart_minutes: 60,
  alerts: { received: 10, preparing: 40, ready: 60, out_for_delivery: 90 },
  texts: {
    awaiting_payment:
      "Pedido nº {numero} registrado. Ele vai para o preparo assim que o pagamento for confirmado.",
    received: "Pedido nº {numero} recebido! {previsao}",
    preparing: "Pedido nº {numero} em preparo.",
    ready: "Pedido nº {numero} pronto para retirada! {endereco}",
    out_for_delivery: "Pedido nº {numero} saiu para entrega.",
    delivered: "Pedido nº {numero} entregue. Obrigado pela preferência!",
    cancelled: "Pedido nº {numero} cancelado. {motivo}",
    closed:
      "Estamos fechados agora. {abre}\n\nHorário de funcionamento:\n{horario}",
    paused:
      "No momento não estamos recebendo pedidos. Tente de novo mais tarde.",
  },
};

const textFields: [string, string][] = [
  ["awaiting_payment", "Esperando o pagamento online"],
  ["received", "Recebido (foi para o preparo)"],
  ["preparing", "Em preparo"],
  ["ready", "Pronto para retirada"],
  ["out_for_delivery", "Saiu para entrega"],
  ["delivered", "Entregue"],
  ["cancelled", "Cancelado"],
  ["closed", "Loja fechada (fora do horário)"],
  ["paused", "Loja pausada"],
];

const alertFields: [string, string][] = [
  ["received", "Novo sem começar"],
  ["preparing", "Em preparo"],
  ["ready", "Pronto sem retirar"],
  ["out_for_delivery", "Saiu e não foi entregue"],
];

const menuTypes = [
  { type: "pedido_cardapio", label: "Cardápio" },
  { type: "pedido_acompanhar", label: "Acompanhar pedido" },
];

function merged(saved: Row | undefined): Row {
  return {
    ...defaults,
    ...(saved || {}),
    payments: { ...defaults.payments, ...(saved?.payments || {}) },
    alerts: { ...defaults.alerts, ...(saved?.alerts || {}) },
    texts: { ...defaults.texts, ...(saved?.texts || {}) },
  };
}

function usePedidoWrite() {
  const app = useApp();
  const write = useIntents(app.api);
  return (path: string, method: string, body: Row = {}) =>
    write(`${app.root}/pedido${path}`, method, body);
}

/** Envia um arquivo pelo caminho de mídia do núcleo e devolve o id. */
async function upload(app: ReturnType<typeof useApp>, file: File) {
  const data = new FormData();
  data.set("file", file);
  return (await app.api(app.root + "/media", "POST", data)).id as string;
}
const mediaUrl = (app: ReturnType<typeof useApp>, id: string) =>
  `/api/${app.root}/media/${encodeURIComponent(id)}/content?inline=1`;

// ---------------------------------------------------------------------------
// Itens e categorias

function ItemDialog({
  initial,
  menu,
  onClose,
  onSaved,
}: {
  initial: Row;
  menu: Row;
  onClose: () => void;
  onSaved: () => void;
}) {
  const app = useApp();
  const write = usePedidoWrite();
  const file = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<Row>(() => ({
    category_id: initial.category_id || menu.categories[0]?.id || "",
    name: initial.name || "",
    description: initial.description || "",
    price: centsInput(initial.price_cents),
    max_quantity: String(initial.max_quantity || 20),
    image_url: initial.image_url || "",
    retailer_id: initial.retailer_id || "",
    photo_media_id: initial.photo_media_id || null,
    group_ids: initial.group_ids || [],
    available: initial.available !== false,
  }));
  const set = (key: string) => (value: any) =>
    setDraft((current) => ({ ...current, [key]: value }));
  return (
    <FormDialog
      title={initial.id ? `Editar ${initial.name}` : "Novo item"}
      size="lg"
      onClose={onClose}
      onSubmit={async () => {
        const price = cents(draft.price);
        if (price === null)
          throw new Error("Preço inválido. Use, por exemplo, 25,00.");
        let photo = draft.photo_media_id;
        const chosen = file.current?.files?.[0];
        if (chosen) photo = await upload(app, chosen);
        const body = {
          category_id: draft.category_id,
          name: draft.name,
          description: draft.description,
          price_cents: price,
          max_quantity: Number(draft.max_quantity) || 20,
          image_url: draft.image_url || null,
          retailer_id: draft.retailer_id || null,
          photo_media_id: photo || null,
          group_ids: draft.group_ids,
          available: draft.available,
        };
        if (initial.id) await write(`/items/${initial.id}`, "PUT", body);
        else await write("/items", "POST", body);
        toast(initial.id ? "Item atualizado." : "Item criado.");
        onSaved();
      }}
    >
      <div className="form-field-grid">
        <Field
          label="Categoria"
          value={draft.category_id}
          onChange={set("category_id")}
          options={menu.categories.map((c: Row) => ({
            id: c.id,
            name: c.name,
          }))}
          emptyOption={null}
          required
        />
        <Field
          label="Nome"
          value={draft.name}
          onChange={set("name")}
          maxLength={80}
          required
          placeholder="Ex.: X-Burger"
        />
      </div>
      <Field
        label="Descrição"
        type="textarea"
        rows={2}
        value={draft.description}
        onChange={set("description")}
        maxLength={300}
        placeholder="Ex.: pão, carne de 150 g e queijo"
      />
      <div className="form-field-grid">
        <Field
          label="Preço (R$)"
          value={draft.price}
          onChange={set("price")}
          placeholder="0,00"
          required
        />
        <Field
          label="Quantidade máxima por pedido"
          type="number"
          min={1}
          max={99}
          value={draft.max_quantity}
          onChange={set("max_quantity")}
        />
      </div>
      <label className="field">
        <span>Foto (WhatsApp e painel)</span>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          {draft.photo_media_id && (
            <img
              src={mediaUrl(app, draft.photo_media_id)}
              alt=""
              width={56}
              height={56}
              style={{ objectFit: "cover", borderRadius: 10 }}
            />
          )}
          <input type="file" accept="image/jpeg,image/png" ref={file} />
          {draft.photo_media_id && (
            <Button
              secondary
              size="sm"
              onClick={() => set("photo_media_id")(null)}
            >
              Remover foto
            </Button>
          )}
        </div>
        <small>JPG ou PNG, guardada nos arquivos da área.</small>
      </label>
      <Field
        label="Foto pública para a página do carrinho (opcional)"
        value={draft.image_url}
        onChange={set("image_url")}
        maxLength={500}
        placeholder="https://…"
        help="A página do carrinho é pública e só mostra fotos com endereço HTTPS (por exemplo, a do seu site ou do catálogo)."
      />
      <Field
        label="Código no catálogo da Meta (retailer_id, opcional)"
        value={draft.retailer_id}
        onChange={set("retailer_id")}
        maxLength={100}
        help="Igual ao do produto no catálogo do WhatsApp: o carrinho enviado pelo catálogo vira pedido com o preço deste cardápio."
      />
      <fieldset className="form-field-editor">
        <legend>Adicionais</legend>
        {menu.groups.length ? (
          menu.groups.map((group: Row) => (
            <label className="pedido-toggle" key={group.id}>
              <input
                type="checkbox"
                checked={draft.group_ids.includes(group.id)}
                onChange={(event) =>
                  set("group_ids")(
                    toggled(draft.group_ids, group.id, event.target.checked),
                  )
                }
              />{" "}
              {group.name}{" "}
              <small className="muted">
                (
                {group.min
                  ? `escolha de ${group.min} a ${group.max}`
                  : `até ${group.max}`}
                )
              </small>
            </label>
          ))
        ) : (
          <p className="muted">
            Nenhum grupo de adicionais. Crie em Adicionais (ponto da carne,
            sabores, tamanho…).
          </p>
        )}
      </fieldset>
      <label className="pedido-toggle">
        <Switch
          label="Disponível"
          checked={draft.available}
          onChange={set("available")}
        />{" "}
        {draft.available ? "Disponível" : "Esgotado: aparece sem poder pedir"}
      </label>
    </FormDialog>
  );
}

function CategoryDialog({
  initial,
  onClose,
  onSaved,
}: {
  initial: Row;
  onClose: () => void;
  onSaved: () => void;
}) {
  const write = usePedidoWrite();
  const [name, setName] = useState(initial.name || "");
  const [description, setDescription] = useState(initial.description || "");
  return (
    <FormDialog
      title={initial.id ? "Editar categoria" : "Nova categoria"}
      size="sm"
      onClose={onClose}
      onSubmit={async () => {
        if (initial.id)
          await write(`/categories/${initial.id}`, "PUT", {
            name,
            description,
          });
        else await write("/categories", "POST", { name, description });
        onSaved();
      }}
    >
      <Field
        label="Nome"
        value={name}
        onChange={setName}
        maxLength={60}
        required
        placeholder="Ex.: Lanches, Bebidas, Sobremesas"
      />
      <Field
        label="Descrição (opcional)"
        value={description}
        onChange={setDescription}
        maxLength={300}
      />
    </FormDialog>
  );
}

function MenuEditor({ menu, reload }: { menu: Row; reload: () => void }) {
  const app = useApp();
  const write = usePedidoWrite();
  const { busy, run } = useAction();
  const [item, setItem] = useState<Row | null>(null);
  const [category, setCategory] = useState<Row | null>(null);
  const [removing, setRemoving] = useState<Row | null>(null);
  const move = (list: Row[], index: number, delta: number, path: string) => {
    const other = list[index + delta];
    if (!other) return;
    void run(async () => {
      await write(`${path}/${list[index].id}`, "PUT", {
        position: index + delta,
      });
      await write(`${path}/${other.id}`, "PUT", { position: index });
      reload();
    });
  };
  return (
    <>
      <div className="toolbar">
        <Button icon={<Plus size={16} />} onClick={() => setCategory({})}>
          Nova categoria
        </Button>
        <Button
          secondary
          icon={<Plus size={16} />}
          disabled={!menu.categories.length}
          onClick={() => setItem({})}
        >
          Novo item
        </Button>
      </div>
      {!menu.categories.length && (
        <Empty
          icon={<FileText size={28} />}
          title="Cardápio vazio"
          description="Comece por uma categoria (Lanches, Bebidas…) e cadastre os itens com preço e adicionais."
        />
      )}
      {menu.categories.map((cat: Row, catIndex: number) => (
        <Card
          key={cat.id}
          title={cat.name}
          description={cat.description || undefined}
          actions={
            <>
              <Button
                secondary
                size="sm"
                aria-label={`Subir ${cat.name}`}
                disabled={busy || catIndex === 0}
                onClick={() =>
                  move(menu.categories, catIndex, -1, "/categories")
                }
              >
                <ArrowUp size={16} />
              </Button>
              <Button
                secondary
                size="sm"
                aria-label={`Descer ${cat.name}`}
                disabled={busy || catIndex === menu.categories.length - 1}
                onClick={() =>
                  move(menu.categories, catIndex, 1, "/categories")
                }
              >
                <ArrowDown size={16} />
              </Button>
              <Button
                secondary
                size="sm"
                icon={<Pencil size={16} />}
                onClick={() => setCategory(cat)}
              >
                Editar
              </Button>
              <Button
                secondary
                size="sm"
                icon={<Plus size={16} />}
                onClick={() => setItem({ category_id: cat.id })}
              >
                Item
              </Button>
            </>
          }
        >
          <div className="pedido-menu-items">
            {cat.items.map((it: Row, index: number) => (
              <div className="pedido-menu-item" key={it.id}>
                {it.photo_media_id ? (
                  <img
                    src={mediaUrl(app, it.photo_media_id)}
                    alt=""
                    loading="lazy"
                  />
                ) : it.image_url ? (
                  <img src={it.image_url} alt="" loading="lazy" />
                ) : (
                  <span className="no-photo" aria-hidden />
                )}
                <div className="info">
                  <strong>{it.name}</strong>{" "}
                  {!it.available && <Pill tone="danger">Esgotado</Pill>}
                  {it.retailer_id && (
                    <Pill tone="muted">Meta: {it.retailer_id}</Pill>
                  )}
                  {it.description && <small>{it.description}</small>}
                  {it.group_ids.length > 0 && (
                    <small>
                      Adicionais:{" "}
                      {it.group_ids
                        .map(
                          (id: string) =>
                            menu.groups.find((g: Row) => g.id === id)?.name,
                        )
                        .filter(Boolean)
                        .join(", ")}
                    </small>
                  )}
                </div>
                <span className="price">{money(it.price_cents)}</span>
                <Switch
                  label={
                    it.available
                      ? `Marcar ${it.name} como esgotado`
                      : `Marcar ${it.name} como disponível`
                  }
                  checked={it.available}
                  disabled={busy}
                  onChange={(available) =>
                    void run(
                      async () => {
                        await write(`/items/${it.id}/availability`, "POST", {
                          available,
                        });
                        reload();
                      },
                      {
                        success: available
                          ? `${it.name} disponível.`
                          : `${it.name} esgotado.`,
                      },
                    )
                  }
                />
                <Button
                  secondary
                  size="sm"
                  aria-label={`Subir ${it.name}`}
                  disabled={busy || index === 0}
                  onClick={() => move(cat.items, index, -1, "/items")}
                >
                  <ArrowUp size={16} />
                </Button>
                <Button
                  secondary
                  size="sm"
                  aria-label={`Editar ${it.name}`}
                  onClick={() => setItem(it)}
                >
                  <Pencil size={16} />
                </Button>
                <Button
                  secondary
                  size="sm"
                  aria-label={`Excluir ${it.name}`}
                  onClick={() => setRemoving({ ...it, kind: "items" })}
                >
                  <Trash2 size={16} />
                </Button>
              </div>
            ))}
            {!cat.items.length && (
              <p className="muted">
                Nenhum item.{" "}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setRemoving({ ...cat, kind: "categories" })}
                >
                  Excluir categoria
                </Button>
              </p>
            )}
          </div>
        </Card>
      ))}
      {item && (
        <ItemDialog
          initial={item}
          menu={menu}
          onClose={() => setItem(null)}
          onSaved={() => {
            setItem(null);
            reload();
          }}
        />
      )}
      {category && (
        <CategoryDialog
          initial={category}
          onClose={() => setCategory(null)}
          onSaved={() => {
            setCategory(null);
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
                await write(`/${removing.kind}/${removing.id}`, "DELETE");
                setRemoving(null);
                reload();
              },
              { success: "Excluído." },
            )
          }
        >
          Os pedidos já feitos guardam uma cópia do item e não mudam.
        </Confirm>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Grupos de adicionais

type OptionDraft = {
  id?: string;
  name: string;
  price: string;
  available: boolean;
};

function GroupDialog({
  initial,
  onClose,
  onSaved,
}: {
  initial: Row;
  onClose: () => void;
  onSaved: () => void;
}) {
  const write = usePedidoWrite();
  const [name, setName] = useState(initial.name || "");
  const [min, setMin] = useState(String(initial.min ?? 0));
  const [max, setMax] = useState(String(initial.max ?? 1));
  const [options, setOptions] = useState<OptionDraft[]>(() =>
    (initial.options || [{ name: "", price_cents: 0, available: true }]).map(
      (o: Row) => ({
        id: o.id,
        name: o.name,
        price: o.price_cents ? centsInput(o.price_cents) : "",
        available: o.available !== false,
      }),
    ),
  );
  const setOption = (index: number, patch: Partial<OptionDraft>) =>
    setOptions(options.map((o, i) => (i === index ? { ...o, ...patch } : o)));
  return (
    <FormDialog
      title={initial.id ? `Editar ${initial.name}` : "Novo grupo de adicionais"}
      subtitle="Mínimo 1 e máximo 1 vira escolha única (ponto da carne, tamanho). Mínimo 0 deixa opcional."
      size="lg"
      onClose={onClose}
      onSubmit={async () => {
        const body = {
          name,
          min: Number(min),
          max: Number(max),
          options: options.map((o, index) => {
            const price = o.price ? cents(o.price) : 0;
            if (price === null)
              throw new Error(`Preço da opção ${index + 1} inválido.`);
            return {
              ...(o.id ? { id: o.id } : {}),
              name: o.name,
              price_cents: price,
              available: o.available,
            };
          }),
        };
        if (initial.id) await write(`/groups/${initial.id}`, "PUT", body);
        else await write("/groups", "POST", body);
        toast("Grupo salvo.");
        onSaved();
      }}
    >
      <div className="form-field-grid">
        <Field
          label="Nome"
          value={name}
          onChange={setName}
          maxLength={60}
          required
          placeholder="Ex.: Adicionais, Ponto da carne, Sabores"
        />
        <Field
          label="Mínimo de escolhas"
          type="number"
          min={0}
          max={30}
          value={min}
          onChange={setMin}
          required
        />
        <Field
          label="Máximo de escolhas"
          type="number"
          min={1}
          max={30}
          value={max}
          onChange={setMax}
          required
        />
      </div>
      {options.map((option, index) => (
        <fieldset className="form-field-editor" key={index}>
          <legend>Opção {index + 1}</legend>
          <div className="form-field-grid">
            <Field
              label="Nome"
              value={option.name}
              onChange={(value) => setOption(index, { name: value })}
              maxLength={60}
              required
            />
            <Field
              label="Preço adicional (R$)"
              value={option.price}
              onChange={(value) => setOption(index, { price: value })}
              placeholder="0,00"
            />
          </div>
          <div className="form-field-actions">
            <label className="pedido-toggle">
              <Switch
                label="Disponível"
                checked={option.available}
                onChange={(value) => setOption(index, { available: value })}
              />{" "}
              {option.available ? "Disponível" : "Esgotado"}
            </label>
            <span className="spacer" />
            {options.length > 1 && (
              <button
                type="button"
                className="icon-button sm"
                aria-label={`Remover opção ${index + 1}`}
                onClick={() =>
                  setOptions(options.filter((_, i) => i !== index))
                }
              >
                <Trash2 size={16} />
              </button>
            )}
          </div>
        </fieldset>
      ))}
      {options.length < 30 && (
        <Button
          secondary
          icon={<Plus size={16} />}
          onClick={() =>
            setOptions([...options, { name: "", price: "", available: true }])
          }
        >
          Adicionar opção
        </Button>
      )}
    </FormDialog>
  );
}

function GroupsEditor({ menu, reload }: { menu: Row; reload: () => void }) {
  const write = usePedidoWrite();
  const { busy, run } = useAction();
  const [editing, setEditing] = useState<Row | null>(null);
  const [removing, setRemoving] = useState<Row | null>(null);
  return (
    <>
      <div className="toolbar">
        <Button icon={<Plus size={16} />} onClick={() => setEditing({})}>
          Novo grupo
        </Button>
      </div>
      {!menu.groups.length && (
        <Empty
          icon={<Plus size={28} />}
          title="Nenhum grupo de adicionais"
          description="Grupos como Ponto da carne (escolha 1), Adicionais (até 3) ou Sabores servem para vários itens."
        />
      )}
      {menu.groups.map((group: Row) => {
        const used = menu.categories
          .flatMap((c: Row) => c.items)
          .filter((it: Row) => it.group_ids.includes(group.id));
        return (
          <Card
            key={group.id}
            title={group.name}
            description={`${group.min ? `Escolha de ${group.min} a ${group.max}` : `Até ${group.max}`} · ${used.length ? `em ${used.map((it: Row) => it.name).join(", ")}` : "em nenhum item"}`}
            actions={
              <>
                <Button
                  secondary
                  size="sm"
                  icon={<Pencil size={16} />}
                  onClick={() => setEditing(group)}
                >
                  Editar
                </Button>
                <Button
                  secondary
                  size="sm"
                  aria-label={`Excluir ${group.name}`}
                  onClick={() => setRemoving(group)}
                >
                  <Trash2 size={16} />
                </Button>
              </>
            }
          >
            <div className="pedido-menu-items">
              {group.options.map((option: Row) => (
                <div className="pedido-menu-item" key={option.id}>
                  <div className="info">
                    {option.name}{" "}
                    {!option.available && <Pill tone="danger">Esgotado</Pill>}
                  </div>
                  <span className="price">
                    {option.price_cents
                      ? `+ ${money(option.price_cents)}`
                      : "sem custo"}
                  </span>
                  <Switch
                    label={`${option.name} disponível`}
                    checked={option.available}
                    disabled={busy}
                    onChange={(available) =>
                      void run(async () => {
                        await write(
                          `/groups/${group.id}/availability`,
                          "POST",
                          {
                            option_id: option.id,
                            available,
                          },
                        );
                        reload();
                      })
                    }
                  />
                </div>
              ))}
            </div>
          </Card>
        );
      })}
      {editing && (
        <GroupDialog
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
                await write(`/groups/${removing.id}`, "DELETE");
                setRemoving(null);
                reload();
              },
              { success: "Grupo excluído." },
            )
          }
        >
          O grupo sai dos itens que o usam. Os pedidos já feitos não mudam.
        </Confirm>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Imagens do cardápio (WhatsApp)

function ImagesEditor({ menu, reload }: { menu: Row; reload: () => void }) {
  const app = useApp();
  const write = usePedidoWrite();
  const { busy, run } = useAction();
  const file = useRef<HTMLInputElement>(null);
  const [images, setImages] = useState<Row[]>(menu.images);
  const dirty = JSON.stringify(images) !== JSON.stringify(menu.images);
  const save = (next: Row[]) =>
    run(
      async () => {
        await write("/menu-images", "PUT", {
          images: next.map((image) => ({
            media_id: image.media_id,
            caption: image.caption || "",
          })),
        });
        reload();
      },
      { success: "Imagens do cardápio salvas." },
    );
  return (
    <Card
      title="Imagens do cardápio"
      description="Enviadas no WhatsApp quando o cliente toca em Cardápio, antes do botão Fazer pedido. Imagens JPG ou PNG, ou um PDF; até 10."
      actions={
        <>
          <input
            type="file"
            accept="image/jpeg,image/png,application/pdf"
            ref={file}
            hidden
            onChange={() => {
              const chosen = file.current?.files?.[0];
              if (!chosen) return;
              void run(async () => {
                const id = await upload(app, chosen);
                setImages([
                  ...images,
                  {
                    media_id: id,
                    caption: "",
                    name: chosen.name,
                    type: chosen.type,
                  },
                ]);
                if (file.current) file.current.value = "";
              });
            }}
          />
          <Button
            secondary
            size="sm"
            icon={<ImagePlus size={16} />}
            disabled={busy || images.length >= 10}
            onClick={() => file.current?.click()}
          >
            Adicionar
          </Button>
          <Button
            size="sm"
            icon={<Check size={16} />}
            disabled={!dirty}
            busy={busy}
            onClick={() => void save(images)}
          >
            Salvar
          </Button>
        </>
      }
    >
      {images.length ? (
        <div className="pedido-images">
          {images.map((image, index) => (
            <figure key={image.media_id}>
              {String(image.type).startsWith("image/") ? (
                <img
                  src={mediaUrl(app, image.media_id)}
                  alt={image.caption || ""}
                />
              ) : (
                <span className="doc">
                  <FileText size={32} /> PDF
                </span>
              )}
              <Field
                label="Legenda"
                value={image.caption}
                maxLength={300}
                onChange={(caption) =>
                  setImages(
                    images.map((im, i) =>
                      i === index ? { ...im, caption } : im,
                    ),
                  )
                }
              />
              <div className="card-actions">
                <Button
                  secondary
                  size="sm"
                  aria-label="Mover para a esquerda"
                  disabled={index === 0}
                  onClick={() => {
                    const next = [...images];
                    [next[index - 1], next[index]] = [
                      next[index],
                      next[index - 1],
                    ];
                    setImages(next);
                  }}
                >
                  <ArrowUp size={16} />
                </Button>
                <Button
                  secondary
                  size="sm"
                  aria-label="Remover imagem"
                  onClick={() =>
                    setImages(images.filter((_, i) => i !== index))
                  }
                >
                  <Trash2 size={16} />
                </Button>
              </div>
            </figure>
          ))}
        </div>
      ) : (
        <p className="muted">
          Nenhuma imagem: o cliente recebe só o botão Fazer pedido.
        </p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Regras da loja

function StoreRules() {
  const app = useApp();
  const { busy, run } = useAction();
  const saved = merged(app.settings.pedido);
  const [draft, setDraft] = useState<Row>(() => ({
    ...saved,
    fee: centsInput(saved.delivery_fee_cents),
    minimum: saved.minimum_cents ? centsInput(saved.minimum_cents) : "",
  }));
  const base = {
    ...saved,
    fee: centsInput(saved.delivery_fee_cents),
    minimum: saved.minimum_cents ? centsInput(saved.minimum_cents) : "",
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  useUnsavedGuard(dirty);
  const set = (key: string) => (value: any) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const setIn = (group: string, key: string) => (value: any) =>
    setDraft((current) => ({
      ...current,
      [group]: { ...current[group], [key]: value },
    }));
  const hours: Row[] = draft.hours;
  const menus: Row[] = app.settings.menus || [];
  const inMenu = (type: string) => menus.some((item) => item.type === type);
  return (
    <>
      <Card
        title="Menu do WhatsApp"
        description="Itens que o módulo oferece. Depois de adicionar, ajuste a posição e as linhas em Menus e ações."
      >
        <div className="cards-grid">
          {menuTypes.map((entry) => (
            <section className="card" key={entry.type}>
              <div className="section-heading">
                <h3>{entry.label}</h3>
                <Pill tone={inMenu(entry.type) ? "ok" : "muted"}>
                  {inMenu(entry.type) ? "No menu" : "Fora do menu"}
                </Pill>
              </div>
              {!inMenu(entry.type) && (
                <Button
                  secondary
                  icon={<Plus size={16} />}
                  disabled={busy}
                  onClick={() =>
                    void run(
                      async () => {
                        const latest = await app.api(app.root + "/menus");
                        if (
                          (latest.data || []).some(
                            (item: Row) => item.type === entry.type,
                          )
                        )
                          return;
                        await app.api(app.root + "/settings", "PUT", {
                          menus: [
                            ...(latest.data || []),
                            {
                              id:
                                entry.type.replace("_", "-") +
                                "-" +
                                crypto.randomUUID().slice(0, 6),
                              label: entry.label,
                              type: entry.type,
                              enabled: true,
                            },
                          ],
                          menus_revision: latest.revision,
                        });
                        await app.refresh();
                      },
                      { success: "Item adicionado ao menu." },
                    )
                  }
                >
                  Adicionar ao menu
                </Button>
              )}
            </section>
          ))}
        </div>
      </Card>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(
            async () => {
              const fee = cents(draft.fee || "0"),
                minimum = cents(draft.minimum || "0");
              if (fee === null || minimum === null)
                throw new Error(
                  "Confira a taxa de entrega e o pedido mínimo (ex.: 7,00).",
                );
              const texts: Row = {};
              for (const [key] of textFields)
                texts[key] = draft.texts[key] || "";
              await app.api(app.root + "/settings", "PUT", {
                pedido: {
                  store_name: draft.store_name,
                  hours: hours.map((h) => ({
                    weekday: Number(h.weekday),
                    start: h.start,
                    end: h.end,
                  })),
                  pickup: draft.pickup,
                  delivery: draft.delivery,
                  delivery_fee_cents: fee,
                  minimum_cents: minimum,
                  pickup_minutes: Number(draft.pickup_minutes) || 0,
                  delivery_minutes: Number(draft.delivery_minutes) || 0,
                  pickup_address: draft.pickup_address,
                  payments: draft.payments,
                  pay_before_prepare: draft.pay_before_prepare,
                  payment_minutes: Number(draft.payment_minutes),
                  cart_minutes: Number(draft.cart_minutes),
                  alerts: Object.fromEntries(
                    alertFields.map(([key]) => [
                      key,
                      Number(draft.alerts[key]) || 0,
                    ]),
                  ),
                  texts,
                },
              });
              await app.refresh();
            },
            { success: "Regras da loja salvas." },
          );
        }}
      >
        <Card title="Loja">
          <Field
            label="Nome mostrado ao cliente"
            value={draft.store_name}
            onChange={set("store_name")}
            maxLength={80}
            help="Em branco, usa o nome do estabelecimento (Gestão → Estabelecimento)."
          />
          <h3>Horário de funcionamento (Brasília)</h3>
          <div className="pedido-hours">
            {hours.map((h, index) => (
              <div className="pedido-hours-row" key={index}>
                <Field
                  label="Dia"
                  value={String(h.weekday)}
                  emptyOption={null}
                  options={weekdays.map((name, day) => ({
                    id: String(day),
                    name,
                  }))}
                  onChange={(value) =>
                    set("hours")(
                      hours.map((x, i) =>
                        i === index ? { ...x, weekday: Number(value) } : x,
                      ),
                    )
                  }
                />
                <Field
                  label="Abre"
                  type="time"
                  value={h.start}
                  onChange={(value) =>
                    set("hours")(
                      hours.map((x, i) =>
                        i === index ? { ...x, start: value } : x,
                      ),
                    )
                  }
                />
                <Field
                  label="Fecha"
                  type="time"
                  value={h.end}
                  onChange={(value) =>
                    set("hours")(
                      hours.map((x, i) =>
                        i === index ? { ...x, end: value } : x,
                      ),
                    )
                  }
                />
                <button
                  type="button"
                  className="icon-button sm"
                  aria-label="Remover faixa"
                  onClick={() =>
                    set("hours")(hours.filter((_, i) => i !== index))
                  }
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>
          <div className="card-actions">
            <Button
              secondary
              size="sm"
              icon={<Plus size={16} />}
              disabled={hours.length >= 21}
              onClick={() =>
                set("hours")([
                  ...hours,
                  { weekday: 1, start: "18:00", end: "23:00" },
                ])
              }
            >
              Adicionar faixa
            </Button>
            <Button
              secondary
              size="sm"
              disabled={hours.length + 7 > 21}
              onClick={() =>
                set("hours")([
                  ...hours,
                  ...[0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
                    weekday,
                    start: "18:00",
                    end: "23:00",
                  })),
                ])
              }
            >
              Todos os dias
            </Button>
          </div>
          <small className="muted">
            Sem faixas, a loja fica aberta sempre que não estiver pausada. Fim
            antes do início passa da meia-noite (18:00 às 02:00).
          </small>
        </Card>
        <Card title="Retirada e entrega">
          <label className="pedido-toggle">
            <Switch
              label="Retirada no local"
              checked={draft.pickup}
              onChange={set("pickup")}
            />{" "}
            Retirada no local
          </label>
          <label className="pedido-toggle">
            <Switch
              label="Entrega"
              checked={draft.delivery}
              onChange={set("delivery")}
            />{" "}
            Entrega
          </label>
          <div className="form-field-grid">
            <Field
              label="Taxa de entrega (R$)"
              value={draft.fee}
              onChange={set("fee")}
              placeholder="0,00"
            />
            <Field
              label="Pedido mínimo (R$)"
              value={draft.minimum}
              onChange={set("minimum")}
              placeholder="sem mínimo"
              help="Sobre o subtotal, sem a entrega."
            />
            <Field
              label="Tempo da retirada (min)"
              type="number"
              min={0}
              max={1440}
              value={draft.pickup_minutes}
              onChange={set("pickup_minutes")}
            />
            <Field
              label="Tempo da entrega (min)"
              type="number"
              min={0}
              max={1440}
              value={draft.delivery_minutes}
              onChange={set("delivery_minutes")}
            />
          </div>
          <Field
            label="Endereço de retirada"
            value={draft.pickup_address}
            onChange={set("pickup_address")}
            maxLength={200}
            help="Em branco, usa o endereço do estabelecimento."
          />
        </Card>
        <Card
          title="Pagamento"
          description="Pix e cartão pelo link saem pela Cobrança (Gestão → Cobrança) e são confirmados pelo Mercado Pago; dinheiro e maquininha são pagos na entrega ou na retirada."
        >
          {(["pix", "link", "cash", "card"] as const).map((method) => (
            <label className="pedido-toggle" key={method}>
              <input
                type="checkbox"
                checked={!!draft.payments[method]}
                onChange={(event) =>
                  setIn("payments", method)(event.target.checked)
                }
              />{" "}
              {paymentLabels[method]}
            </label>
          ))}
          <label className="pedido-toggle">
            <Switch
              label="Preparo só depois de pago"
              checked={draft.pay_before_prepare}
              onChange={set("pay_before_prepare")}
            />{" "}
            Pedido pago online só vai para o preparo depois de confirmado
          </label>
          <div className="form-field-grid">
            <Field
              label="Prazo para pagar (min)"
              type="number"
              min={30}
              max={1440}
              value={draft.payment_minutes}
              onChange={set("payment_minutes")}
              help="Validade do Pix e do link, e prazo para escolher como pagar."
            />
            <Field
              label="Validade do link do carrinho (min)"
              type="number"
              min={15}
              max={1440}
              value={draft.cart_minutes}
              onChange={set("cart_minutes")}
            />
          </div>
        </Card>
        <Card
          title="Alertas de pedido parado"
          description="Minutos no mesmo estado até destacar no quadro e avisar a equipe (evento pedido.stale). 0 desliga."
        >
          <div className="form-field-grid">
            {alertFields.map(([key, label]) => (
              <Field
                key={key}
                label={label}
                type="number"
                min={0}
                max={1440}
                value={draft.alerts[key]}
                onChange={setIn("alerts", key)}
              />
            ))}
          </div>
        </Card>
        <Card
          title="Mensagens ao cliente"
          description="Em branco, a mensagem não é enviada. Marcadores: {numero}, {total}, {previsao}, {endereco}, {motivo}, {loja}, {cliente}, {estado}; na loja fechada, {abre} e {horario}. Fora da janela de 24 horas, saem pelo modelo de notificação."
        >
          {textFields.map(([key, label]) => (
            <Field
              key={key}
              label={label}
              type="textarea"
              rows={2}
              value={draft.texts[key] || ""}
              onChange={setIn("texts", key)}
              maxLength={900}
            />
          ))}
        </Card>
        <div className="toolbar">
          <span />
          <Button
            type="submit"
            busy={busy}
            disabled={!dirty}
            icon={<Check size={17} />}
          >
            Salvar regras
          </Button>
        </div>
      </form>
    </>
  );
}

// ---------------------------------------------------------------------------

export function MenuPage() {
  const app = useApp();
  const integration = useIntegrationHost();
  const [catalogRecord, setCatalogRecord] = useState("");
  const [tab, setTab] = useState<"menu" | "groups" | "images" | "store">(
    "menu",
  );
  const resource = useResource(`${app.root}/pedido/menu`);
  const menu: Row | null = resource.data;
  const reload = () => void resource.reload();
  return (
    <>
      {menu && integration && integrationAccess(integration.context).products && integrationAccess(integration.context).write("pedido") && <section className="card"><h3>Catálogo ERP opcional</h3>
        <Field label="Item ou opção de adicional" value={catalogRecord} onChange={setCatalogRecord} options={[
          ...(menu.categories || []).flatMap((category: Row) => category.items || []).map((item: Row) => ({ id: `item:${item.id}`, name: item.name })),
          ...(menu.groups || []).flatMap((group: Row) => group.options.map((option: Row) => ({ id: `option:${group.id}:${option.id}`, name: `${group.name} · ${option.name}` }))),
        ]} />
        {catalogRecord && (() => { const [kind, id, component = 'main'] = catalogRecord.split(':'); const record = kind === 'item' ? menu.categories?.flatMap((category: Row) => category.items || []).find((item: Row) => item.id === id) : menu.groups?.find((group: Row) => group.id === id)?.options.find((option: Row) => option.id === component);
          return <CatalogLinkPicker key={catalogRecord} module="pedido" recordKind={kind} recordId={id} component={component} value={record?.catalog_link} onChange={reload} />; })()}
      </section>}
      <div className="toolbar">
        <Segmented
          label="Cardápio e loja"
          value={tab}
          onChange={setTab}
          options={[
            { value: "menu", label: "Cardápio" },
            { value: "groups", label: "Adicionais" },
            { value: "images", label: "Imagens" },
            { value: "store", label: "Loja e mensagens" },
          ]}
        />
      </div>
      {tab === "store" ? (
        <StoreRules />
      ) : !menu ? (
        resource.error ? (
          <Notice tone="error" onRetry={reload}>
            {resource.error}
          </Notice>
        ) : (
          <SkeletonRows rows={4} avatar={false} />
        )
      ) : tab === "menu" ? (
        <MenuEditor menu={menu} reload={reload} />
      ) : tab === "groups" ? (
        <GroupsEditor menu={menu} reload={reload} />
      ) : (
        <ImagesEditor
          key={JSON.stringify(menu.images)}
          menu={menu}
          reload={reload}
        />
      )}
    </>
  );
}
