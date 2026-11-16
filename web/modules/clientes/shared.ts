// Cadastro de clientes (módulo "clientes"): rótulos e formatos do painel.
import type { Row } from "../../lib/api";

export const kindLabels: Record<string, string> = {
  pf: "Pessoa física",
  pj: "Pessoa jurídica",
};
export const statusLabels: Record<string, string> = {
  active: "Ativa",
  erasing: "Exclusão em andamento",
  erased: "Dados excluídos",
};
export const erasureLabels: Record<string, string> = {
  awaiting_confirmation: "Aguardando o titular",
  processing: "Em andamento",
  done: "Concluída",
  cancelled: "Cancelada",
  expired: "Venceu sem confirmação",
};
export const erasureTones: Record<string, "ok" | "warn" | "muted" | "danger"> = {
  awaiting_confirmation: "warn",
  processing: "warn",
  done: "ok",
  cancelled: "muted",
  expired: "muted",
};
export const viaLabels: Record<string, string> = {
  whatsapp: "Palavra no WhatsApp",
  menu: "Menu do WhatsApp",
  link: "Link",
  panel: "Equipe (painel)",
  button: "Botão no WhatsApp",
  text: "Resposta no WhatsApp",
};
export const sourceLabels: Record<string, string> = {
  self: "Preenchido pelo cliente",
  panel: "Cadastrado pela equipe",
  api: "Cadastrado por integração",
};
export const ieLabels: Record<string, string> = {
  "1": "Contribuinte do ICMS",
  "2": "Isento de inscrição",
  "9": "Não contribuinte",
};
export const fieldLabels: Record<string, string> = {
  document: "CPF/CNPJ",
  email: "E-mail",
  phones: "Telefones",
  address: "Endereço",
  ie: "Inscrição estadual",
  im: "Inscrição municipal",
};
export const moduleLabels: Record<string, string> = {
  core: "Atendimento",
  clientes: "Cadastro",
  vendas: "Vendas",
  pedido: "Pedidos",
  os: "Ordens de serviço",
  reserva: "Reservas",
  agenda: "Agenda",
  mensalidade: "Mensalidades",
  suporte: "Suporte pago",
};

export function stampLabel(ms: number | null | undefined) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
export function dateLabel(ms: number | null | undefined) {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString("pt-BR", {
    timeZone: "America/Sao_Paulo",
  });
}

export function addressLine(address: Row | null | undefined) {
  if (!address) return "—";
  const street = [address.street, address.number].filter(Boolean).join(", ");
  const place = [address.district, address.city && `${address.city}/${address.uf}`]
    .filter(Boolean)
    .join(" · ");
  const line = [street, address.complement, place, address.cep && `CEP ${address.cep}`]
    .filter(Boolean)
    .join(" · ");
  return line || "—";
}
