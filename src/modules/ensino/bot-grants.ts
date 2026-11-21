// Ensino para bots: categoria sensível, tudo desligado por padrão. O
// administrador liga operação por operação, para cada bot, com o aviso
// abaixo (src/bot-actions/area.ts). A consulta do responsável pelo QR
// (ensino/access/...) é dele e não entra aqui. Justificativas de falta e
// notas são campos sensíveis: só saem com "incluir campos sensíveis".
import type { AreaBotModule } from "../../bot-actions/area-types";

const read = (path: string, title: string, description: string, fields?: string[]) =>
  ({ id: `consulta:${path}`, method: "GET" as const, path, title, description, ...(fields ? { fields } : {}) });
const write = (id: string, method: "POST" | "PUT" | "PATCH", path: string, title: string, description: string) =>
  ({ id, method, path, title, description });
const CLASS = "ensino/classes/:id";

export const ENSINO_BOT_GRANTS: AreaBotModule = {
  module: "ensino",
  title: "Ensino",
  warning:
    "São dados de alunos, muitos deles menores de idade: nomes, turmas, frequência, notas, boletins e responsáveis. Ao ligar, o bot pode ler ou propor estas operações e os dados vão ao provedor de IA. A pessoa que conversa com o bot continua precisando do papel de secretaria ou professor (professor só nas próprias turmas).",
  direct_warning:
    "O bot vai executar esta operação no registro escolar sem a pessoa confirmar antes (frequência, nota, boletim ou aviso aos responsáveis). Libere só se você confia no bot para isso.",
  sensitive_warning:
    "Justificativas de falta (que podem trazer motivo de saúde), notas e observações sobre os alunos vão ao provedor de IA.",
  sensitive_label: "justificativas de falta, notas e observações dos alunos",
  sensitive_keys: ["reason", "score", "notes", "observations", "document", "documents"],
  operations: [
    read("ensino/classes", "Listar turmas", "Lista as turmas da área (professor vê só as dele)."),
    read(CLASS, "Ver uma turma", "Mostra a turma com horários, períodos e regra de aprovação."),
    read(`${CLASS}/enrollments`, "Listar alunos da turma", "Lista os alunos matriculados na turma."),
    read(`${CLASS}/enrollments/:enrollment_id/guardians`, "Ver responsáveis do aluno", "Lista os responsáveis autorizados a consultar o aluno."),
    read(`${CLASS}/lessons`, "Listar aulas", "Lista as aulas da turma."),
    read(`${CLASS}/lessons/:lesson_id/attendance`, "Ver frequência da aula", "Mostra a frequência de cada aluno na aula. A justificativa é campo sensível."),
    read(`${CLASS}/assessments`, "Listar avaliações", "Lista as avaliações da turma."),
    read(`${CLASS}/assessments/:assessment_id/grades`, "Ver notas da avaliação", "Mostra as notas dos alunos na avaliação. A nota é campo sensível."),
    read(`${CLASS}/enrollments/:enrollment_id/reports/:period_id`, "Ver boletim do aluno", "Mostra o boletim do aluno no período, com frequência e notas."),
    read(`${CLASS}/notices`, "Listar avisos da turma", "Lista os avisos aos responsáveis da turma."),
    write("ensino.class.create", "POST", "ensino/classes", "Criar turma", "Cria uma turma com professor, horários, períodos e regra de aprovação."),
    write("ensino.class.update", "PATCH", CLASS, "Mudar turma", "Muda os dados da turma."),
    write("ensino.enrollment.create", "POST", `${CLASS}/enrollments`, "Matricular aluno", "Matricula o aluno (ordem de serviço de matrícula) na turma."),
    write("ensino.enrollment.end", "POST", `${CLASS}/enrollments/:enrollment_id/end`, "Encerrar matrícula", "Encerra a matrícula do aluno na turma."),
    write("ensino.guardian.grant", "POST", `${CLASS}/enrollments/:enrollment_id/guardians`, "Autorizar responsável", "Autoriza um responsável a consultar o boletim pelo WhatsApp."),
    write("ensino.guardian.revoke", "POST", `${CLASS}/enrollments/:enrollment_id/guardians/:guardian_id/revoke`, "Retirar responsável", "Retira a autorização do responsável."),
    write("ensino.customer.guardian.link", "PUT", `${CLASS}/enrollments/:enrollment_id/guardians/:guardian_id/contact`, "Ligar responsável ao contato", "Liga o responsável a um contato do cadastro."),
    write("ensino.customer.billing.link", "PUT", `${CLASS}/enrollments/:enrollment_id/billing-contact`, "Ligar contato de cobrança", "Define o contato de cobrança da matrícula."),
    write("ensino.lesson.create", "POST", `${CLASS}/lessons`, "Registrar aula", "Registra uma aula da turma."),
    write("ensino.lesson.update", "PATCH", `${CLASS}/lessons/:lesson_id`, "Mudar aula", "Muda os dados de uma aula."),
    write("ensino.attendance.record", "POST", `${CLASS}/lessons/:lesson_id/attendance`, "Lançar frequência", "Lança presença, falta ou falta justificada do aluno na aula."),
    write("ensino.assessment.create", "POST", `${CLASS}/assessments`, "Criar avaliação", "Cria uma avaliação na turma."),
    write("ensino.grade.record", "POST", `${CLASS}/assessments/:assessment_id/grades`, "Lançar nota", "Lança a nota do aluno na avaliação."),
    write("ensino.report.publish", "POST", `${CLASS}/enrollments/:enrollment_id/reports`, "Publicar boletim", "Publica o boletim do período para os responsáveis."),
    write("ensino.notice.create", "POST", `${CLASS}/notices`, "Escrever aviso aos responsáveis", "Escreve um aviso aos responsáveis da turma."),
    write("ensino.notice.publish", "POST", `${CLASS}/notices/:notice_id/publish`, "Publicar aviso", "Publica o aviso aos responsáveis."),
    write("ensino.notice.send", "POST", `${CLASS}/notices/:notice_id/send`, "Enviar aviso pelo WhatsApp", "Envia o aviso publicado aos responsáveis pelo WhatsApp."),
  ],
};
