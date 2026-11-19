import { createHash } from "node:crypto";
import type { SourceRef } from "./contracts";

// Namespaces congelados; âncoras e comandos internos nunca colidem com eventos.
export const F3_NAMESPACES = Object.freeze({
  command: "9b6fd331-4cde-52ae-887b-a3d30d14e301",
  origin: "9b6fd331-4cde-52ae-887b-a3d30d14e302",
  reverse_origin: "9b6fd331-4cde-52ae-887b-a3d30d14e303",
  internal: "9b6fd331-4cde-52ae-887b-a3d30d14e304",
});
export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  throw new Error("integration_invalid_json");
}
export const hash = (value: unknown): string => createHash("sha256").update(canonical(value), "utf8").digest("hex");
export function uuid5(namespace: string, name: string): string {
  const bytes = Uint8Array.from(namespace.replace(/-/g, "").match(/../g)!.map(x => parseInt(x, 16)));
  const digest = createHash("sha1").update(bytes).update(name, "utf8").digest();
  digest[6] = (digest[6] & 15) | 80;
  digest[8] = (digest[8] & 63) | 128;
  const h = digest.subarray(0, 16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export const commandId = (source: SourceRef, seq: number) => uuid5(F3_NAMESPACES.command, canonical([source.profile, source.module, source.source_id, seq]));
export const eventKey = (source: SourceRef, operation: string, revision: number) =>
  `wb:${[source.profile, source.module, source.source_id, source.component, operation, String(revision)].map(encodeURIComponent).join(":")}`;
