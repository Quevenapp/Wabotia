// Configuração dos arquivos (perfil e atividade do SPED Fiscal, o contador do
// registro 0100, o regime do PIS/COFINS, o código de receita do ICMS e os
// códigos do SINTEGRA): padrão, leitura do que veio da tela e conferência.
// Fica no objeto da área (erp_sped__settings, versão 29).
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.
import type { SpedSettings } from "./model.ts";

export const DEFAULT_SETTINGS: SpedSettings = Object.freeze({
  profile: "A", activity: "1",
  accountant: { name: null, cpf: null, crc: null, cnpj: null, postal_code: null, street: null, number: null, complement: null, district: null, phone: null, email: null, city_code: null },
  pis_cofins: { incidence: "1", credit_method: "1", contribution_type: "1", cumulative_regime: "9", nature: "00", activity: "2" },
  icms_revenue_code: null, icms_due_day: 10,
  sintegra: { nature: "3", purpose: "1", contact: null },
  in_package: true,
}) as SpedSettings;

export class SettingsError extends Error {}
const bad = (message: string): never => { throw new SettingsError(message); };
const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown, max: number, label: string): string | null => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string") return bad(`${label}: informe um texto.`);
  const t = v.trim();
  if (t.length > max) bad(`${label}: até ${max} caracteres.`);
  return t || null;
};
const pick = <T extends string>(v: unknown, options: readonly T[], label: string, fallback: T): T => {
  if (v === undefined || v === null || v === "") return fallback;
  if (!(options as readonly unknown[]).includes(v)) return bad(`${label}: escolha uma das opções (${options.join(", ")}).`);
  return v as T;
};
const digitsOnly = (v: string | null) => v ? v.replace(/\D/g, "") : null;

/** CPF com os dígitos verificadores. */
export function validCpf(value: string | null): boolean {
  const d = (value ?? "").replace(/\D/g, "");
  if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false;
  for (const len of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const check = (sum * 10) % 11 % 10;
    if (check !== Number(d[len])) return false;
  }
  return true;
}

/** Junta o que está gravado com o padrão (campos novos ganham o padrão). */
export function settingsOf(stored: unknown): SpedSettings {
  const s = obj(stored), d = DEFAULT_SETTINGS;
  return {
    ...d, ...s,
    accountant: { ...d.accountant, ...obj(s.accountant) },
    pis_cofins: { ...d.pis_cofins, ...obj(s.pis_cofins) },
    sintegra: { ...d.sintegra, ...obj(s.sintegra) },
  } as SpedSettings;
}

