// Casas decimais da preferência nas telas (web/erp/decimals.ts): valores com
// menos, as mesmas e mais casas que a preferência, na exibição e na entrada,
// na Frente de caixa e no cadastro de produto.
import test from "node:test";
import assert from "node:assert/strict";
import { storedPreferencePage } from "../../packages/erp-domain/src/preferences/catalog.mjs";
import { storedFields } from "../../packages/erp-domain/src/preferences/core.mjs";
import {
  decimalPlaces,
  fitDecimal,
  loadDecimalPlaces,
  placesProblem,
  showDecimal,
  significantPlaces,
} from "./decimals.ts";
import {
  priceInput,
  quantityInput,
  quantityText,
} from "./app/lib/pdv-model.ts";
import {
  checkPrices,
  productFormValues,
  productLists,
} from "./app/lib/product-form-model.ts";

const page = (values = {}) => ({
  scope: "preferences_page",
  data_mode: "erp_native",
  page: "empresa-geral",
  owner: "company",
  role: "vendas",
  can_manage: false,
  // Valor gravado (versão 1); na versão 0 só vale o padrão do catálogo.
  items: storedFields(storedPreferencePage("empresa-geral")).map((field) =>
    Object.hasOwn(values, field.key)
      ? {
          key: field.key,
          value: values[field.key],
          version: 1,
          updated_at: "2026-11-16T12:00:00Z",
        }
      : { key: field.key, value: field.default, version: 0, updated_at: null },
  ),
  directory: null,
});
const TWO = {
  "empresa.decimais_quantidade": 2,
  "empresa.decimais_preco_entrada": 2,
  "empresa.decimais_preco_saida": 2,
};
const places = { quantity: 2, priceIn: 2, priceOut: 2, weight: 3 };

test("lê as casas da página empresa-geral; quantidade fica em no máximo 6", async () => {
  assert.deepEqual(decimalPlaces(page(TWO)), places);
  assert.equal(
    decimalPlaces(page({ "empresa.decimais_quantidade": 9 })).quantity,
    6,
  );
  const controller = {
    preferences: async (path) => (
      assert.equal(path, "/v1/preferencias/empresa-geral"),
      page(TWO)
    ),
  };
  assert.deepEqual(
    await loadDecimalPlaces(controller, new AbortController().signal),
    places,
  );
  // Sem leitura (falha, resposta inválida, sem porta): null, e o servidor confere.
  const signal = new AbortController().signal;
  assert.equal(
    await loadDecimalPlaces(
      {
        preferences: async () => {
          throw new Error("rede");
        },
      },
      signal,
    ),
    null,
  );
  assert.equal(
    await loadDecimalPlaces({ preferences: async () => ({}) }, signal),
    null,
  );
  assert.equal(await loadDecimalPlaces({}, signal), null);
});

test("exibição: menos casas completa, as mesmas ficam, mais casas aparecem inteiras", () => {
  assert.equal(showDecimal("2", 2), "2,00");
  assert.equal(showDecimal("2.000000", 2), "2,00");
  assert.equal(showDecimal("2.5", 2), "2,50");
  assert.equal(showDecimal("2.50", 2), "2,50");
  assert.equal(showDecimal("2.125", 2), "2,125");
  assert.equal(showDecimal("2.1234560000", 2), "2,123456");
  assert.equal(showDecimal("-1.5", 2), "-1,50");
  assert.equal(showDecimal("7", 0), "7");
  assert.equal(fitDecimal("2,5", 3), "2.500");
  // Sem preferência: só tira os zeros à direita.
  assert.equal(showDecimal("2.000000", null), "2");
  assert.equal(showDecimal("abc", 2), "abc");
});

test("entrada: casas significativas contam, zeros à direita não", () => {
  assert.equal(significantPlaces("1,500"), 1);
  assert.equal(significantPlaces("1.25"), 2);
  assert.equal(significantPlaces("3"), 0);
  assert.equal(placesProblem("1.5", 2, "A quantidade"), null);
  assert.equal(placesProblem("1.50", 2, "A quantidade"), null);
  assert.equal(placesProblem("1.500", 2, "A quantidade"), null);
  assert.equal(
    placesProblem("1.505", 2, "A quantidade"),
    "A quantidade aceita até 2 casas decimais (Preferências › Empresa › Geral).",
  );
  assert.equal(
    placesProblem("1.5", 0, "O preço"),
    "O preço aceita até 0 casas decimais (Preferências › Empresa › Geral).",
  );
  assert.equal(placesProblem("1.123456789", null, "O preço"), null);
});

