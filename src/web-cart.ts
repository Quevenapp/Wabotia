// Passo web do tipo carrinho (docs/MODULOS.md, "Página de carrinho"). O
// módulo entrega o catálogo (categorias, itens, adicionais, retirada/entrega)
// ao abrir o passo; ele fica guardado no passo. O cliente monta o pedido numa
// página leve, sem script: carrinho → revisão → confirmar. O servidor
// recalcula tudo a partir do catálogo guardado; nenhum preço, subtotal ou
// total vem da página.
import { requireValue } from "./types";
import { escape, page } from "./web-steps";

export interface CartOption {
  id: string;
  name: string;
  price_cents: number;
  available: boolean;
}
export interface CartOptionGroup {
  id: string;
  name: string;
  /** Mínimo e máximo de escolhas quando o item é pedido. */
  min: number;
  max: number;
  options: CartOption[];
}
export interface CartItem {
  id: string;
  name: string;
  description?: string;
  price_cents: number;
  /** Foto (HTTPS). */
  image_url?: string;
  available: boolean;
  /** Quantidade máxima por pedido (1 a 99, padrão 20). */
  max_quantity: number;
  option_groups: CartOptionGroup[];
}
export interface CartCatalog {
  currency: "BRL";
  categories: { id: string; name: string; items: CartItem[] }[];
  fulfillment: {
    pickup: boolean;
    delivery: boolean;
    delivery_fee_cents: number;
    /** Subtotal mínimo para concluir (0 = sem mínimo). */
    minimum_cents: number;
    /** Texto de prazo ("Pronto em 30 min", "Entrega em até 50 min"). */
    eta?: string;
    /** Endereço da retirada, mostrado ao cliente. */
    pickup_address?: string;
  };
  /** Observação geral do pedido (padrão: sim). */
  allow_note: boolean;
}

export interface CartLine {
  item_id: string;
  /**
   * Montagem do item no carrinho (0, 1, 2…). O mesmo item_id pode aparecer
   * em mais de uma linha, cada uma com adicionais e observação próprios.
   */
  slot: number;
  name: string;
  quantity: number;
  /** Preço do item + adicionais, por unidade. */
  unit_cents: number;
  options: {
    group_id: string;
    group: string;
    id: string;
    name: string;
    price_cents: number;
  }[];
  note: string;
  total_cents: number;
}
/** Pedido validado e recalculado, entregue ao módulo em onWebStepCompleted. */
export interface CartOrder {
  type: "cart";
  lines: CartLine[];
  item_count: number;
  subtotal_cents: number;
  delivery_fee_cents: number;
  total_cents: number;
  currency: "BRL";
  fulfillment: "pickup" | "delivery";
  customer_name: string;
  address: {
    street: string;
    district: string;
    complement: string;
    reference: string;
  } | null;
  note: string;
}

const ID = /^[A-Za-z0-9_-]{1,60}$/;
const str = (value: unknown, max: number, what: string, required = true) => {
  if (value === undefined || value === null || value === "") {
    requireValue(!required, `Carrinho: informe ${what}.`);
    return "";
  }
  requireValue(
    typeof value === "string" && Array.from(value.trim()).length <= max,
    `Carrinho: ${what} com até ${max} caracteres.`,
  );
  return (value as string).trim();
};
const cents = (value: unknown, what: string) => {
  requireValue(
    Number.isInteger(value) &&
      (value as number) >= 0 &&
      (value as number) <= 10_000_000,
    `Carrinho: ${what} em centavos (inteiro de 0 a 10.000.000).`,
  );
  return value as number;
};
const id = (value: unknown, what: string, seen: Set<string>) => {
  requireValue(
    typeof value === "string" && ID.test(value) && !seen.has(value),
    `Carrinho: identificador de ${what} inválido ou repetido (letras, números, - e _).`,
  );
  seen.add(value as string);
  return value as string;
};

