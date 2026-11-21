// O que o cofre instalado aceita da reforma tributária, lido do contrato que
// ele mesmo serve (GET /v1/openapi.json, no "Testar conexão"): o grupo IBS/CBS
// e o Imposto Seletivo no item da NF-e e as finalidades da nota. O cofre não
// informa a reforma em outro lugar (GET /v1/cofre traz versão, certificado e
// documentos). Sem I/O: os testes passam o contrato direto.

export interface VaultReformCapability {
  /** O item da NF-e aceita o grupo ibsCbs (CST, classificação, base e valores). */
  ibs_cbs: boolean;
  /** O item da NF-e aceita o grupo impostoSeletivo. */
  selective: boolean;
  /** Finalidades aceitas pelo cofre (enum de PedidoNfe.finalidade). */
  purposes: string[];
  /** Nota de crédito e nota de débito (finalidades 5 e 6 da reforma). */
  credit_debit: boolean;
}

type Schema = Record<string, unknown>;
const obj = (v: unknown): Schema => (v && typeof v === "object" && !Array.isArray(v) ? (v as Schema) : {});

/** Resolve $ref locais (#/components/schemas/X) e junta allOf, sem laços. */
function resolve(root: Schema, value: unknown, depth = 0): Schema {
  let schema = obj(value);
  if (depth > 20) return {};
  const ref = schema.$ref;
  if (typeof ref === "string" && ref.startsWith("#/")) {
    let target: unknown = root;
    for (const part of ref.slice(2).split("/")) target = obj(target)[part];
    schema = resolve(root, target, depth + 1);
  }
  if (Array.isArray(schema.allOf)) {
    const merged: Schema = { properties: {} };
    for (const part of schema.allOf) {
      const r = resolve(root, part, depth + 1);
      Object.assign(merged.properties as Schema, obj(r.properties));
    }
    return { ...schema, ...merged, allOf: undefined };
  }
  return schema;
}

const property = (root: Schema, schema: Schema, name: string) => resolve(root, obj(schema.properties)[name]);

/** Capacidade a partir do contrato servido; null quando o contrato não é legível. */
export function vaultReformCapability(openapi: unknown): VaultReformCapability | null {
  const root = obj(openapi);
  const schemas = obj(obj(root.components).schemas);
  if (!schemas.PedidoNfe) return null;
  const order = resolve(root, schemas.PedidoNfe);
  const items = property(root, order, "itens");
  const item = resolve(root, items.items);
  const taxes = property(root, item, "impostos");
  const taxProps = obj(taxes.properties);
  const purposeEnum = property(root, order, "finalidade").enum;
  const purposes = Array.isArray(purposeEnum) ? purposeEnum.filter((p): p is string => typeof p === "string") : [];
  const ibsCbs = resolve(root, taxProps.ibsCbs);
  return {
    ibs_cbs: Object.keys(obj(ibsCbs.properties)).includes("cst") && Object.keys(obj(ibsCbs.properties)).includes("classificacao"),
    selective: Object.keys(obj(resolve(root, taxProps.impostoSeletivo).properties)).includes("cst"),
    purposes,
    credit_debit: purposes.some((p) => /cr[eé]dito/i.test(p)) && purposes.some((p) => /d[eé]bito/i.test(p)),
  };
}

/** Confere a forma vinda do transporte interno (header) ou do segredo. */
export function readVaultReformCapability(value: unknown): VaultReformCapability | null | undefined {
  if (value === null) return null;
  const v = obj(value);
  if (!value || typeof v.ibs_cbs !== "boolean" || typeof v.selective !== "boolean" || typeof v.credit_debit !== "boolean" ||
      !Array.isArray(v.purposes) || v.purposes.length > 20 || v.purposes.some((p) => typeof p !== "string" || p.length > 40) ||
      Object.keys(v).some((k) => !["ibs_cbs", "selective", "purposes", "credit_debit"].includes(k))) return undefined;
  return { ibs_cbs: v.ibs_cbs, selective: v.selective, purposes: [...(v.purposes as string[])], credit_debit: v.credit_debit };
}
