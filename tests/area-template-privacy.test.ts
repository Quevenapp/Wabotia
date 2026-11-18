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
];

describe("modelos: nomes de alunos privados e unidade visível ao titular", () => {
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

  for (const type of [...condominiosTemplate.work_types, construtorasTemplate.work_types.find(t => t.id === "construtora_pos_obra")!]) {
    it(`${type.id}: aceita unidade na captura comum e a inclui na projeção`, () => {
      expect(validateWorkType(type)).toEqual(type);
      const field = type.fields.find(f => f.id === "unidade")!;
      expect(field).toMatchObject({ sensitive: false, client_visible: true, required: false });
      const extra = { unidade: "Bloco B, 302" };
      for (const mode of ["staff", "customer"] as const)
        expect(validateExtra([field], extra, { mode })).toEqual(extra);
      const projection = workOrderAdditions({ number: 1, stage: type.initial_stage, status: "received", extra_json: JSON.stringify(extra) }, type);
      expect(projection.fields).toContainEqual(field);
      expect(projection.extra).toEqual(extra);
    });
  }
});