/** Validação estrita do catálogo entregue pelo módulo ao abrir o passo. */
export function validateCatalog(value: any): CartCatalog {
  requireValue(
    value && typeof value === "object",
    "Carrinho: catálogo inválido.",
  );
  requireValue(
    Array.isArray(value.categories) &&
      value.categories.length >= 1 &&
      value.categories.length <= 30,
    "Carrinho: informe de 1 a 30 categorias.",
  );
  const categoryIds = new Set<string>(),
    itemIds = new Set<string>();
  let total = 0;
  const categories = value.categories.map((raw: any) => {
    requireValue(
      Array.isArray(raw?.items) &&
        raw.items.length >= 1 &&
        raw.items.length <= 100,
      "Carrinho: cada categoria precisa de 1 a 100 itens.",
    );
    total += raw.items.length;
    return {
      id: id(raw.id, "categoria", categoryIds),
      name: str(raw.name, 60, "o nome da categoria"),
      items: raw.items.map((item: any): CartItem => {
        const groupIds = new Set<string>();
        requireValue(
          item?.option_groups === undefined ||
            (Array.isArray(item.option_groups) &&
              item.option_groups.length <= 10),
          "Carrinho: até 10 grupos de adicionais por item.",
        );
        const out: CartItem = {
          id: id(item?.id, "item", itemIds),
          name: str(item.name, 80, "o nome do item"),
          price_cents: cents(item.price_cents, "o preço do item"),
          available: item.available !== false,
          max_quantity:
            item.max_quantity === undefined
              ? 20
              : (item.max_quantity as number),
          option_groups: (item.option_groups || []).map((group: any) => {
            const optionIds = new Set<string>();
            requireValue(
              Array.isArray(group?.options) &&
                group.options.length >= 1 &&
                group.options.length <= 30,
              "Carrinho: cada grupo de adicionais precisa de 1 a 30 opções.",
            );
            const min = group.min ?? 0,
              max = group.max ?? 1;
            requireValue(
              Number.isInteger(min) &&
                Number.isInteger(max) &&
                min >= 0 &&
                max >= 1 &&
                min <= max &&
                max <= group.options.length,
              `Carrinho: mínimo e máximo do grupo "${group.name}" inválidos.`,
            );
            return {
              id: id(group.id, "grupo", groupIds),
              name: str(group.name, 60, "o nome do grupo"),
              min,
              max,
              options: group.options.map((option: any) => ({
                id: id(option?.id, "opção", optionIds),
                name: str(option.name, 60, "o nome da opção"),
                price_cents: cents(option.price_cents ?? 0, "o preço da opção"),
                available: option.available !== false,
              })),
            };
          }),
        };
        requireValue(
          Number.isInteger(out.max_quantity) &&
            out.max_quantity >= 1 &&
            out.max_quantity <= 99,
          "Carrinho: quantidade máxima de 1 a 99.",
        );
        const description = str(item.description, 300, "a descrição", false);
        if (description) out.description = description;
        if (item.image_url) {
          const url = str(item.image_url, 500, "a foto");
          requireValue(
            /^https:\/\/[^\s"'<>]+$/.test(url),
            "Carrinho: a foto precisa de um endereço HTTPS.",
          );
          out.image_url = url;
        }
        return out;
      }),
    };
  });
  requireValue(total <= 300, "Carrinho: até 300 itens no catálogo.");
  const f = value.fulfillment || {};
  const fulfillment: CartCatalog["fulfillment"] = {
    pickup: f.pickup !== false,
    delivery: f.delivery === true,
    delivery_fee_cents: cents(f.delivery_fee_cents ?? 0, "a taxa de entrega"),
    minimum_cents: cents(f.minimum_cents ?? 0, "o pedido mínimo"),
  };
  requireValue(
    fulfillment.pickup || fulfillment.delivery,
    "Carrinho: ofereça retirada, entrega ou as duas.",
  );
  const eta = str(f.eta, 80, "o prazo", false);
  if (eta) fulfillment.eta = eta;
  const pickup = str(f.pickup_address, 200, "o endereço de retirada", false);
  if (pickup) fulfillment.pickup_address = pickup;
  return {
    currency: "BRL",
    categories,
    fulfillment,
    allow_note: value.allow_note !== false,
  };
}

// ---------------------------------------------------------------------------
// Pedido enviado pela página

/** Campos do formulário HTML, todos como listas (checkbox repete o nome). */
export type CartInput = Record<string, string[]>;
export function cartInput(form: FormData | URLSearchParams): CartInput {
  const input: CartInput = {};
  let count = 0;
  form.forEach((value, key) => {
    if (typeof value !== "string" || ++count > 2000) return;
    (input[key] ||= []).push(value.slice(0, 500));
  });
  return input;
}
const first = (input: CartInput, key: string) => (input[key]?.[0] ?? "").trim();

export const money = (value: number) =>
  (value / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });

