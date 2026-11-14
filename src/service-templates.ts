import { one } from "./db";
import {
  type Env,
  type Actor,
  ApiError,
  requireValue,
  defaultProtocolConfirmation,
  defaults,
} from "./types";
import { admin } from "./security";
import { settings, perform } from "./service";
import { businessHours } from "./business-time";

// Ready-made service centers. Applying one writes ordinary settings through
// the same validation as PUT /settings; nothing here is a separate runtime.
// Every id carries the template prefix so the items live beside manual ones.

interface TemplateMenu {
  id: string;
  label: string;
  type: string;
  parent_id: string | null;
  enabled: true;
  content?: string;
  department_id?: string;
  /** Bot destinations: filled with the chosen bot when the template is applied. */
  bot_id?: null;
  /** Informative message used instead when the area has no bot. */
  fallback_content?: string;
}
export interface ServiceTemplate {
  id: string;
  name: string;
  description: string;
  summary: string;
  settings: {
    departments: { id: string; name: string; members: []; enabled: true }[];
    ticket_categories: { id: string; name: string; enabled: true }[];
    menus: TemplateMenu[];
    protocol_response_unit: "business_days";
    protocol_response_days: number;
    business_hours: {
      days: number[];
      start: string;
      end: string;
      holidays: [];
    };
    instructions: string;
    protocol_confirmation: string;
    menu_greeting: string;
  };
  /** What stays for the administrator after applying. */
  manual_steps: string[];
}

// id, name and the help subjects of each application. The subjects feed the
// presentation messages and the no-bot fallback; the administrator edits them.
const apps = [
  [
    "pixel-goods",
    "Pixel Goods",
    "escolher imagens, pintar na tela, imprimir, usar o Maker, criar imagens e recuperar uma compra",
  ],
  [
    "quall-studio",
    "Quall Studio",
    "conectar dispositivos na rede local, transmitir câmera e tela, usar com o OBS, configurar o teleprompter e controlar remotamente",
  ],
  [
    "nfse-leve",
    "NFS-e Leve",
    "acesso da empresa, vínculo com o contador, configuração operacional, emissão e mensagens de erro",
  ],
  [
    "printher",
    "Printher",
    "modelo de impressora, tipo de conexão, comunicação, testes de impressão, tamanho do papel, logo e rodapé",
  ],
  [
    "wabotia",
    "Wabotia",
    "canais, bots, filas, protocolos, notificações, conexão com o Hermes e integrações com Fagoo e Vinki",
  ],
  [
    "fagoo-erp",
    "Fagoo ERP",
    "cadastros, uso dos módulos, integrações, acesso pelos bots e questões do ambiente instalado",
  ],
  [
    "vinki",
    "Vinki",
    "retirada de senha, painéis, chamadas, impressão, WhatsApp e continuidade do atendimento no Fagoo",
  ],
] as const;
const serverSubjects =
  "Cloudflare, Supabase, VPS, Hermes, Meta e problemas que atravessam mais de um aplicativo";

const item = (
  id: string,
  label: string,
  type: string,
  parent: string | null,
  extra: Partial<TemplateMenu> = {},
): TemplateMenu => ({
  id: "central-menu-" + id,
  label,
  type,
  parent_id: parent ? "central-menu-" + parent : null,
  enabled: true,
  ...extra,
});
const noBot = (subject: string, subjects: string) =>
  `Ajuda com ${subject}\n\nPodemos orientar sobre: ${subjects}.\n\nDescreva sua dúvida em uma mensagem: o que você quer fazer, o que tentou e o que aconteceu.\n\nSe preferir registrar o pedido para a equipe analisar, envie PROTOCOLO. O protocolo é gratuito.`;
const hire =
  "Para contratar ou pedir uma proposta, envie VOLTAR e escolha Falar com a equipe.";
const free =
  "A ajuda gratuita e o protocolo gratuito continuam disponíveis sem contratar nada.";

