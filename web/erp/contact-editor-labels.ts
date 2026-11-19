import type { ProfileVocabulary } from "../contact-profile/model";

/** Vocabulário puro compartilhado com o formulário, sem carregar suas telas. */
export function contactEditorTitle(vocabulary?: ProfileVocabulary, types: readonly string[] = []) {
  if (types.includes("supplier") && !types.includes("customer")) return "Fornecedor";
  return `${vocabulary?.singular?.trim() || "Cliente"} ou Fornecedor`;
}
