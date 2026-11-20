// Prévia em linguagem de dono de negócio: "Vamos ligar: …", "Vamos criar: …",
// "Não vamos mexer em: …". Pura, sem servidor: o painel monta a frase a partir
// do modelo e das mudanças da prévia calculada pelo servidor.
import { ERP_PART_NAMES } from "../erp/parts";
import type { TemplateChange } from "../modules/os/contracts";

export const MODULE_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  queue: "Fila presencial", forms: "Formulários", agenda: "Agenda", os: "Ordem de Serviço",
  juridico: "Jurídico", condominio: "Condomínio", saude: "Saúde (prontuário)", ensino: "Ensino",
  payments: "Cobrança", mensalidade: "Mensalidade", suporte: "Suporte pago", reserva: "Reserva",
  pedido: "Pedido", mesas: "Mesas", entrega: "Entrega", ...ERP_PART_NAMES,
};
export const moduleDisplayName = (id: string) => MODULE_DISPLAY_NAMES[id] ?? id;

export const spoken = (items: readonly string[]) =>
  items.length > 1 ? `${items.slice(0, -1).join(", ")} e ${items.at(-1)}` : items.join("");
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

interface SummaryTemplate {
  work_types: Array<{ id: string; labels: { singular: string } }>;
  modules: Partial<Record<string, boolean>>;
}
export interface OwnerSummary {
  /** Módulos que serão ligados agora. */
  turn_on: string[];
  /** Módulos do modelo que já estavam ligados. */
  already_on: string[];
  /** Frases do que será criado. */
  create: string[];
  /** O que a empresa já configurou e fica como está. */
  untouched: string[];
}

/** Resume a prévia: só "add"/"set" viram criação; "keep" vira "não vamos mexer". */
export function ownerSummary(template: SummaryTemplate, changes: readonly TemplateChange[]): OwnerSummary {
  const added = (prefix: string) => changes.filter((change) => change.action === "add" && change.path.startsWith(prefix + "."));
  const kept = (prefix: string) => changes.filter((change) => change.action === "keep" && change.path.startsWith(prefix + "."));
  const moduleChanges = changes.filter((change) => change.path.startsWith("modules."));
  const turn_on = moduleChanges.filter((change) => change.action === "set" && template.modules[change.path.slice(8)] === true).map((change) => moduleDisplayName(change.path.slice(8)));
  const already_on = moduleChanges.filter((change) => change.action === "keep" && template.modules[change.path.slice(8)] === true).map((change) => moduleDisplayName(change.path.slice(8)));
  const create: string[] = [];
  const types = added("os_work_types").map((change) => {
    const id = change.path.slice("os_work_types.".length).replace(/^area_[a-z0-9_]+?__/, "");
    return template.work_types.find((type) => type.id === id)?.labels.singular;
  }).filter((name): name is string => !!name);
  if (types.length === 1) create.push(`o modelo de ordem "${types[0]}"`);
  else if (types.length) create.push(`os modelos de ordem ${spoken(types.map((name) => `"${name}"`))}`);
  const departments = added("departments").length, categories = added("ticket_categories").length, menus = added("menus").length;
  if (departments) create.push(count(departments, "setor", "setores"));
  if (categories) create.push(count(categories, "categoria de protocolo", "categorias de protocolo"));
  if (menus) create.push(count(menus, "opção no menu do WhatsApp", "opções no menu do WhatsApp"));
  for (const change of changes) if (change.action === "add" && change.path.startsWith("examples.")) {
    if (change.path === "examples.agenda") create.push("o horário de funcionamento e serviços de exemplo na Agenda");
    if (change.path === "examples.mensalidade") create.push("um plano de exemplo na Mensalidade");
  }
  const texts = changes.filter((change) => change.action === "set" && !change.path.startsWith("modules.") && !change.path.startsWith("examples."));
  if (texts.length) create.push("as mensagens de boas-vindas e o vocabulário do ramo (onde ainda estavam em branco)");
  if (added("os_area_setup").length) create.push("sugestões de instruções para o robô (sem dar permissões a ele)");

  const untouched: string[] = [];
  const keptItems = ["os_work_types", "departments", "ticket_categories", "menus"].reduce((sum, key) => sum + kept(key).length, 0);
  if (keptItems) untouched.push(`${count(keptItems, "cadastro", "cadastros")} que já existia${keptItems === 1 ? "" : "m"} com o mesmo nome do modelo`);
  const keptTexts = changes.filter((change) => change.action === "keep" && !/^(modules|examples|os_work_types|os_object_types|departments|ticket_categories|menus|os_area_setup)\./.test(change.path));
  if (keptTexts.length) untouched.push("as mensagens e o vocabulário que você já escreveu");
  if (changes.some((change) => change.path === "examples.agenda" && change.action === "keep")) untouched.push("os serviços e profissionais que você já cadastrou na Agenda");
  if (changes.some((change) => change.path === "examples.mensalidade" && change.action === "keep")) untouched.push("os planos que você já cadastrou na Mensalidade");
  untouched.push("conversas, contatos, equipe, WhatsApp e os módulos que você já ligou");
  return { turn_on, already_on, create, untouched };
}
