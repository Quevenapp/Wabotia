// DTOs de F0: imports apenas de tipos, sem levar o servidor ao bundle.
export type * from "../../../src/modules/os/contracts";
import type { Task } from "../../../src/modules/os/contracts";
// Consulta agregada proposta em painel.md; isolada até T/I congelarem a rota.
export interface Deadline extends Task {
  type_id: string;
  type_label: string;
  display_number: string;
  stage_label: string;
  customer?: { name: string };
}
export interface DeadlineQuery {
  assignee: "me";
  state: "open" | "done" | "cancelled";
  type_id?: string;
  period?: string;
  due_from?: string;
  due_to?: string;
  cursor?: string;
}
