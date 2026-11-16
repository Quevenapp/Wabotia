// Cadastro de clientes: contrato estável para outros módulos (docs/MODULOS.md,
// "Dependência entre módulos"). Quem importa daqui declara "clientes" em
// `requires` (ou em `optional_requires`, quando o núcleo tiver) e confere
// `clientesAvailable` antes de usar. Sem a dependência, use as rotas
// (ctx.read(actor, "clientes/conversations/<id>")).
import { ApiError, type Env } from "../../types";
import { modulesApi } from "../api";
import { moduleEnabled } from "../registry";
import { fiscalRecipient } from "./model";
import {
  customerByPhone,
  linkFiscalDocument,
  loadCustomer,
  logAccess,
  requireReason,
} from "./store";

export type FiscalRecipient = ReturnType<typeof fiscalRecipient>;

const ctxOf = (env: Env, profile: string) => modulesApi(env, profile, "clientes");

export const clientesAvailable = (env: Env, profile: string) =>
  moduleEnabled(env, profile, "clientes");

/** Ficha (resumo, sem dado pessoal além do nome) do telefone autenticado, ou null. */
export async function customerForPhone(env: Env, profile: string, phone: string) {
  const row = await customerByPhone(ctxOf(env, profile), phone);
  return row
    ? {
        id: row.id as string,
        kind: row.kind as "pf" | "pj",
        name: row.name as string,
        has_document: !!row.document,
        status: row.status as string,
      }
    : null;
}

/**
 * Destinatário completo para emitir nota (formato do FiscalProvider de
 * Vendas), com registro de acesso "fiscal" (quem, quando, motivo). Ficha
 * com dados excluídos: 409 customer_erased.
 */
export async function fiscalRecipientFor(
  env: Env,
  profile: string,
  customerId: string,
  access: { actor: { id: string; kind: string }; reason: string; module: string },
): Promise<FiscalRecipient> {
  const ctx = ctxOf(env, profile);
  const row = await loadCustomer(ctx, customerId);
  if (row.status !== "active")
    throw new ApiError(
      409,
      "customer_erased",
      "Os dados deste cliente foram excluídos a pedido do titular.",
    );
  await logAccess(
    ctx,
    access.actor,
    row.id,
    "fiscal",
    ["document", "address", "ie", "im", "email"],
    `${access.module}: ${requireReason(access.reason)}`,
  );
  return fiscalRecipient(row);
}

/**
 * Nota emitida para a ficha: o Cadastro passa a guardar o vínculo e o prazo
 * legal (o documento fica com o emissor). Repetir atualiza.
 */
export function recordFiscalDocument(
  env: Env,
  profile: string,
  input: {
    customer_id: string;
    module_id: string;
    ref_id: string;
    model: "nfe" | "nfce" | "nfse";
    series?: string | number;
    number?: string | number;
    access_key?: string;
    issued_at?: number;
  },
) {
  return linkFiscalDocument(ctxOf(env, profile), input);
}
