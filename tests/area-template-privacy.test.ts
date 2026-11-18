import { describe, expect, it } from "vitest";
import { escolasTemplate } from "../src/area-templates/models/escolas";
import { professoresTemplate } from "../src/area-templates/models/professores";
import { condominiosTemplate } from "../src/area-templates/models/condominios";
import { construtorasTemplate } from "../src/area-templates/models/construtoras";
import { validateExtra, validateWorkType } from "../src/modules/os/validation";
import { workOrderAdditions } from "../src/modules/os/work-types";

const cases = [
  ...[...escolasTemplate.work_types, ...professoresTemplate.work_types].map((type) => ({
    type, fieldId: "nome_aluno", value: "Ana Silva — sentinela privada",
  })),
  ...[...condominiosTemplate.work_types, construtorasTemplate.work_types.find((type) => type.id === "construtora_pos_obra")!].map((type) => ({
    type, fieldId: "unidade", value: "Residencial Primavera, bloco B, 302 — sentinela privada",
  })),
];

describe("modelos: captura privada de nomes e identificação residencial", () => {
  for (const { type, fieldId, value } of cases) {
    it(`${type.id}: recusa captura comum e omite o valor da projeção comum`, () => {
      expect(validateWorkType(type)).toEqual(type);
      const field = type.fields.find((field) => field.id === fieldId)!;
      expect(field).toMatchObject({ sensitive: true, client_visible: false, required: false });
      const extra = { [fieldId]: value };
      for (const mode of ["staff", "customer"] as const) {
        expect(() => validateExtra([field], extra, { mode })).toThrow();
        expect(validateExtra([field], {}, { mode })).toEqual({});
      }
      expect(validateExtra([field], extra, { mode: "private" })).toEqual(extra);
      const projection = workOrderAdditions({
        number: 1,
        stage: type.initial_stage,
        status: "received",
        extra_json: JSON.stringify(extra),
      }, type);
      expect(projection.fields.some((field) => field.id === fieldId)).toBe(false);
      expect(projection.extra).not.toHaveProperty(fieldId);
      expect(JSON.stringify(projection)).not.toContain(value);
    });
  }
});
