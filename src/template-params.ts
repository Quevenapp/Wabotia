// Parâmetro de modelo do WhatsApp (notificação fora da janela de 24 h). A
// Meta recusa parâmetro com quebra de linha, tabulação ou mais de quatro
// espaços seguidos, e vazio: o texto vira uma linha só, com " · " no lugar
// das quebras ("corpo · link · Pix copia e cola: · código").
export function templateParam(value: unknown, max = 1000) {
  const text = String(value ?? "")
    .replace(/[^\S\r\n\t]*[\r\n\t]+\s*/g, " · ")
    .replace(/ {4,}/g, "   ")
    .replace(/^(?:\s*·\s*)+|(?:\s*·\s*)+$/g, "")
    .trim();
  const cut = Array.from(text).slice(0, max).join("").trimEnd();
  return cut || "-";
}