/**
 * Valida o pedido contra o catálogo guardado e calcula valores. Erros por
 * item (`item:<id>`) e por campo (`name`, `street`, `cart`…).
 */
export function validateCartOrder(catalog: CartCatalog, input: CartInput) {
  const errors: Record<string, string> = {};
  const lines: CartLine[] = [];
  for (const category of catalog.categories)
    for (const item of category.items) {
      // Cada montagem (slot) do item vira uma linha; a soma das quantidades
      // respeita max_quantity.
      const slots = slotsOf(input, item);
      let itemQuantity = 0;
      for (let slot = 0; slot < slots; slot++) {
        const key = slotKey(item.id, slot);
        const line = validateSlot(item, slot, input, errors);
        if (!line) continue;
        itemQuantity += line.quantity;
        lines.push(line);
        if (itemQuantity > item.max_quantity && !errors[`item:${key}`])
          errors[`item:${key}`] =
            `Até ${item.max_quantity} por pedido, somando as montagens.`;
      }
    }
  return finishOrder(catalog, input, lines, errors);
}

/** Uma montagem do item: quantidade, adicionais e observação próprios. */
function validateSlot(
  item: CartItem,
  slot: number,
  input: CartInput,
  errors: Record<string, string>,
): CartLine | null {
  const key = slotKey(item.id, slot);
  const raw = first(input, `q_${key}`);
  const quantity = raw === "" ? 0 : Number(raw);
  if (!Number.isInteger(quantity) || quantity < 0) {
    errors[`item:${key}`] = "Quantidade inválida.";
    return null;
  }
  if (!quantity) return null;
  if (!item.available) {
    errors[`item:${key}`] = "Item indisponível no momento.";
    return null;
  }
  if (quantity > item.max_quantity) {
    errors[`item:${key}`] = `Até ${item.max_quantity} por pedido.`;
    return null;
  }
  const options: CartLine["options"] = [];
  for (const group of item.option_groups) {
    const chosen = [...new Set(input[`o_${key}_${group.id}`] || [])];
    const picked = chosen.map((value) =>
      group.options.find((o) => o.id === value),
    );
    if (picked.some((o) => !o)) {
      errors[`item:${key}`] = `Opção inválida em ${group.name}.`;
      break;
    }
    if (picked.some((o) => !o!.available)) {
      errors[`item:${key}`] = `Uma opção de ${group.name} está indisponível.`;
      break;
    }
    if (picked.length < group.min || picked.length > group.max) {
      errors[`item:${key}`] =
        group.min === group.max
          ? `Escolha ${group.min} em ${group.name}.`
          : group.min
            ? `Escolha de ${group.min} a ${group.max} em ${group.name}.`
            : `Escolha até ${group.max} em ${group.name}.`;
      break;
    }
    for (const option of picked as CartOption[])
      options.push({
        group_id: group.id,
        group: group.name,
        id: option.id,
        name: option.name,
        price_cents: option.price_cents,
      });
  }
  if (errors[`item:${key}`]) return null;
  const note = first(input, `n_${key}`);
  if (Array.from(note).length > 140) {
    errors[`item:${key}`] = "Observação do item: até 140 caracteres.";
    return null;
  }
  const unit =
    item.price_cents + options.reduce((sum, o) => sum + o.price_cents, 0);
  return {
    item_id: item.id,
    slot,
    name: item.name,
    quantity,
    unit_cents: unit,
    options,
    note,
    total_cents: unit * quantity,
  };
}

