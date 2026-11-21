// Leva H, lane plataforma (PRF-287, NFE-187, NFE-222): a Central de ajuda do Brufap, numa rota interna (/ajuda), mantida no
// repositório. Descreve só o que o Brufap faz hoje. Os links oficiais (Portal da NF-e, IBGE) complementam os temas fiscais;
// o manual do Origin não é usado como instrução, porque as telas e os comportamentos diferem.
export interface HelpLink { label: string; to?: string; href?: string }
export interface HelpSection { title: string; paragraphs: readonly string[]; links?: readonly HelpLink[] }
export interface HelpTopic { slug: string; title: string; summary: string; sections: readonly HelpSection[] }

export const OFFICIAL_LINKS = {
  portalNfe: { label: 'Portal Nacional da NF-e', href: 'https://www.nfe.fazenda.gov.br/portal/principal.aspx' },
  nfeDocs: { label: 'Portal da NF-e › Documentos (manuais, notas técnicas e tabelas)', href: 'https://www.nfe.fazenda.gov.br/portal/listaSubMenu.aspx?Id=04BIflQt1aY=' },
  cfop: { label: 'Portal da NF-e › Diversos (tabela de CFOP e demais tabelas)', href: 'https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=/NJarYc9nus=' },
  concla: { label: 'IBGE/CONCLA › CNAE', href: 'https://concla.ibge.gov.br/' },
} as const satisfies Record<string, HelpLink>;

