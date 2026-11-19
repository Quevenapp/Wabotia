import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Compila os helpers reais em memória; não instala pacotes, usa rede ou escreve artefatos.
const result = await build({
  stdin: {
    contents: `
      export * from './src/area-templates/catalog';
      export * from './src/area-templates/equivalent-types';
      export * from './src/modules/os/validation';
      export * from './web/modules/os/types/template-models';
      export { prepareTypeSave } from './web/modules/os/types/type-draft';
    `,
    resolveDir: fileURLToPath(new URL("../", import.meta.url)), loader: "ts",
  },
  bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent",
});
const {
  areaTemplates, equivalentWorkTypes, validateExtra, validateWorkType, validateWorkTypeChanges,
  templateSource, missingTemplateFields, addMissingTemplateFields, publicPlateField,
  addPublicPlateField, prepareTypeSave,
} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`);

const standards = ["assistencia_tecnica", "oficina_mecanica"].map((id) => {
  const template = areaTemplates.find((entry) => entry.id === id);
  return { template, type: template.work_types.find((type) => type.id === "at_veiculos") };
});
const addedIds = ["marca_modelo", "ano", "cor", "ultima_manutencao"];
function previousType() {
  const { template, type } = standards[0];
  const previous = structuredClone(type);
  previous.id = `area_${template.id}__${type.id}`;
  previous.fields = previous.fields.filter((field) => !addedIds.includes(field.id));
  const plate = previous.fields.find((field) => field.id === "placa");
  Object.assign(plate, { sensitive: true, client_visible: false, max_length: 240, help: "Escolha manual preservada." });
  previous.labels.plural = "Oficina da equipe";
  return previous;
}

for (const { template, type } of standards) test(`${template.name}: campos públicos, ano/data válidos e limites`, (t) => {
  assert.deepEqual(validateWorkType(type), type);
  assert.equal(type.fields.length, 9);
  const size = Buffer.byteLength(JSON.stringify({ ...type, id: `area_${template.id}__${type.id}` }));
  assert.ok(size <= 12 * 1024);
  t.diagnostic(`${type.fields.length}/24 campos; ${size}/12288 bytes com ID aplicado`);
  const values = { placa: "ABC1D23", marca_modelo: "Marca Modelo", ano: 1900, cor: "Prata", ultima_manutencao: "2024-02-29" };
  assert.deepEqual(validateExtra(type.fields, values, { mode: "customer" }), values);
  assert.deepEqual(validateExtra(type.fields, { ano: 2100 }, { mode: "customer" }), { ano: 2100 });
  assert.deepEqual(validateExtra(type.fields, {}, { mode: "customer" }), {});
  for (const invalid of [{ placa: "A".repeat(11) }, { ano: 1899 }, { ano: 2101 }, { ano: 2020.5 }, { ultima_manutencao: "2026-02-29" }])
    assert.throws(() => validateExtra(type.fields, invalid, { mode: "customer" }));
});

test("Adicionar acrescenta somente IDs ausentes, conserva edições e revisão ao preparar", () => {
  const previous = previousType(), before = structuredClone(previous), standard = standards[0].type;
  assert.equal(templateSource(previous, areaTemplates).template.name, "Assistência técnica");
  assert.deepEqual(missingTemplateFields(previous, standard).map((field) => field.id), addedIds);
  const next = prepareTypeSave(addMissingTemplateFields(previous, standard), previous);
  assert.deepEqual(previous, before);
  assert.deepEqual(next.fields.slice(0, previous.fields.length), previous.fields);
  assert.equal(next.revision, previous.revision + 1);
  assert.equal(next.labels.plural, previous.labels.plural);
  assert.doesNotThrow(() => validateWorkTypeChanges({ os_work_types: [previous] }, { os_work_types: [next] }));
  assert.equal(addMissingTemplateFields(next, standard), next);
});

test("Adicionar não recria campos aposentados nem substitui campo manual com mesmo ID", () => {
  const previous = previousType(), standard = standards[0].type;
  previous.retired_field_ids = ["cor"];
  previous.fields.push({ ...standard.fields.find((field) => field.id === "ano"), label: "Ano informado pela equipe", min: 2000 });
  const next = addMissingTemplateFields(previous, standard);
  assert.deepEqual(missingTemplateFields(previous, standard).map((field) => field.id), ["marca_modelo", "ultima_manutencao"]);
  assert.ok(!next.fields.some((field) => field.id === "cor"));
  assert.equal(next.fields.find((field) => field.id === "ano").min, 2000);
  assert.equal(templateSource({ ...previous, id: "modelo_manual" }, areaTemplates), undefined);
});

test("Placa visível usa novo ID permitido pelo servidor sem desclassificar a antiga", () => {
  const previous = previousType(), oldPlate = structuredClone(previous.fields[0]);
  const next = prepareTypeSave(addPublicPlateField(previous), previous);
  assert.deepEqual(next.fields[0], oldPlate);
  assert.deepEqual(next.fields.at(-1), publicPlateField(previous));
  assert.doesNotThrow(() => validateWorkTypeChanges({ os_work_types: [previous] }, { os_work_types: [next] }));
  assert.throws(() => validateExtra(next.fields, { placa: "PRIVADA" }, { mode: "customer" }));
  assert.deepEqual(validateExtra(next.fields, { placa_visivel: "ABC1D23" }, { mode: "customer" }), { placa_visivel: "ABC1D23" });
  assert.equal(publicPlateField(next), undefined);
  assert.equal(publicPlateField({ ...previous, retired_field_ids: ["placa_visivel"] }), undefined);
  assert.equal(publicPlateField(standards[0].type), undefined);
});

test("Atualizações rejeitam excesso de 24 campos e de 12 KiB sem alterar o original", () => {
  const previous = previousType(), standard = standards[0].type;
  while (previous.fields.length < 24)
    previous.fields.push({ ...standard.fields[0], id: `campo_${previous.fields.length}` });
  const before = structuredClone(previous);
  assert.throws(() => addMissingTemplateFields(previous, standard), /24 campos/);
  assert.throws(() => addPublicPlateField(previous), /24 campos/);
  assert.deepEqual(previous, before);
  const large = previousType();
  large.terms = "á".repeat(6500);
  assert.throws(() => addMissingTemplateFields(large, standard), /12 KiB/);
});

test("Equivalência avisa oficina de outra área, inclusive renomeada, sem apontar reaplicação própria", () => {
  const previous = previousType(), { template, type } = standards[1];
  assert.deepEqual(equivalentWorkTypes(type, [previous], template.id), [previous]);
  assert.deepEqual(equivalentWorkTypes(standards[0].type, [previous], standards[0].template.id), []);
  const manual = { ...type, id: "minha_oficina" };
  assert.deepEqual(equivalentWorkTypes(type, [manual], template.id), [manual]);
  assert.deepEqual(equivalentWorkTypes(type, [{ ...manual, labels: { ...manual.labels, item: "Bicicleta" } }], template.id), []);
});
