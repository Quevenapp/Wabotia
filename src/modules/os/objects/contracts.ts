import type { ChildStatement, ServiceObjectRow } from "../public";
import type { ExtraValues, ServiceObjectSnapshotView, ServiceObjectType } from "../contracts";

export type ObjectRow = ServiceObjectRow;
export const OBJECT_LIMITS = { perContact: 100, activePerType: 30, page: 50, choices: 30 } as const;
export interface ObjectReceipt {
  profile_id: string;
  actor_key: string;
  operation: string;
  request_id: string;
  payload_hash: string;
  object_id: string | null;
  order_id: string | null;
  result_version: number;
  created: number;
}
/** Resultado persistente do comando, separado da projeção atual da ficha. */
export interface ObjectMutationRef {
  id: string;
  version: number;
  object_id?: string;
  order_id?: string;
  changed_fields?: string[];
}
export interface PreparedObject {
  row: ObjectRow;
  type: ServiceObjectType;
  before: ChildStatement[];
  after: ChildStatement[];
}
export interface LegacyObjectLinkPreview {
  preview: true;
  order_id: string;
  version: number;
  type: ServiceObjectSnapshotView["type"];
  /** Sugestões explícitas; nenhum valor é copiado ao confirmar sem ser informado. */
  compatible_values: ExtraValues;
}
