import type { AreaTemplate } from "../../modules/os/contracts";
import { eventoObjectType } from "./service-object-seeds";

export const festasEventosTemplate: AreaTemplate = {
  schema_version: 1,
  id: "festas_eventos",
  version: 1,
  name: "Festas e eventos",
  description: "Solicitações de decoração, montagem e complementação para um evento reutilizável do contratante, com tarefas manuais e registro do serviço executado.",
  object_types: [eventoObjectType],
  work_types: [{
    schema_version: 1, kind: "custom", id: "festa_evento", revision: 1, archived: false,
    object_type_id: "evento",
    labels: {
      singular: "Serviço de evento", plural: "Serviços de eventos",
      item: "Serviço contratado", problem: "Solicitação",
      customer_singular: "Contratante", customer_plural: "Contratantes",
    },
    number_prefix: "FES-",
    terms: "Solicito a definição do serviço descrito para o evento informado. A equipe confirmará o escopo, os valores e as condições de execução. Informar data, local ou materiais não reserva agenda, equipe ou itens de decoração. Alterações do serviço dependem de acordo com o contratante.",
    fields: [
      { id: "escopo_solicitado", label: "Escopo solicitado", help: "Descreva decoração, montagem ou complementação pretendida para esta ordem.", kind: "text", multiline: true, max_length: 2000, required: true, client_visible: true, sensitive: false },
      { id: "objetos_extras", label: "Objetos extras", help: "Itens solicitados neste atendimento. Disponibilidade e condições serão confirmadas pela equipe.", kind: "text", multiline: true, max_length: 2000, required: false, client_visible: true, sensitive: false },
      { id: "decoracao_extra", label: "Decoração extra", help: "Complementos solicitados para esta ordem.", kind: "text", multiline: true, max_length: 2000, required: false, client_visible: true, sensitive: false },
      { id: "servico_executado", label: "Serviço executado", help: "Registre o que foi realizado antes de concluir esta ordem.", kind: "text", multiline: true, max_length: 2000, required: false, client_visible: true, sensitive: false },
    ],
    retired_field_ids: [],
    stage_field_rules: [{ field_id: "servico_executado", required_from_stage: "concluido" }],
    list_fields: [
      { ref: { scope: "object", field_id: "nome" }, column: true, filter: true },
      { ref: { scope: "object", field_id: "data_festa" }, column: true, filter: true },
      { ref: { scope: "object", field_id: "tema" }, column: true, filter: true },
    ],
    stages: [
      { id: "solicitacao", label: "Solicitação", base_status: "received", message: "Recebemos o serviço {identificador} para {objeto}. A equipe conferirá sua solicitação." },
      { id: "definicao", label: "Definição", base_status: "analyzing", message: "Estamos definindo os detalhes do serviço {identificador} para {objeto}." },
      { id: "execucao", label: "Execução", base_status: "in_progress", message: "A execução do serviço {identificador} para {objeto} foi iniciada." },
      { id: "concluido", label: "Entrega e conclusão", base_status: "delivered", message: "Registramos a entrega e conclusão do serviço {identificador} para {objeto}. Obrigado pela preferência!" },
      { id: "cancelado", label: "Cancelamento", base_status: "cancelled", message: "O serviço {identificador} para {objeto} foi cancelado. Fale com a equipe para esclarecer as condições do encerramento." },
    ],
    retired_stage_ids: [],
    initial_stage: "solicitacao",
    transitions: [
      { id: "definir", from: "solicitacao", to: "definicao", label: "Definir o serviço", kind: "manual" },
      { id: "executar", from: "definicao", to: "execucao", label: "Iniciar execução acordada", kind: "manual" },
      { id: "revisar", from: "execucao", to: "definicao", label: "Revisar o escopo", kind: "manual" },
      { id: "concluir", from: "execucao", to: "concluido", label: "Registrar entrega e conclusão", kind: "manual" },
      { id: "cancelar_solicitacao", from: "solicitacao", to: "cancelado", label: "Cancelar solicitação", kind: "manual" },
      { id: "cancelar_definicao", from: "definicao", to: "cancelado", label: "Cancelar definição", kind: "manual" },
      { id: "cancelar_execucao", from: "execucao", to: "cancelado", label: "Cancelar execução", kind: "manual" },
    ],
    features: {
      customer_open: true, tasks: true, people: true, documents: true, entries: true,
      quote: null, warranty_days: 0, pickup_reminder_days: 0, stale_days: 0,
    },
    pickup_reminder_text: "",
  }],
  modules: { os: true, payments: false, agenda: false, mensalidade: false, forms: false, reserva: false, erp: false },
  vocabulary: { collection_label: "Serviços de eventos", customer_singular: "Contratante", customer_plural: "Contratantes" },
  departments: [
    { id: "atendimento", name: "Atendimento", members: [], enabled: true },
    { id: "producao", name: "Produção", members: [], enabled: true },
  ],
  ticket_categories: [
    { id: "solicitacao", name: "Solicitação", enabled: true },
    { id: "complemento", name: "Complemento", enabled: true },
    { id: "entrega", name: "Entrega", enabled: true },
  ],
  menus: [
    { id: "solicitar", label: "Solicitar serviço de evento", type: "os_open", type_id: "festa_evento" },
    { id: "acompanhar", label: "Acompanhar serviço de evento", type: "os_track", type_id: "festa_evento" },
    { id: "equipe", label: "Falar com a equipe", type: "human", department_id: "atendimento" },
  ],
  texts: {
    menu_greeting: "Olá! Como podemos ajudar com seu evento?",
    instructions: "Escolha um evento do seu cadastro ou informe outro pelo formulário. Use um nome administrativo; não é necessário informar nome de criança. Cada pedido de decoração, montagem ou complemento pode ter sua própria ordem para o mesmo evento.",
    protocol_confirmation: "Recebemos sua solicitação. A equipe confirmará o escopo e as condições do serviço.",
  },
  bot: {
    instructions: "Você atende contratantes de festas e eventos. Use as operações e os dados autorizados pela configuração do administrador, inicialmente conservadora. No WhatsApp, use o titular confirmado da conversa e apresente somente seus eventos e ordens. Nome, local, telefone digitado e data não comprovam titularidade. Para cadastrar outro evento, use o formulário. Respeite a projeção de dados do canal. Informe somente escopo, etapas e condições retornados pelas ferramentas autorizadas. Não invente disponibilidade, reserva, preço ou confirmação de agenda. Encaminhe decisões sobre condições, alterações e materiais à equipe.",
    allowed_operations: [], denied_operations: [], suggested_roles: [],
  },
  manual_steps: [
    "Revisar termos, permissões e ferramentas do bot com o administrador; o modelo não concede papéis nem habilita operações automaticamente.",
    "Conferir o contato contratante antes de cadastrar o evento. A mesma festa pode receber ordens distintas de decoração, montagem e complementação. Identificação do evento não concede acesso aos dados de outro cliente.",
    "Registrar data, tema e local no evento; escopo solicitado, objetos extras, decoração extra e serviço executado pertencem a cada ordem. Alterar o evento atual não muda os dados capturados nas ordens anteriores.",
    "Criar tarefas manualmente para conferir escopo, materiais, montagem e entrega. Não há checklist automático por etapa.",
    "Conferir o serviço executado antes de Entrega e conclusão. Cancelamento permanece disponível sem preencher esse campo.",
    "Combinar disponibilidade, horários e materiais com a equipe. Este modelo não reserva itens, movimenta estoque nem cria agendamento.",
    "Revisar e liberar individualmente documentos e fotos antes de compartilhá-los no atendimento do contratante.",
  ],
};
