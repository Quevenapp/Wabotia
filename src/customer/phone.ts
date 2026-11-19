/**
 * Não é prova de identidade. Somente espaço ASCII, ponto, hífen, parênteses
 * balanceados e um + inicial são aceitos. Nenhuma variante de nono dígito.
 * human_br: sem +, exige DDD (10/11 dígitos) ou 55 + DDD (12/13).
 */
export function normalizeCustomerPhone(
  value: unknown,
  mode: "international" | "human_br",
): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/^ +| +$/g, "");
  if (!/^\+?[0-9 ().-]+$/.test(text)) return null;
  // Parênteses servem apenas para agrupar dígitos, sem aninhamento.
  if (/[()]/.test(text.replace(/\([0-9]+\)/g, ""))) return null;
  let phone = text.replace(/[+ ().-]/g, "");
  if (!/^[1-9][0-9]{7,14}$/.test(phone)) return null;
  if (mode === "human_br" && !text.startsWith("+")) {
    if (phone.length === 10 || phone.length === 11) phone = `55${phone}`;
    else if (!/^55[1-9][0-9]{9,10}$/.test(phone)) return null;
  } else if (mode !== "international" && mode !== "human_br") return null;
  return phone;
}

/** Só o formato brasileiro local inequívoco recebe DDI na leitura legada. */
export function customerPhoneInputMode(value: unknown): "international" | "human_br" {
  return typeof value === "string" && !value.trim().startsWith("+") &&
    /^(?:[1-9]{2}9[0-9]{8}|[1-9]{2}[2-9][0-9]{7})$/.test(value.replace(/[ ().-]/g, ""))
    ? "human_br" : "international";
}

/** Compatibilidade publicada do WhatsApp brasileiro, só após prova do canal. */
export function customerPhoneVariants(value: string, mode: "international" | "human_br" = "international", legacy = false): string[] {
  const phone = normalizeCustomerPhone(value, mode);
  if (!phone) return [];
  const phones = [phone];
  if (/^55\d{2}9\d{8}$/.test(phone)) phones.push(phone.slice(0, 4) + phone.slice(5));
  else if (/^55\d{2}[6-9]\d{7}$/.test(phone)) phones.push(phone.slice(0, 4) + "9" + phone.slice(4));
  // Sem DDI só é candidato quando a origem é brasileira. Um + internacional
  // explícito nunca é reinterpretado como DDD brasileiro.
  if (legacy && /^55[1-9][0-9]{9,10}$/.test(phone)) phones.push(...phones.map(p => p.slice(2)));
  return [...new Set(phones)];
}