/** Máximo de montagens de um mesmo item num pedido. */
export const MAX_CART_SLOTS = 10;

/** Chave de campo da montagem: a primeira mantém os nomes antigos. */
export const slotKey = (itemId: string, slot: number) =>
  slot ? `${itemId}.${slot}` : itemId;

/** Quantas montagens do item o formulário traz (campo escondido slots_<id>). */
export function slotsOf(input: CartInput, item: CartItem) {
  const n = Number(first(input, `slots_${item.id}`));
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_CART_SLOTS) : 1;
}

/** "+ Outra montagem": mais um bloco do item, sem validar o resto. */
export function addCartSlot(
  catalog: CartCatalog,
  input: CartInput,
  itemId: string,
): CartInput {
  const item = catalog.categories
    .flatMap((category) => category.items)
    .find((i) => i.id === itemId && i.available);
  if (!item) return input;
  const slots = slotsOf(input, item);
  const next = {
    ...input,
    [`slots_${item.id}`]: [String(Math.min(slots + 1, MAX_CART_SLOTS))],
  };
  // A montagem nova já começa com 1 unidade, se a anterior estiver vazia ou não.
  if (slots < MAX_CART_SLOTS) next[`q_${slotKey(item.id, slots)}`] = ["1"];
  return next;
}

function finishOrder(
  catalog: CartCatalog,
  input: CartInput,
  lines: CartLine[],
  errors: Record<string, string>,
) {
  if (!lines.length && !Object.keys(errors).length)
    errors.cart = "Escolha ao menos um item.";
  const subtotal = lines.reduce((sum, line) => sum + line.total_cents, 0);
  const f = catalog.fulfillment;
  const fulfillment = first(input, "fulfillment");
  const mode =
    fulfillment === "delivery" && f.delivery
      ? "delivery"
      : fulfillment === "pickup" && f.pickup
        ? "pickup"
        : !f.delivery
          ? "pickup"
          : !f.pickup
            ? "delivery"
            : null;
  if (!mode) errors.fulfillment = "Escolha retirada ou entrega.";
  const customerName = first(input, "name");
  if (!customerName) errors.name = "Informe o seu nome.";
  else if (Array.from(customerName).length > 80)
    errors.name = "Nome: até 80 caracteres.";
  let address: CartOrder["address"] = null;
  if (mode === "delivery") {
    address = {
      street: first(input, "street"),
      district: first(input, "district"),
      complement: first(input, "complement"),
      reference: first(input, "reference"),
    };
    if (!address.street) errors.street = "Informe rua e número.";
    if (!address.district) errors.district = "Informe o bairro.";
    for (const key of [
      "street",
      "district",
      "complement",
      "reference",
    ] as const)
      if (Array.from(address[key]).length > 120)
        errors[key] = "Até 120 caracteres.";
  }
  const note = catalog.allow_note ? first(input, "note") : "";
  if (Array.from(note).length > 300)
    errors.note = "Observação: até 300 caracteres.";
  if (lines.length && subtotal < f.minimum_cents)
    errors.cart = `Pedido mínimo de ${money(f.minimum_cents)} (sem a entrega).`;
  const fee = mode === "delivery" ? f.delivery_fee_cents : 0;
  const order: CartOrder = {
    type: "cart",
    lines,
    item_count: lines.reduce((sum, line) => sum + line.quantity, 0),
    subtotal_cents: subtotal,
    delivery_fee_cents: fee,
    total_cents: subtotal + fee,
    currency: "BRL",
    fulfillment: (mode || "pickup") as CartOrder["fulfillment"],
    customer_name: customerName,
    address,
    note,
  };
  return { ok: !Object.keys(errors).length, order, errors };
}