test("Frente de caixa: quantidade e valor unitário seguem a preferência", () => {
  for (const ok of ["1", "1,5", "1,25", "1.250000"])
    assert.ok(quantityInput(ok, 2));
  assert.throws(
    () => quantityInput("1,255", 2),
    /A quantidade aceita até 2 casas decimais/,
  );
  // Sem preferência, o limite do formato (6 casas).
  assert.equal(quantityInput("1,123456"), "1.123456");
  assert.throws(() => quantityInput("1,1234567"), /até seis casas decimais/);
  for (const ok of ["9", "9,9", "9,99", "9.990"]) assert.ok(priceInput(ok, 2));
  assert.throws(
    () => priceInput("9,999", 2),
    /O valor unitário aceita até 2 casas decimais/,
  );
  assert.equal(priceInput("9,1234567891"), "9.1234567891");
  assert.equal(quantityText("2.000000", 2), "2,00");
  assert.equal(quantityText("2", 2), "2,00");
  assert.equal(quantityText("2.125", 2), "2,125");
  assert.equal(quantityText("2.000000"), "2");
});

test("cadastro de produto: preços exibidos com a preferência, sem esconder casas", () => {
  const record = {
    id: "p1",
    entity: "products",
    version: 1,
    active: true,
    name: "Caneta",
    code: "CAN",
    price: "2.0000",
    suppliers: [
      {
        supplier_id: "f1",
        supplier_name: "A",
        purchase_price: "1.5000",
        cost_price: "1.1234567000",
        is_default: true,
      },
    ],
  };
  assert.equal(
    productFormValues(record, undefined, { priceOutPlaces: 2 }).price,
    "2,00",
  );
  assert.equal(
    productFormValues({ ...record, price: "2.1234560000" }, undefined, {
      priceOutPlaces: 2,
    }).price,
    "2,123456",
  );
  assert.equal(productFormValues(record, undefined, {}).price, "2.0000");
  const lists = productLists(record, undefined, 2);
  assert.equal(lists.suppliers[0].purchase_price, "1,50");
  assert.equal(lists.suppliers[0].cost_price, "1,1234567");
  assert.equal(productLists(record).suppliers[0].purchase_price, "1,5");
});

test("cadastro de produto: preço alterado com mais casas que a preferência é recusado antes de enviar", () => {
  const initial = { price: "2,00" };
  const initialLists = {
    suppliers: [
      { supplier_id: "f1", purchase_price: "1,1234", cost_price: "" },
    ],
    dun_codes: [],
    tag_ids: [],
    images: [],
    custom_values: {},
  };
  const field = (fn) => {
    try {
      fn();
      return null;
    } catch (error) {
      return [error.field, error.message];
    }
  };
  // Menos e as mesmas casas: passa.
  for (const price of ["3", "3,5", "3,55", "3,550"])
    assert.equal(
      field(() =>
        checkPrices({ price }, initial, initialLists, initialLists, places),
      ),
      null,
    );
  // Mais casas: recusa no campo, com a mensagem da preferência.
  assert.deepEqual(
    field(() =>
      checkPrices(
        { price: "3,555" },
        initial,
        initialLists,
        initialLists,
        places,
      ),
    ),
    [
      "price",
      "O preço de venda aceita até 2 casas decimais (Preferências › Empresa › Geral).",
    ],
  );
  // Valor já gravado com mais casas, sem alteração: não impede salvar o resto.
  assert.equal(
    field(() =>
      checkPrices(
        { price: "2,00" },
        initial,
        initialLists,
        initialLists,
        places,
      ),
    ),
    null,
  );
  const changed = {
    ...initialLists,
    suppliers: [
      { supplier_id: "f1", purchase_price: "1,1234", cost_price: "0,991" },
    ],
  };
  assert.deepEqual(
    field(() =>
      checkPrices({ price: "2,00" }, initial, changed, initialLists, places),
    ),
    [
      "suppliers",
      "O preço de custo da linha 1 aceita até 2 casas decimais (Preferências › Empresa › Geral).",
    ],
  );
  const fine = {
    ...initialLists,
    suppliers: [
      { supplier_id: "f1", purchase_price: "1,12", cost_price: "0,99" },
    ],
  };
  assert.equal(
    field(() =>
      checkPrices({ price: "2,00" }, initial, fine, initialLists, places),
    ),
    null,
  );
  // Sem preferência: só o formato (o servidor aceita até dez casas no cadastro).
  assert.equal(
    field(() =>
      checkPrices({ price: "3,555" }, initial, changed, initialLists, null),
    ),
    null,
  );
});
