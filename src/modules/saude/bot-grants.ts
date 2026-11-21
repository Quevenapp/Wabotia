// Saúde para bots: categoria sensível, tudo desligado por padrão. O
// administrador liga operação por operação, para cada bot, com o aviso
// abaixo (src/bot-actions/area.ts). Prontuário, diagnóstico e documentos são
// campos sensíveis: só saem com "incluir campos sensíveis" ligado.
import type { AreaBotModule } from "../../bot-actions/area-types";

const read = (path: string, title: string, description: string, fields?: string[]) =>
  ({ id: `consulta:${path}`, method: "GET" as const, path, title, description, ...(fields ? { fields } : {}) });

export const SAUDE_BOT_GRANTS: AreaBotModule = {
  module: "saude",
  title: "Saúde — prontuário",
  warning:
    "São dados de saúde e prontuário de pacientes (ou de animais e seus tutores). Ao ligar, o bot pode ler ou propor estas operações e os dados vão ao provedor de IA. A pessoa que conversa com o bot continua precisando dos papéis clínicos dela.",
  direct_warning:
    "O bot vai executar esta operação no prontuário sem a pessoa confirmar antes. Registro clínico errado pode prejudicar o paciente. Libere só se você confia no bot para isso.",
  sensitive_warning:
    "O texto do prontuário (evoluções, receitas, pedidos e resultados de exame), diagnósticos e nomes dos documentos anexados vão ao provedor de IA.",
  sensitive_label: "texto do prontuário, diagnóstico e documentos anexados",
  sensitive_keys: ["text", "reason", "origin", "diagnosis", "diagnostico", "birth_date", "tutor", "documents"],
  operations: [
    read("saude/subjects", "Listar pacientes", "Lista os pacientes (ou animais) com prontuário na área. Registra o acesso na auditoria clínica.", ["cursor", "limit"]),
    read("saude/subjects/:subject_id", "Ver ficha do paciente", "Mostra a ficha de um paciente: nome, tipo, nascimento, tutor e guarda. Registra o acesso."),
    read("saude/subjects/:subject_id/episodes", "Ver atendimentos do paciente", "Lista os atendimentos (episódios) do paciente, ligados às ordens de serviço."),
    read("saude/subjects/:subject_id/records", "Ler o prontuário", "Lista os registros do prontuário (evolução, receita, pedido e resultado de exame), com autor, data e assinatura. O texto clínico é campo sensível.", ["cursor", "limit"]),
    { ...read("saude/subjects/:subject_id/attachments", "Ver documentos anexados", "Lista os documentos anexados ao prontuário (tipo, tamanho e situação). O nome do arquivo é campo sensível."), sensitive_keys: ["name", "sha256"] },
    read("saude/subjects/:subject_id/export", "Exportar o prontuário", "Monta a exportação completa do prontuário do paciente. O conteúdo clínico é campo sensível."),
    read("saude/attendance/:order_id", "Ver atendimento da ordem de serviço", "Mostra se a ordem de serviço tem atendimento clínico e de qual paciente."),
    read("saude/retention/:subject_id", "Ver guarda do prontuário", "Mostra até quando o prontuário fica guardado e se há impedimento de exclusão."),
    read("saude/policy", "Ver política de guarda", "Mostra a política de guarda e exclusão de prontuários da área."),
    read("saude/audit", "Ver auditoria clínica", "Lista quem acessou quais prontuários e quando. Exige o papel de responsável técnico."),
    { id: "saude.subject.create", method: "POST", path: "saude/subjects", title: "Cadastrar paciente",
      description: "Cadastra um paciente (humano) ou um animal com espécie e tutor.", fields: ["kind", "name", "birth_date", "species", "tutor"] },
    { id: "saude.episode.create", method: "POST", path: "saude/subjects/:subject_id/episodes", title: "Abrir atendimento",
      description: "Abre um atendimento do paciente ligado a uma ordem de serviço.", fields: ["order_id"] },
    { id: "saude.record.create", method: "POST", path: "saude/subjects/:subject_id/records", title: "Escrever no prontuário",
      description: "Registra evolução, receita, pedido de exame ou resultado de exame no atendimento. Só o autor assina.",
      fields: ["episode_id", "kind", "text", "addendum_of", "reason", "request_id", "origin", "received_at"] },
    { id: "saude.record.edit", method: "PATCH", path: "saude/subjects/:subject_id/records/:record_id", title: "Corrigir registro não assinado",
      description: "Corrige o texto de um registro ainda não assinado, do próprio autor.", fields: ["version", "text"] },
    { id: "saude.record.sign", method: "POST", path: "saude/subjects/:subject_id/records/:record_id/sign", title: "Assinar registro",
      description: "Assina um registro do prontuário. Depois de assinado, só com adendo.", fields: ["version", "confirm"] },
    { id: "saude.attachment.reserve", method: "POST", path: "saude/subjects/:subject_id/attachments", title: "Reservar anexo",
      description: "Reserva o envio de um documento ao prontuário (PDF, imagem ou texto). O arquivo é enviado pela tela.",
      fields: ["episode_id", "name", "mime_type", "expected_bytes"] },
    { id: "saude.customer.link", method: "POST", path: "saude/subjects/:subject_id/contacts", title: "Ligar paciente ao contato",
      description: "Liga o paciente a um contato do cadastro.", fields: ["contact_id"] },
    { id: "saude.hold.set", method: "PUT", path: "saude/subjects/:subject_id/hold", title: "Impedir exclusão do prontuário",
      description: "Liga ou desliga o impedimento de exclusão (guarda legal) do prontuário.", fields: ["legal_hold", "version"] },
    { id: "saude.policy.set", method: "PUT", path: "saude/policy", title: "Mudar a política de guarda",
      description: "Muda por quantos dias os prontuários ficam guardados e se a exclusão é permitida.", fields: ["retention_days", "deletion_enabled", "version"] },
    { id: "saude.subject.purge", method: "POST", path: "saude/subjects/:subject_id/purge", title: "Excluir prontuário",
      description: "Exclui o prontuário do paciente, quando a política de guarda permite. Não tem volta." },
  ],
};
