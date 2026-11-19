import { erpPorts } from "./ports";

/** Só novas abas usam a base pública; o roteador portado continua com seus caminhos internos. */
export function erpPublicHref(target: string): string {
  if (!erpPorts()?.embedded) return target;
  const fragment = target.indexOf("#");
  const hash = fragment < 0 ? "" : target.slice(fragment);
  const address = fragment < 0 ? target : target.slice(0, fragment);
  const query = address.indexOf("?");
  const pathname = query < 0 ? address : address.slice(0, query);
  const search = query < 0 ? "" : address.slice(query + 1);
  const fields = search ? search.split("&") : [];
  const erpPath = pathname.replace(/^\/app\/erp(?=\/|$)/, "");
  // Contrato de href({ area: "erp", erpPath, search, hash }): só demo/pair
  // são herdados. Não importar a casca (e seus componentes) no ERP autônomo.
  const params = new URLSearchParams(fields.join("&"));
  const session = new URLSearchParams(globalThis.location?.search);
  for (const key of ["demo", "pair"]) {
    if (!params.has(key) && session.has(key))
      fields.push(new URLSearchParams({ [key]: session.get(key) || "1" }).toString());
  }
  return "/app/erp" + (erpPath === "/" ? "" : erpPath) + (fields.length ? "?" + fields.join("&") : "") + hash;
}
