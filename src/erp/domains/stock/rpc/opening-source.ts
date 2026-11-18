// O JSON armazenado precisa conservar os dígitos: JSON.parse arredonda números
// grandes e perde a escala que participa do hash jsonb e da validação de IDs.
import { parseTree, type Node } from "jsonc-parser";
import { jsonbKeys, jsonbText } from "../../../engine/json.ts";
import { stockObservationId } from "../../sync/public.ts";

export function openingSource(text: string) {
  const root = parseTree(text)!;
  const field = (node: Node | undefined, key: string): Node | undefined =>
    node?.type === "object" ? node.children?.find(p => p.children![0].value === key)?.children?.[1] : undefined;
  const numeric = (node: Node) => {
    const raw = text.slice(node.offset, node.offset + node.length);
    const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw)!;
    const digits = m[2] + (m[3] ?? ""), point = m[2].length + Number(m[4] ?? 0);
    const expanded = point <= 0 ? "0." + "0".repeat(-point) + digits : point >= digits.length
      ? digits + "0".repeat(point - digits.length) : digits.slice(0, point) + "." + digits.slice(point);
    return (/^0*$/.test(digits) ? "" : m[1]) + expanded.replace(/^0+(?=\d)/, "");
  };
  const canonical = (node: Node = root): string => {
    if (node.type === "number") return numeric(node);
    if (node.type === "array") return "[" + node.children!.map(n => canonical(n)).join(", ") + "]";
    if (node.type === "object") {
      const fields = Object.fromEntries(node.children!.map(p => [p.children![0].value, p.children![1]]));
      return "{" + jsonbKeys(fields).map(k => jsonbText(k) + ": " + canonical(fields[k])).join(", ") + "}";
    }
    return jsonbText(node.value);
  };
  const scalar = (node: Node | undefined): string | null => node?.type === "string" ? node.value : node?.type === "number" ? numeric(node) : null;
  const id = (node: Node | undefined): string | null => {
    // Um número com escala (1.0) não cumpre o regex SQL, embora JS o leia como 1.
    if (node?.type === "number" && !/^[1-9][0-9]{0,15}$/.test(numeric(node))) return null;
    return stockObservationId(node?.value);
  };
  return { root, field, numeric, canonical, scalar, id };
}