/** O corpo da tela (nomes em português) aplicado sobre o atual; erro com a mensagem do que corrigir. */
export function applySettings(current: SpedSettings, body: Record<string, unknown>): SpedSettings {
  const next: SpedSettings = JSON.parse(JSON.stringify(current));
  if ("perfil" in body) next.profile = pick(body.perfil, ["A", "B", "C"] as const, "Perfil do SPED", current.profile);
  if ("atividade" in body) next.activity = pick(body.atividade, ["0", "1"] as const, "Atividade (0 industrial ou equiparado, 1 outros)", current.activity);
  if ("contador" in body) {
    const c = obj(body.contador), a = next.accountant;
    if ("nome" in c) a.name = text(c.nome, 100, "Nome do contador");
    if ("cpf" in c) { a.cpf = digitsOnly(text(c.cpf, 14, "CPF do contador")); if (a.cpf && !validCpf(a.cpf)) bad("CPF do contador inválido: confira os 11 números."); }
    if ("crc" in c) a.crc = text(c.crc, 15, "CRC do contador");
    if ("cnpj" in c) { a.cnpj = digitsOnly(text(c.cnpj, 18, "CNPJ do escritório")); if (a.cnpj && a.cnpj.length !== 14) bad("CNPJ do escritório: 14 números."); }
    if ("cep" in c) { a.postal_code = digitsOnly(text(c.cep, 9, "CEP do escritório")); if (a.postal_code && a.postal_code.length !== 8) bad("CEP do escritório: 8 números."); }
    if ("endereco" in c) a.street = text(c.endereco, 60, "Endereço do escritório");
    if ("numero" in c) a.number = text(c.numero, 10, "Número do endereço do escritório");
    if ("complemento" in c) a.complement = text(c.complemento, 60, "Complemento do endereço do escritório");
    if ("bairro" in c) a.district = text(c.bairro, 60, "Bairro do escritório");
    if ("telefone" in c) a.phone = digitsOnly(text(c.telefone, 20, "Telefone do contador"));
    if ("email" in c) { a.email = text(c.email, 120, "E-mail do contador"); if (a.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email)) bad("E-mail do contador inválido."); }
    if ("municipio" in c) { a.city_code = digitsOnly(text(c.municipio, 7, "Código do município do escritório")); if (a.city_code && a.city_code.length !== 7) bad("Código do município (IBGE) do escritório: 7 números."); }
  }
  if ("pis_cofins" in body) {
    const p = obj(body.pis_cofins), n = next.pis_cofins;
    if ("incidencia" in p) n.incidence = pick(p.incidencia, ["1", "2", "3"] as const, "Incidência do PIS/COFINS", n.incidence);
    if ("apropriacao" in p) n.credit_method = pick(p.apropriacao, ["1", "2"] as const, "Apropriação do crédito", n.credit_method);
    if ("tipo_contribuicao" in p) n.contribution_type = pick(p.tipo_contribuicao, ["1", "2"] as const, "Tipo de contribuição", n.contribution_type);
    if ("regime_cumulativo" in p) n.cumulative_regime = pick(p.regime_cumulativo, ["1", "2", "9"] as const, "Regime do cumulativo", n.cumulative_regime);
    if ("natureza" in p) n.nature = pick(p.natureza, ["00", "01", "02", "03", "04", "05", "10"] as const, "Natureza da pessoa jurídica", n.nature as "00");
    if ("atividade" in p) n.activity = pick(p.atividade, ["0", "1", "2", "3", "4", "9"] as const, "Atividade preponderante", n.activity);
  }
  if ("codigo_receita_icms" in body) next.icms_revenue_code = text(body.codigo_receita_icms, 20, "Código de receita do ICMS");
  if ("dia_vencimento_icms" in body) {
    const day = Number(body.dia_vencimento_icms);
    if (!Number.isInteger(day) || day < 1 || day > 31) bad("Dia do vencimento do ICMS: de 1 a 31.");
    next.icms_due_day = day;
  }
  if ("sintegra" in body) {
    const s = obj(body.sintegra);
    if ("natureza" in s) next.sintegra.nature = pick(s.natureza, ["1", "2", "3"] as const, "Natureza das operações do SINTEGRA", next.sintegra.nature);
    if ("finalidade" in s) next.sintegra.purpose = pick(s.finalidade, ["1", "2", "3", "5"] as const, "Finalidade do SINTEGRA", next.sintegra.purpose);
    if ("contato" in s) next.sintegra.contact = text(s.contato, 28, "Pessoa de contato do SINTEGRA");
  }
  if ("no_pacote" in body) { if (typeof body.no_pacote !== "boolean") bad("Incluir no pacote do contador: verdadeiro ou falso."); next.in_package = body.no_pacote as boolean; }
  return next;
}

/** A configuração na língua da tela. */
export function settingsView(s: SpedSettings) {
  const a = s.accountant, p = s.pis_cofins;
  return {
    perfil: s.profile, atividade: s.activity,
    contador: { nome: a.name, cpf: a.cpf, crc: a.crc, cnpj: a.cnpj, cep: a.postal_code, endereco: a.street, numero: a.number, complemento: a.complement,
      bairro: a.district, telefone: a.phone, email: a.email, municipio: a.city_code },
    pis_cofins: { incidencia: p.incidence, apropriacao: p.credit_method, tipo_contribuicao: p.contribution_type, regime_cumulativo: p.cumulative_regime, natureza: p.nature, atividade: p.activity },
    codigo_receita_icms: s.icms_revenue_code, dia_vencimento_icms: s.icms_due_day,
    sintegra: { natureza: s.sintegra.nature, finalidade: s.sintegra.purpose, contato: s.sintegra.contact },
    no_pacote: s.in_package,
  };
}