const centralAplicativos: ServiceTemplate = {
  id: "central-aplicativos",
  name: "Central de aplicativos",
  description:
    "Central única para vários aplicativos, com quatro modalidades de atendimento: ajuda gratuita, suporte avulso, implantação e treinamento, plano mensal.",
  summary:
    "4 setores, 9 categorias de protocolo, menu com 6 opções principais e primeira resposta em 3 dias úteis (segunda a sexta, 09:00–18:00).",
  settings: {
    departments: [
      ["suporte", "Suporte e protocolos"],
      ["contratos", "Clientes com contrato"],
      ["comercial", "Comercial e serviços"],
      ["compras", "Compras e licenças"],
    ].map(([id, name]) => ({
      id: "central-setor-" + id,
      name,
      members: [],
      enabled: true,
    })),
    ticket_categories: [
      ...apps,
      ["servidor", "Servidor ou integração"],
      ["outro", "Outro ou não sei"],
    ].map(([id, name]) => ({ id: "central-cat-" + id, name, enabled: true })),
    protocol_response_unit: "business_days",
    protocol_response_days: 3,
    business_hours: {
      days: [1, 2, 3, 4, 5],
      start: "09:00",
      end: "18:00",
      holidays: [],
    },
    instructions: [
      "Você atende a central de suporte dos aplicativos Pixel Goods, Quall Studio, NFS-e Leve, Printher, Wabotia, Fagoo ERP e Vinki, e também dúvidas de servidor ou integração.",
      "Aproveite o que a pessoa já disse e não peça de novo o que ela informou.",
      "Identifique o aplicativo e o objetivo antes de orientar; se faltar um dos dois, faça uma pergunta curta.",
      "Dê uma orientação curta, em passos, com no máximo um vídeo e um artigo.",
      "Depois de orientar, confirme se resolveu.",
      "Faça no máximo duas tentativas; se não resolver, ofereça abrir um protocolo gratuito para a equipe analisar.",
      "Nunca exija a contratação de um serviço para registrar um problema: suporte avulso, implantação e treinamento e plano mensal são opcionais.",
      "Compra não reconhecida vai direto para protocolo, sem tentativa de solução na conversa.",
      "Relatar um defeito e pedir a análise dele é sempre gratuito.",
      "Quando houver uma falha conhecida do aplicativo, diga isso, informe a alternativa disponível e não repita tutoriais que não resolvem o caso.",
      "Se a pessoa disser protocolo, atendente ou que já tentou a orientação, ofereça logo os próximos caminhos: abrir protocolo gratuito, conhecer o suporte avulso ou continuar com você.",
      "Ao encaminhar para a equipe ou abrir protocolo, resuma o que a pessoa quer fazer, o ambiente, o problema e o impacto, o que já foi tentado e as evidências.",
      "Peça que senhas e tokens sejam ocultados nas imagens e nunca solicite esses dados.",
    ].join(" "),
    protocol_confirmation: defaultProtocolConfirmation,
    menu_greeting:
      "Olá! Sou o assistente virtual da nossa central de atendimento.\n\nPosso ajudar com orientações, vídeos e documentação dos nossos aplicativos.\n\nVocê também pode escrever o nome do aplicativo e o que precisa. Para registrar uma solicitação para a equipe analisar, envie PROTOCOLO.\n\nComo posso ajudar?",
    menus: [
      item("ajuda", "Ajuda gratuita", "submenu", null),
      ...apps.map(([id, name, subjects]) =>
        item("ajuda-" + id, name, "bot", "ajuda", {
          bot_id: null,
          fallback_content: noBot(name, subjects),
        }),
      ),
      // Labels stay within 20 characters so "N. label" fits a 24-character
      // WhatsApp list row; the category keeps the full name.
      item("ajuda-servidor", "Servidor/integração", "bot", "ajuda", {
        bot_id: null,
        fallback_content: noBot("servidor ou integração", serverSubjects),
      }),
      item("ajuda-outro", "Não sei qual app", "bot", "ajuda", {
        bot_id: null,
        fallback_content:
          "Tudo bem não saber qual é o aplicativo.\n\nDescreva sua dúvida em uma mensagem: o que você quer fazer e o que aparece na tela.\n\nSe preferir registrar o pedido para a equipe analisar, envie PROTOCOLO. O protocolo é gratuito.",
      }),
      item("ajuda-protocolo", "Abrir protocolo", "ticket", "ajuda", {
        content:
          "Descreva em uma mensagem o que você precisa: qual aplicativo, o que tentou fazer e o que aconteceu. O protocolo é gratuito.",
      }),
      item("protocolos", "Meus protocolos", "protocols", null),
      item("contrato", "Já tenho contrato", "human", null, {
        department_id: "central-setor-contratos",
      }),
      item("servicos", "Contratar serviços", "submenu", null),
      item("servicos-avulso", "Suporte avulso", "content", "servicos", {
        content: `Suporte avulso\n\nAtendimento humano agendado, com tempo reservado para uma necessidade específica: tirar dúvidas, analisar uma situação ou fazer uma configuração pontual.\n\nAntes de contratar, você fica sabendo:\n- o objetivo do atendimento;\n- o aplicativo, a instalação ou a integração incluídos;\n- a duração reservada;\n- o formato: WhatsApp, chamada, compartilhamento de tela ou acesso remoto;\n- a entrega: orientação, diagnóstico ou configuração combinada;\n- como funciona se for preciso continuar além do tempo contratado.\n\nO atendimento pode terminar em um diagnóstico quando a solução depender de atualização do aplicativo, de um fornecedor externo ou de trabalho adicional.\n\nValor e duração são informados pela equipe antes da contratação.\n\n${free}\n\n${hire}`,
      }),
      item(
        "servicos-implantacao",
        "Implantação e treino",
        "content",
        "servicos",
        {
          content: `Implantação e treinamento\n\nInstalação, configuração, validação do funcionamento e treinamento, contratados como um projeto com começo, entrega e conclusão.\n\nEtapas:\n1. Levantamento: entender o uso pretendido, os sistemas e o ambiente.\n2. Preparação: organizar contas, acessos e requisitos.\n3. Instalação e configuração: colocar em funcionamento o que foi previsto.\n4. Validação: executar os testes combinados.\n5. Treinamento e passagem: ensinar o uso e documentar o que foi instalado.\n\nA proposta diz quais integrações, dispositivos e fluxos serão entregues e inclui um período de acompanhamento depois da implantação, com duração e cobertura definidas.\n\nEscopo, prazo e valor são combinados com a equipe antes de começar.\n\n${free}\n\n${hire}`,
        },
      ),
      item("servicos-plano", "Plano mensal", "content", "servicos", {
        content: `Plano mensal\n\nAtendimento contínuo para os sistemas cobertos, em duas modalidades:\n\n- Suporte mensal: atendimento humano recorrente, orientação, diagnóstico e acompanhamento dos chamados.\n- Suporte e administração: o suporte mensal mais a execução das rotinas técnicas combinadas para a infraestrutura, como atualizações, monitoramento, backups e testes de restauração.\n\nO plano define os aplicativos e instalações atendidos, as pessoas autorizadas a pedir suporte, o horário de atendimento, o prazo de primeira resposta e a quantidade de horas ou sessões incluídas.\n\nAs contas dos fornecedores ficam em nome do cliente. A proposta separa o valor do serviço dos consumos e assinaturas pagos por você.\n\nQuem já tem plano usa a opção Já tenho contrato do menu principal.\n\nValores e condições são informados pela equipe antes da contratação.\n\n${free}\n\n${hire}`,
      }),
      item("servicos-equipe", "Falar com a equipe", "human", "servicos", {
        department_id: "central-setor-comercial",
      }),
      item("compras", "Compras e licenças", "submenu", null),
      item("compras-recursos", "Recursos pagos", "content", "compras", {
        content:
          "Recursos pagos\n\n- Pixel Goods Maker: R$ 19,90 em pagamento único para liberar a criação de imagens.\n- Printher: R$ 19,90 em pagamento único para colocar logo e retirar o rodapé.\n\nA compra é feita dentro do próprio aplicativo, onde aparecem o valor vigente e o que ela libera.\n\nSe tiver dúvida sobre um recurso antes de comprar, envie MENU, escolha Ajuda gratuita e informe o aplicativo.\n\nSe já comprou e o recurso não foi liberado, envie VOLTAR e escolha Ativar ou restaurar.",
      }),
      item("compras-ativar", "Ativar ou restaurar", "content", "compras", {
        content:
          "Ativar ou restaurar compra\n\nSe você já comprou e o recurso não aparece:\n1. Confira se entrou no aplicativo com a mesma conta usada na compra.\n2. Procure no aplicativo a opção de restaurar compras ou de ativar a licença.\n3. Feche o aplicativo e abra de novo.\n\nSe continuar sem acesso, envie VOLTAR e escolha Problema com compra para abrir um protocolo gratuito. Tenha em mãos a data da compra e o comprovante. Ao enviar imagens, oculte senhas e tokens.",
      }),
      item("compras-problema", "Problema com compra", "ticket", "compras", {
        content:
          "Descreva em uma mensagem o problema com o pagamento ou a liberação: qual aplicativo, a data da compra e o que aparece para você. O protocolo é gratuito. Ao enviar imagens, oculte senhas e tokens.",
      }),
      item("apps", "Conhecer aplicativos", "submenu", null),
      ...apps.map(([id, name, subjects]) =>
        item("apps-" + id, name, "content", "apps", {
          content: `${name}\n\nNesta central você encontra ajuda com: ${subjects}.\n\nPara tirar uma dúvida agora, envie MENU, escolha Ajuda gratuita e depois ${name}. Você também pode escrever direto o que precisa.\n\nSe precisar de análise da equipe, envie PROTOCOLO. O protocolo é gratuito.\n\nPara acompanhamento individual ou implantação, envie MENU e escolha Contratar serviços.`,
        }),
      ),
    ],
  },
  manual_steps: [
    "Vínculo entre cliente e contrato ou plano: “Já tenho contrato” encaminha para uma fila humana; a identificação é feita pela equipe.",
    "Base de conhecimento, vídeos e artigos: cadastre em Conhecimento.",
    "Aviso fora da janela de 24 horas: depende de um modelo de mensagem aprovado no WhatsApp, enviado pela Integração Zernio. Sem ele, o andamento chega quando o cliente escrever de novo.",
    "Preços, escopo e duração dos serviços pagos: edite os textos do submenu “Contratar serviços”.",
  ],
};