export const HELP_TOPICS: readonly HelpTopic[] = [
  { slug: 'primeiros-passos', title: 'Primeiros passos', summary: 'Como entrar, encontrar as telas e o que cada perfil pode fazer.', sections: [
    { title: 'Entrar e sair', paragraphs: [
      'Entre com o e-mail e a senha do convite. Esqueceu a senha? Use "Esqueci minha senha" na tela de acesso: o e-mail de recuperação abre a página de definir uma senha nova.',
      'Se a empresa exigir o segundo fator, o ERP pede o código do aplicativo autenticador depois da senha. Perdeu o celular? O administrador redefine o seu segundo fator em Preferências › Sistema › Usuários.',
    ], links: [{ label: 'Minha conta e segurança', to: '/empresa-configuracoes' }] },
    { title: 'Encontrar uma tela', paragraphs: [
      'O menu do topo reúne as telas em Meu negócio, Cadastros, Vendas, Serviços, Compras e estoque, Financeiro, Fiscal e Mais. A busca "Pesquisar" encontra qualquer tela pelo nome.',
      'O ícone de engrenagem abre as Preferências. O menu do usuário traz Dados da empresa, Consultar gestão de ações e Armazenamento.',
    ] },
    { title: 'Perfis', paragraphs: [
      'Administrador vê e altera tudo. Consulta lê cadastros, documentos, estoque, finanças e notas, sem alterar. Vendas, Financeiro, Estoque e Fiscal alteram só o próprio módulo.',
      'As permissões gravadas em Preferências › Sistema › Usuários valem no servidor e no banco, não só na tela: uma ação recusada mostra o motivo.',
    ], links: [{ label: 'Usuários e permissões', to: '/preferencias/sistema/usuarios' }] },
  ] },
  // Vinki: o tópico 'convivencia' (Convivência com o Origin) saiu; a convivência com o Bling é de um componente externo (PLANO-FAGOO.md, item 17).
  // Vinki: sem a comparação com o Origin (item 17); a emissão com valor fiscal vai para um emissor externo, ainda não ligado.
  { slug: 'notas-fiscais', title: 'Manual de notas fiscais', summary: 'As notas do ERP, a emissão por um emissor externo e as notas recebidas.', sections: [
    { title: 'As notas do ERP', paragraphs: [
      'As notas fiscais de saída, as NFC-e e as notas de entrada ficam no ERP, ligadas aos pedidos, ao estoque e ao financeiro. Você pode prepará-las a partir de um pedido, importando o XML ou à mão.',
      'A emissão com valor fiscal (assinatura, envio à SEFAZ e DANFE) será feita por um emissor externo, que ainda não está ligado a esta instalação. Até lá, as notas preparadas aqui não têm valor fiscal e não aparecem nos relatórios de produção.',
    ], links: [{ label: 'Notas fiscais de saída', to: '/historico-fiscal?modelo=55' }, { label: 'Notas de entrada', to: '/notas-entrada' }] },
    { title: 'Situações e o card da página inicial', paragraphs: [
      'O card "Notas Fiscais" da página inicial conta as notas autorizadas e as notas recebidas desde a sua última visualização. Rascunhos não entram.',
    ] },
    { title: 'Parâmetros', paragraphs: [
      'Série, numeração, natureza padrão e textos ficam em Preferências › Notas fiscais. O certificado digital e a conexão com a SEFAZ passam a ser do emissor externo.',
    ], links: [{ label: 'Parâmetros de nota fiscal', to: '/preferencias/notas-fiscais/nfe' }, { label: 'Naturezas de operação', to: '/naturezas-operacao' }] },
    { title: 'Referências oficiais', paragraphs: ['O leiaute, as regras de validação e as tabelas da NF-e são os publicados no Portal Nacional da NF-e.'],
      links: [OFFICIAL_LINKS.portalNfe, OFFICIAL_LINKS.nfeDocs] },
  ] },
  { slug: 'naturezas-operacao', title: 'Manual de operações fiscais', summary: 'Como as naturezas de operação definem CFOP e tributação das notas do ERP.', sections: [
    { title: 'O que é uma natureza', paragraphs: [
      'A natureza de operação descreve a operação da nota (venda, devolução, remessa) e guarda as regras que preenchem CFOP, situação tributária e alíquotas dos itens.',
      'Cada nota usa a natureza escolhida ou a padrão das preferências. Alterar uma natureza não muda notas já gravadas.',
    ], links: [{ label: 'Naturezas de operação', to: '/naturezas-operacao' }] },
    { title: 'Regras e revisão', paragraphs: [
      'As regras tributárias ficam para a revisão do contador antes de qualquer emissão em produção. Enquanto isso, as notas do ERP seguem em homologação.',
      'O CFOP deve existir na tabela oficial vigente; a escolha entre operação interna (5xxx), interestadual (6xxx) e exterior (7xxx) depende da UF do destinatário.',
    ], links: [{ label: 'Parâmetros de operações fiscais', to: '/preferencias/notas-fiscais/nfe' }, OFFICIAL_LINKS.cfop] },
  ] },
  { slug: 'exportacao', title: 'Backup e exportação dos dados', summary: 'O pacote ZIP com os dados da empresa e o que fica de fora.', sections: [
    { title: 'Gerar e baixar', paragraphs: [
      'Em Preferências › Backup e Exportação › Backup, o administrador pede a exportação. O servidor gera o pacote em segundo plano; acompanhe em Consultar gestão de ações.',
      'O pacote fica 7 dias numa área privada. Cada download gera um link novo, válido por 2 minutos, só para o administrador.',
    ], links: [{ label: 'Backup', to: '/preferencias/backup/exportacao' }, { label: 'Consultar gestão de ações', to: '/preferencias/sistema/gestao-acoes' }] },
    { title: 'O que vem no pacote', paragraphs: [
      'Um arquivo JSON por tabela da empresa (cadastros, documentos, finanças, estoque, notas, empresa, preferências, frente de caixa, preços, anexos, atividades, cobrança e cópia sincronizada do sistema de origem), os arquivos anexados e o manifesto.json com a data, o escopo e o que ficou de fora.',
      'Ficam de fora credenciais, tokens, o cofre do certificado A1 e os usuários do login. Arquivos que passariam do limite de 50 MB do pacote são listados no manifesto.',
    ] },
  ] },
];
export const helpTopic = (slug: string | undefined) => HELP_TOPICS.find(topic => topic.slug === slug) ?? null;
export const HELP_ROOT = '/ajuda';
export const helpHref = (slug: string) => `${HELP_ROOT}/${slug}`;
export const isHelpPath = (pathname: string) => pathname === HELP_ROOT || pathname.startsWith(`${HELP_ROOT}/`);
