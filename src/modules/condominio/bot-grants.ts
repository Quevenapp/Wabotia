// Condomínio para bots: categoria sensível, tudo desligado por padrão. O
// administrador liga operação por operação, para cada bot, com o aviso
// abaixo (src/bot-actions/area.ts). O acesso do morador pelo QR (rotas
// condominio/me/...) é do próprio morador e não entra aqui. Provas de
// procuração e de débito e detalhes de veículos e animais são campos
// sensíveis: só saem com "incluir campos sensíveis" ligado.
import type { AreaBotModule } from "../../bot-actions/area-types";

const read = (path: string, title: string, description: string, fields?: string[]) =>
  ({ id: `consulta:${path}`, method: "GET" as const, path, title, description, ...(fields ? { fields } : {}) });
const write = (id: string, path: string, title: string, description: string, fields: string[] = []) =>
  ({ id, method: "POST" as const, path, title, description, fields });

export const CONDOMINIO_BOT_GRANTS: AreaBotModule = {
  module: "condominio",
  title: "Condomínio",
  warning:
    "São dados de moradores: nomes, unidades, telefones, veículos, animais, encomendas, visitantes e votos em assembleia. Ao ligar, o bot pode ler ou propor estas operações e os dados vão ao provedor de IA. A pessoa que conversa com o bot continua precisando dos papéis dela no condomínio.",
  direct_warning:
    "O bot vai executar esta operação no condomínio sem a pessoa confirmar antes (cadastro, comunicado ou assembleia). Libere só se você confia no bot para isso.",
  sensitive_warning:
    "Provas de procuração e de débito, detalhes de veículos e animais e documentos dos moradores vão ao provedor de IA.",
  sensitive_label: "provas de procuração e de débito, detalhes de veículos e animais e documentos",
  sensitive_keys: ["evidence", "debt_evidence", "detail", "document", "documents"],
  operations: [
    read("condominio/blocks", "Listar blocos", "Lista os blocos do condomínio."),
    read("condominio/units", "Listar unidades", "Lista as unidades (apartamentos ou casas) por bloco."),
    read("condominio/people", "Listar moradores", "Lista as pessoas cadastradas no condomínio."),
    read("condominio/phones", "Listar telefones dos moradores", "Lista os telefones confirmados dos moradores."),
    read("condominio/memberships", "Listar vínculos com unidades", "Lista quem é proprietário, inquilino ou morador de cada unidade."),
    read("condominio/assets", "Listar veículos e animais", "Lista veículos e animais das unidades. O detalhe é campo sensível."),
    read("condominio/contacts", "Listar contatos do condomínio", "Lista os contatos ligados aos moradores."),
    read("condominio/capabilities", "Ver o que a pessoa pode fazer", "Mostra os papéis da pessoa no condomínio (administração, portaria, mesa)."),
    read("condominio/work-types", "Ver tipos de chamado", "Lista os tipos de ocorrência, encomenda e visitante."),
    read("condominio/works", "Listar ocorrências, encomendas e visitantes", "Lista os chamados da portaria e da administração."),
    read("condominio/works/:id", "Ver um chamado", "Mostra uma ocorrência, encomenda ou visitante."),
    read("condominio/notices", "Listar comunicados", "Lista os comunicados aos moradores e a situação de envio."),
    read("condominio/assemblies", "Listar assembleias", "Lista as assembleias do condomínio."),
    read("condominio/assemblies/:id", "Ver uma assembleia", "Mostra a assembleia com pauta, convocação e ata."),
    read("condominio/assemblies/:id/attendance", "Ver presença na assembleia", "Lista as unidades presentes e os representantes."),
    read("condominio/assemblies/:id/proxies", "Ver procurações da assembleia", "Lista as procurações. A prova é campo sensível."),
    read("condominio/agenda/:id/electors", "Ver quem pode votar no item", "Lista as unidades habilitadas a votar num item da pauta."),
    read("condominio/agenda/:id/results", "Ver resultado da votação", "Mostra a apuração de um item da pauta."),
    read("condominio/electoral-people", "Ver pessoas habilitadas a votar", "Lista as pessoas que podem votar ou representar."),
    read("condominio/electoral-units", "Ver unidades habilitadas a votar", "Lista as unidades e a habilitação para votar."),
    write("condominio.block", "condominio/blocks", "Cadastrar bloco", "Cadastra um bloco.", ["name"]),
    write("condominio.unit", "condominio/units", "Cadastrar unidade", "Cadastra uma unidade num bloco.", ["block_id", "number"]),
    write("condominio.person", "condominio/people", "Cadastrar morador", "Cadastra uma pessoa no condomínio.", ["name"]),
    write("condominio.phone", "condominio/phones", "Confirmar telefone do morador", "Liga o telefone de uma conversa ao morador.", ["person_id", "conversation_id", "confirmed"]),
    write("condominio.end-phone", "condominio/phones/:id/end", "Encerrar telefone do morador", "Desliga um telefone do morador."),
    write("condominio.membership", "condominio/memberships", "Vincular morador à unidade", "Vincula a pessoa à unidade como proprietário, inquilino ou morador.", ["person_id", "unit_id", "role", "starts_at", "ends_at", "notices"]),
    write("condominio.end-membership", "condominio/memberships/:id/end", "Encerrar vínculo com a unidade", "Encerra o vínculo da pessoa com a unidade."),
    write("condominio.asset", "condominio/assets", "Cadastrar veículo ou animal", "Cadastra um veículo ou animal da unidade.", ["unit_id", "person_id", "kind", "label", "detail"]),
    write("condominio.work", "condominio/works", "Abrir ocorrência, encomenda ou visitante", "Abre um chamado da portaria ou da administração.", ["kind", "unit_id", "person_id", "visitor_person_id", "delivery_source", "item", "problem", "extra"]),
    write("condominio.stage", "condominio/works/:id/stage", "Mudar a etapa do chamado", "Leva o chamado para a próxima etapa.", ["transition_id", "version"]),
    write("condominio.attendance", "condominio/attendance", "Registrar presença na assembleia", "Registra a presença (ou saída) de uma unidade na assembleia.", ["assembly_id", "unit_id", "person_id", "proxy_id", "leave"]),
    write("condominio.notice.create", "condominio/notices", "Escrever comunicado", "Escreve um comunicado para todos, um bloco ou unidades.", ["title", "body", "audience", "targets"]),
    write("condominio.notice.approve", "condominio/notices/:id/approve", "Aprovar comunicado", "Aprova o comunicado para envio.", ["reviewed_public_content"]),
    write("condominio.notice.send", "condominio/notices/:id/send", "Enviar comunicado", "Envia o comunicado aprovado aos moradores pelo WhatsApp."),
    write("condominio.notice.retry", "condominio/notices/:id/retry", "Reenviar comunicado", "Tenta de novo os envios que falharam."),
    write("condominio.assembly.create", "condominio/assemblies", "Criar assembleia", "Cria a assembleia com título, convocação e data.", ["title", "call_text", "starts_at"]),
    write("condominio.assembly.agenda", "condominio/assemblies/:id/agenda", "Incluir item na pauta", "Inclui um item de votação na pauta.", ["title", "options", "weighted", "block_debt", "closes_at"]),
    write("condominio.assembly.publish", "condominio/assemblies/:id/publish", "Publicar convocação", "Publica a convocação da assembleia.", ["reviewed"]),
    write("condominio.assembly.minutes", "condominio/assemblies/:id/minutes", "Registrar ata", "Registra a ata da assembleia."),
    write("condominio.assembly.open", "condominio/agenda/:id/open", "Abrir votação", "Abre a votação de um item da pauta."),
    write("condominio.assembly.close", "condominio/agenda/:id/close", "Encerrar votação", "Encerra a votação de um item da pauta."),
    write("condominio.assembly.annul", "condominio/agenda/:id/annul", "Anular votação", "Anula a votação de um item, com motivo.", ["reason"]),
    write("condominio.assembly.qualify", "condominio/agenda/:id/qualify", "Habilitar unidade para votar", "Habilita ou não a unidade a votar, conferindo débito.", ["unit_id", "person_id", "proxy_id", "debt_evidence"]),
    write("condominio.assembly.proxy", "condominio/proxies", "Registrar procuração", "Registra uma procuração para a assembleia.", ["assembly_id", "agenda_id", "unit_id", "grantor_id", "person_id", "evidence", "expires_at"]),
    write("condominio.assembly.review-proxy", "condominio/proxies/:id/review", "Conferir procuração", "Marca a procuração como conferida.", ["reviewed"]),
    write("condominio.assembly.revoke-proxy", "condominio/proxies/:id/revoke", "Revogar procuração", "Revoga uma procuração."),
  ],
};