/** Pedido em texto, para a nota interna, o protocolo e o retorno. */
export function cartSummary(order: CartOrder) {
  const lines = order.lines.map((line) => {
    const options = line.options.length
      ? ` (${line.options.map((o) => o.name).join(", ")})`
      : "";
    const note = line.note ? ` — ${line.note}` : "";
    return `${line.quantity}x ${line.name}${options}${note}: ${money(line.total_cents)}`;
  });
  return [
    ...lines,
    `Subtotal: ${money(order.subtotal_cents)}`,
    ...(order.delivery_fee_cents
      ? [`Entrega: ${money(order.delivery_fee_cents)}`]
      : []),
    `Total: ${money(order.total_cents)}`,
    order.fulfillment === "delivery" && order.address
      ? `Entrega: ${order.address.street}, ${order.address.district}${order.address.complement ? `, ${order.address.complement}` : ""}${order.address.reference ? ` (${order.address.reference})` : ""}`
      : "Retirada no local",
    `Cliente: ${order.customer_name}`,
    ...(order.note ? [`Observação: ${order.note}`] : []),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Páginas

const CART_CSS = `.cat{margin:24px 0 8px;font-size:18px}.item{display:flex;gap:12px;padding:14px 0;border-top:1px solid #e9edef}.item:first-of-type{border-top:0}.item img{width:72px;height:72px;object-fit:cover;border-radius:10px;flex:none}.item .info{flex:1;min-width:0}.item .name{font-weight:600}.item .price{font-weight:600;color:#008069;white-space:nowrap}.item.off{opacity:.55}.qty{display:flex;align-items:center;gap:8px;margin-top:8px}.qty select{font:inherit;padding:8px 10px;border:1px solid #d1d7db;border-radius:10px;background:#fff;color:inherit}.group{margin:10px 0 0;padding:10px 12px;border:1px dashed #d1d7db;border-radius:10px}.group legend{font-size:14px}.group .option{margin-top:6px;padding:8px 10px}.mini{width:100%;font:inherit;font-size:14px;padding:8px 10px;margin-top:8px;border:1px solid #d1d7db;border-radius:10px}.lines{width:100%;border-collapse:collapse;margin:8px 0}.lines td{padding:8px 0;border-top:1px solid #e9edef;vertical-align:top}.lines td:last-child{text-align:right;white-space:nowrap;padding-left:12px}.lines small{margin:2px 0 0}.total td{font-weight:700;border-top:2px solid #d1d7db}.alert{background:#fdecea;color:#c62828;border-radius:10px;padding:10px 12px;margin:12px 0;font-size:14px}.slot{margin-top:12px;padding-top:10px;border-top:1px dashed #d1d7db}.more{display:inline-block;width:auto;margin:10px 0 0;padding:8px 12px;font-size:14px;background:none;color:#008069;border:1px solid #008069;border-radius:10px}.default{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}@media (prefers-color-scheme:dark){.item,.lines td{border-color:#2a3942}.slot{border-color:#3b4a54}.more{color:#25d366;border-color:#25d366}.qty select,.mini{background:#202c33;border-color:#3b4a54}.group{border-color:#3b4a54}.alert{background:#3b1f1f;color:#ff8a80}}`;

const err = (errors: Record<string, string>, key: string) =>
  errors[key] ? `<div class="error">${escape(errors[key])}</div>` : "";

/** Carrinho para montar ou corrigir o pedido (valores vêm do catálogo). */
export function cartPage(
  catalog: CartCatalog,
  meta: { title: string; intro?: string; submit_label?: string },
  appName: string,
  input: CartInput = {},
  errors: Record<string, string> = {},
) {
  const value = (key: string) => first(input, key);
  const selected = (key: string, option: string) =>
    (input[key] || []).includes(option);
  const f = catalog.fulfillment;
  const items = catalog.categories
    .map(
      (category) =>
        `<h2 class="cat">${escape(category.name)}</h2>${category.items
          .map((item) => {
            const slots = item.available ? slotsOf(input, item) : 1;
            const block = (slot: number) => {
              const key = slotKey(item.id, slot);
              const qty = Number(value(`q_${key}`)) || 0;
              const groups = item.option_groups
                .map((group) => {
                  const radio = group.max === 1 && group.min === 1;
                  const rule =
                    group.min === group.max
                      ? `escolha ${group.min}`
                      : group.min
                        ? `escolha de ${group.min} a ${group.max}`
                        : `até ${group.max}`;
                  return `<fieldset class="group"><legend>${escape(group.name)} <small>(${rule}, se pedir este item)</small></legend>${group.options
                    .map((option) => {
                      const name = `o_${key}_${group.id}`;
                      return `<label class="option"><input type="${radio ? "radio" : "checkbox"}" name="${name}" value="${escape(option.id)}"${selected(name, option.id) ? " checked" : ""}${option.available && item.available ? "" : " disabled"}><span>${escape(option.name)}${option.price_cents ? ` <small>+ ${money(option.price_cents)}</small>` : ""}${option.available ? "" : " <small>indisponível</small>"}</span></label>`;
                    })
                    .join("")}</fieldset>`;
                })
                .join("");
              const options = Array.from(
                { length: item.max_quantity + 1 },
                (_, n) =>
                  `<option value="${n}"${n === qty ? " selected" : ""}>${n}</option>`,
              ).join("");
              const label = slots > 1 ? `Montagem ${slot + 1}: ` : "";
              const qtyBox = item.available
                ? `<label style="margin:0"><span class="label" style="display:inline;margin-right:6px">${label}Qtd.</span><select name="q_${escape(key)}" aria-label="${escape(label)}Quantidade de ${escape(item.name)}">${options}</select></label>`
                : "<small>Indisponível</small>";
              const extras = item.available
                ? `${groups}<input class="mini" type="text" name="n_${escape(key)}" maxlength="140" placeholder="Observação (opcional)" value="${escape(value(`n_${key}`))}">`
                : "";
              return slot
                ? `<div class="slot"><div class="qty">${qtyBox}</div>${extras}${err(errors, `item:${key}`)}</div>`
                : `<div class="qty"><span class="price">${money(item.price_cents)}</span>${qtyBox}</div>${extras}${err(errors, `item:${key}`)}`;
            };
            const blocks = Array.from({ length: slots }, (_, n) =>
              block(n),
            ).join("");
            const more =
              item.available && slots < MAX_CART_SLOTS
                ? `<input type="hidden" name="slots_${escape(item.id)}" value="${slots}"><button type="submit" class="more" name="step" value="add:${escape(item.id)}" formaction="#i-${escape(item.id)}">+ Outra montagem deste item</button>`
                : item.available
                  ? `<input type="hidden" name="slots_${escape(item.id)}" value="${slots}">`
                  : "";
            return `<div class="item${item.available ? "" : " off"}" id="i-${escape(item.id)}">${item.image_url ? `<img src="${escape(item.image_url)}" alt="" loading="lazy">` : ""}<div class="info"><div class="name">${escape(item.name)}</div>${item.description ? `<small>${escape(item.description)}</small>` : ""}${blocks}${more}</div></div>`;
          })
          .join("")}`,
    )
    .join("");
  const modes = [
    f.pickup
      ? `<label class="option"><input type="radio" name="fulfillment" value="pickup"${value("fulfillment") === "pickup" || (!f.delivery && !value("fulfillment")) ? " checked" : ""}><span>Retirar no local${f.pickup_address ? `<small>${escape(f.pickup_address)}</small>` : ""}</span></label>`
      : "",
    f.delivery
      ? `<label class="option"><input type="radio" name="fulfillment" value="delivery"${value("fulfillment") === "delivery" || (!f.pickup && !value("fulfillment")) ? " checked" : ""}><span>Entrega${f.delivery_fee_cents ? ` <small>taxa de ${money(f.delivery_fee_cents)}</small>` : " <small>sem taxa</small>"}</span></label>`
      : "",
  ].join("");
  const field = (name: string, label: string, help = "") =>
    `<label${errors[name] ? ' class="invalid"' : ""}><span class="label">${label}</span><input type="text" name="${name}" maxlength="120" value="${escape(value(name))}">${help ? `<small>${help}</small>` : ""}${err(errors, name)}</label>`;
  const body = `<div class="card"><h1>${escape(meta.title)}</h1>${meta.intro ? `<p class="intro">${escape(meta.intro)}</p>` : ""}${f.eta ? `<small>${escape(f.eta)}</small>` : ""}${f.minimum_cents ? `<small>Pedido mínimo: ${money(f.minimum_cents)}</small>` : ""}${
    Object.keys(errors).length
      ? `<div class="alert" role="alert">${escape(errors.cart || "Confira os itens e os campos destacados.")}</div>`
      : ""
  }<form method="post" novalidate><button type="submit" name="step" value="review" class="default" tabindex="-1" aria-hidden="true">Revisar</button>${items}<h2 class="cat">Como você quer receber?</h2><fieldset>${modes}${err(errors, "fulfillment")}</fieldset>${f.delivery ? `${field("street", "Rua e número", "Só para entrega.")}${field("district", "Bairro")}${field("complement", "Complemento (opcional)")}${field("reference", "Ponto de referência (opcional)")}` : ""}<label${errors.name ? ' class="invalid"' : ""}><span class="label">Seu nome</span><input type="text" name="name" maxlength="80" value="${escape(value("name"))}">${err(errors, "name")}</label>${catalog.allow_note ? `<label><span class="label">Observação do pedido (opcional)</span><textarea name="note" maxlength="300">${escape(value("note"))}</textarea>${err(errors, "note")}</label>` : ""}<button type="submit" name="step" value="review">${escape(meta.submit_label || "Revisar pedido")}</button></form></div>`;
  return page(meta.title, body, appName, CART_CSS);
}

/** Revisão: valores recalculados pelo servidor e o botão de confirmar. */
export function cartReviewPage(
  order: CartOrder,
  meta: { title: string },
  appName: string,
  input: CartInput,
) {
  // Os campos voltam escondidos: a confirmação recalcula tudo de novo.
  const hidden = Object.entries(input)
    .filter(([key]) => !["step", "confirm"].includes(key))
    .flatMap(([key, values]) =>
      values.map(
        (v) =>
          `<input type="hidden" name="${escape(key)}" value="${escape(v)}">`,
      ),
    )
    .join("");
  const rows = order.lines
    .map(
      (line) =>
        `<tr><td>${line.quantity}x ${escape(line.name)}${line.options.length ? `<small>${escape(line.options.map((o) => o.name).join(", "))}</small>` : ""}${line.note ? `<small>${escape(line.note)}</small>` : ""}</td><td>${money(line.total_cents)}</td></tr>`,
    )
    .join("");
  const where =
    order.fulfillment === "delivery" && order.address
      ? `Entrega em ${escape(order.address.street)}, ${escape(order.address.district)}${order.address.complement ? `, ${escape(order.address.complement)}` : ""}`
      : "Retirada no local";
  const body = `<div class="card"><h1>Confira seu pedido</h1><table class="lines">${rows}<tr><td>Subtotal</td><td>${money(order.subtotal_cents)}</td></tr>${order.fulfillment === "delivery" ? `<tr><td>Entrega</td><td>${money(order.delivery_fee_cents)}</td></tr>` : ""}<tr class="total"><td>Total</td><td>${money(order.total_cents)}</td></tr></table><p>${where}<br>${escape(order.customer_name)}${order.note ? `<br><small>${escape(order.note)}</small>` : ""}</p><form method="post">${hidden}<button type="submit" name="confirm" value="1">Confirmar pedido</button><button type="submit" name="step" value="edit" class="button secondary">Voltar e alterar</button></form></div>`;
  return page(meta.title, body, appName, CART_CSS);
}