export const serviceTemplates: ServiceTemplate[] = [centralAplicativos];
export function listServiceTemplates() {
  return serviceTemplates;
}

type Groups = Record<
  "departments" | "categories" | "menus" | "settings",
  string[]
>;
const groups = (): Groups => ({
  departments: [],
  categories: [],
  menus: [],
  settings: [],
});
const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

export async function applyServiceTemplate(
  env: Env,
  actor: Actor,
  profile: string,
  data: any,
  requestId: string,
) {
  admin(actor);
  const template = serviceTemplates.find((entry) => entry.id === data.id);
  if (!template)
    throw new ApiError(404, "not_found", "Modelo de central não encontrado.");
  const mode = data.mode ?? "merge";
  requireValue(
    mode === "merge" || mode === "replace",
    "Modo inválido: use merge ou replace.",
  );
  const cfg = await settings(env, profile);
  const wanted = template.settings;

  // Bot of the "bot" destinations: the one informed, else the attendant of
  // the area, else the first enabled bot. Without any, they become messages.
  let bot: any = null;
  if (data.bot_id !== undefined && data.bot_id !== null && data.bot_id !== "") {
    bot =
      typeof data.bot_id === "string"
        ? await one(
            env,
            "SELECT id,name,enabled FROM bots WHERE id=? AND profile_id=?",
            data.bot_id,
            profile,
          )
        : null;
    requireValue(bot, "Bot não pertence à área de atendimento.");
  } else
    bot =
      (cfg.attendant_bot &&
        (await one(
          env,
          "SELECT id,name,enabled FROM bots WHERE id=? AND profile_id=?",
          cfg.attendant_bot,
          profile,
        ))) ||
      (await one(
        env,
        "SELECT id,name,enabled FROM bots WHERE profile_id=? AND enabled=1 ORDER BY rowid LIMIT 1",
        profile,
      ));
  const menus = wanted.menus.map((source) => {
    const menu: Record<string, any> = { ...source };
    delete menu.fallback_content;
    if (source.type !== "bot") return menu;
    if (bot) return { ...menu, bot_id: bot.id };
    delete menu.bot_id;
    return { ...menu, type: "content", content: source.fallback_content };
  });

  const created = groups(),
    kept = groups(),
    replaced = groups(),
    removed = groups(),
    skipped = groups();
  const changes: Record<string, any> = {};
  const current = {
    departments: Array.isArray(cfg.departments) ? cfg.departments : [],
    categories: Array.isArray(cfg.ticket_categories)
      ? cfg.ticket_categories
      : [],
    menus: Array.isArray(cfg.menus) ? cfg.menus : [],
  };
  const has = (list: any[], id: string) => list.some((x) => x?.id === id);
  const hours = businessHours(cfg.business_hours);
  const deadline = {
    protocol_response_unit: wanted.protocol_response_unit,
    protocol_response_days: wanted.protocol_response_days,
    // Holidays are the administrator's calendar, not template content.
    business_hours: { ...wanted.business_hours, holidays: hours.holidays },
  };
  const deadlineFields = Object.keys(deadline);

  if (mode === "merge") {
    // Only adds what is missing, compared by id. Existing items are untouched.
    changes.departments = [...current.departments];
    for (const department of wanted.departments)
      if (has(current.departments, department.id))
        kept.departments.push(department.id);
      else {
        changes.departments.push(department);
        created.departments.push(department.id);
      }
    changes.ticket_categories = [...current.categories];
    for (const category of wanted.ticket_categories)
      if (has(current.categories, category.id))
        kept.categories.push(category.id);
      else {
        changes.ticket_categories.push(category);
        created.categories.push(category.id);
      }
    changes.menus = [...current.menus];
    for (const menu of menus) {
      if (has(current.menus, menu.id)) {
        kept.menus.push(menu.id);
        continue;
      }
      // A branch whose parent id was reused for something else is left out.
      const parent = menu.parent_id
        ? changes.menus.find((x: any) => x?.id === menu.parent_id)
        : null;
      if (menu.parent_id && parent?.type !== "submenu") {
        skipped.menus.push(menu.id);
        continue;
      }
      changes.menus.push(menu);
      created.menus.push(menu.id);
    }
    // Texts and deadlines are written only while still at the default.
    const untouchedDeadline =
      cfg.protocol_response_unit === defaults.protocol_response_unit &&
      Number(cfg.protocol_response_hours) ===
        defaults.protocol_response_hours &&
      cfg.protocol_response_days === defaults.protocol_response_days &&
      sameJson(
        { ...hours, holidays: [] },
        businessHours(defaults.business_hours),
      );
    if (untouchedDeadline) {
      Object.assign(changes, deadline);
      created.settings.push(...deadlineFields);
    } else kept.settings.push(...deadlineFields);
    if (!String(cfg.instructions || "").trim()) {
      changes.instructions = wanted.instructions;
      created.settings.push("instructions");
    } else kept.settings.push("instructions");
    if (
      cfg.protocol_confirmation === defaults.protocol_confirmation &&
      wanted.protocol_confirmation !== defaults.protocol_confirmation
    ) {
      changes.protocol_confirmation = wanted.protocol_confirmation;
      created.settings.push("protocol_confirmation");
    } else kept.settings.push("protocol_confirmation");
    if (!String(cfg.menu_greeting || "").trim()) {
      changes.menu_greeting = wanted.menu_greeting;
      created.settings.push("menu_greeting");
    } else kept.settings.push("menu_greeting");
  } else {
    // Replaces the lists and texts. People already placed in a department of
    // the template stay there: membership is not template content.
    changes.departments = wanted.departments.map((department) => ({
      ...department,
      members:
        current.departments.find((x: any) => x?.id === department.id)
          ?.members || [],
    }));
    changes.ticket_categories = wanted.ticket_categories;
    changes.menus = menus;
    Object.assign(changes, deadline, {
      instructions: wanted.instructions,
      protocol_confirmation: wanted.protocol_confirmation,
      menu_greeting: wanted.menu_greeting,
    });
    for (const [group, next, before] of [
      ["departments", changes.departments, current.departments],
      ["categories", changes.ticket_categories, current.categories],
      ["menus", changes.menus, current.menus],
    ] as const) {
      for (const entry of next)
        (has(before, entry.id) ? replaced : created)[group].push(entry.id);
      for (const entry of before)
        if (!has(next, entry?.id)) removed[group].push(String(entry?.id));
    }
    for (const field of [
      ...deadlineFields,
      "instructions",
      "protocol_confirmation",
      "menu_greeting",
    ])
      (sameJson(cfg[field], changes[field]) ? kept : replaced).settings.push(
        field,
      );
  }

  // Same validation and write as PUT /settings (hierarchy, departments, lines).
  // Applying a template never touches conversations: those of a removed
  // department stay marked with it for the administrator to reassign.
  const saved = await perform(
    env,
    actor,
    profile,
    "settings",
    { ...changes, keep_department_conversations: true },
    requestId,
  );

  // What the administrator still has to do by hand.
  const pending: Record<string, string>[] = [];
  for (const department of wanted.departments) {
    const now = (saved.departments || []).find(
      (x: any) => x.id === department.id,
    );
    if (now && !(now.members || []).length)
      pending.push({
        code: "department_members",
        department_id: now.id,
        message: `Adicione pessoas ao setor ${now.name} em Menus e ações → Setores de atendimento.`,
      });
  }
  if (!bot)
    pending.push({
      code: "bot_missing",
      message:
        "Nenhum bot disponível: as opções de Ajuda gratuita foram criadas como mensagens informativas. Conecte e habilite um bot e aplique o modelo de novo no modo Substituir, ou edite essas opções em Menus e ações.",
    });
  else if (!bot.enabled)
    pending.push({
      code: "bot_disabled",
      bot_id: bot.id,
      message: `Habilite o bot ${bot.name} para que as opções de Ajuda gratuita apareçam no menu.`,
    });
  if (!saved.attendant_bot)
    pending.push({
      code: "attendant_bot",
      message:
        "Sem Bot Atendente, a primeira mensagem do cliente abre o menu principal e o texto seguinte fora do menu vai para a equipe. Para um bot responder a essas mensagens, escolha o Bot Atendente em Automação → Atendente e especialistas.",
    });
  if (
    !(await one(
      env,
      "SELECT id FROM connections WHERE profile_id=? AND kind IN ('zernio','qr','hermes-whatsapp') LIMIT 1",
      profile,
    ))
  )
    pending.push({
      code: "connect_whatsapp",
      message: "Conecte um telefone do WhatsApp em Telefones.",
    });
  if (
    !(await one(env, "SELECT enabled FROM profiles WHERE id=?", profile))
      ?.enabled
  )
    pending.push({
      code: "activate",
      message:
        "Ative o atendimento automático quando terminar de revisar a configuração.",
    });
  if (skipped.menus.length)
    pending.push({
      code: "menu_conflict",
      message:
        "Algumas opções não foram criadas porque o item pai, com o mesmo ID do modelo, existe e não é um submenu. Ajuste o item em Menus e ações e aplique o modelo de novo.",
    });
  pending.push(
    {
      code: "review_texts",
      message:
        "Revise os textos das mensagens informativas em Menus e ações, principalmente preços, escopo e duração em Contratar serviços e a apresentação de cada aplicativo.",
    },
    {
      code: "knowledge",
      message:
        "Cadastre a base de conhecimento, os vídeos e os artigos em Conhecimento.",
    },
  );
  if (!(saved.notifications?.enabled && saved.notifications?.template_name))
    pending.push({
      code: "notification_template",
      message:
        "Fora da janela de 24 horas, o andamento de um protocolo fica na fila até o cliente escrever de novo. Para avisar antes disso, é preciso um modelo de mensagem aprovado no WhatsApp, enviado pela Integração Zernio.",
    });
  pending.push({
    code: "contract_identification",
    message:
      "“Já tenho contrato” encaminha para a fila do setor Clientes com contrato; a identificação do contrato ou plano é feita pela equipe.",
  });
  return {
    template_id: template.id,
    mode,
    bot_id: bot?.id || null,
    created,
    kept,
    replaced,
    removed,
    skipped,
    pending,
  };
}
