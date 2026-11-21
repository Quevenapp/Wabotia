import { originHistoryAvailable, isOriginIntegrationRoute } from './integration-capabilities.ts';
// Access-controlled destinations consumed by the FAGOO workspace navigation.

import { preferencePage, preferencePageHref } from '../../../../packages/erp-domain/src/preferences/catalog.mjs';
import { blockOf, currentErpModules, ERP_BLOCK_LABELS, hiddenInWabotia, targetEnabled } from '../../blocks.ts';

import { ORIGIN_MENU } from '../../../../src/modules/erp/panel-menu.ts';
import type { CompanyRole, MenuGroupName, MenuItemDefinition, RealTarget } from '../../../../src/modules/erp/panel-menu.ts';
export { ORIGIN_MENU } from '../../../../src/modules/erp/panel-menu.ts';
export type { MenuGroupName, CompanyRole, RealTarget, MenuItemDefinition, MenuColumnDefinition, MenuGroupDefinition } from '../../../../src/modules/erp/panel-menu.ts';

const FINANCE: readonly CompanyRole[] = ['admin', 'consulta', 'financeiro'];
const FISCAL_READ: readonly CompanyRole[] = ['admin', 'consulta', 'fiscal'];

// Preferências, as in Origin (gear → Preferências): categories in Origin order with Origin's groups ("Configurações de …",
// "Tabelas e configurações adicionais", "Planilhas modelo") and items in Origin order. Logística is out of scope and omitted.
// A page or screen Brufap does not have yet stays listed and disabled with the reason; Brufap's own tools sit in the extra
// group "Ferramentas do Brufap" of their category, so no previous entry became unreachable. Each settings page has its
// schema in packages/erp-domain/src/preferences (roles of the page = roles of the module it configures).
// "host": tela do painel fora do roteador do ERP (Integrações); aparece só quando o painel diz que ela abre (CompanyAccess.integrations).
export interface PreferenceEntry { label: string; to?: string; roles?: readonly CompanyRole[]; description?: string; disabledReason?: string; host?: 'integrations' }
export interface PreferenceSection { title: string; entries: readonly PreferenceEntry[] }
export interface PreferenceCategory { id: string; label: string; icon: string; notice?: { title: string; text: string }; sections: readonly PreferenceSection[] }

const page = (id: string): PreferenceEntry => {
  const schema = preferencePage(id);
  if (!schema) throw new Error(`PREFERENCE_PAGE_MISSING ${id}`);
  return { label: schema.title, to: preferencePageHref(schema), roles: schema.readRoles };
};
const ADMIN: readonly CompanyRole[] = ['admin'];
// Readers of the product cadastros (erp_access.resources_for_role 'products'): the product taxonomy screens follow them.
const PRODUCT_READERS: readonly CompanyRole[] = ['admin', 'consulta', 'vendas', 'estoque', 'fiscal'];
// Tags of Produtos and of Contatos (migration 153): whoever reads products or contacts.
const TAG_READERS: readonly CompanyRole[] = ['admin', 'consulta', 'vendas', 'financeiro', 'estoque', 'fiscal'];
const TOOLS = 'Ferramentas do ERP';

export const COMPANY_PREFERENCES: readonly PreferenceCategory[] = [
  { id: 'empresa', label: 'Empresa', icon: 'building', sections: [
    { title: 'Configurações da empresa', entries: [page('empresa-geral')] },
    { title: 'Tabelas e configurações adicionais', entries: [{ label: 'Alterar dados da empresa', to: '/empresa-configuracoes', description: 'Cadastro fiscal e dados gerais da empresa.' }] },
  ] },
  { id: 'sistema', label: 'Sistema', icon: 'desktop', sections: [
    { title: 'Manutenção da instalação', entries: [{label:'Atualizações do sistema',to:'/preferencias/sistema/atualizacoes',roles:ADMIN,description:'Versão instalada, novas versões e atualização completa da sua instalação.'},{label:'Vinki',to:'/preferencias/sistema/wabotia',roles:ADMIN,description:'Conectar atendimento e bots por código, sem copiar credenciais.'}] },
    { title: 'Configurações do sistema', entries: [page('sistema-interface')] },
    { title: 'Tabelas e configurações adicionais', entries: [
      { label: 'Manutenção de efeitos', to: '/manutencao-efeitos', description: 'Consultar e desfazer efeitos históricos com as permissões e confirmações originais.' },
      { label: 'Consulta de exclusões realizadas', to: '/preferencias/sistema/consulta-exclusoes', roles: ADMIN }, { label: 'Gerenciador de arquivos', to: '/preferencias/sistema/gerenciador-arquivos', roles: ADMIN }, { label: 'Relatórios customizados', to: '/preferencias/sistema/relatorios-customizados', description: 'Relatórios padrão e os customizados liberados para você.' },
      { label: 'Etiquetas customizadas', to: '/preferencias/sistema/etiquetas-customizadas', roles: ADMIN }, { label: 'Registro de atividades', to: '/preferencias/sistema/registro-atividades', roles: ADMIN }, { label: 'Permissões no ERP', to: '/preferencias/sistema/usuarios', roles: ADMIN },
      { label: 'Gerenciador de transições', to: '/preferencias/sistema/gerenciador-transicoes', roles: ADMIN, description: 'Situações personalizadas e transições de pedidos de venda, de compra e ordens de serviço.' }, { label: 'Campos customizados', to: '/campos-customizados', roles: PRODUCT_READERS, description: 'Campos próprios do cadastro de produtos, por categoria (aba Produtos).' },
    ] },
  ] },
  { id: 'cadastros', label: 'Cadastros', icon: 'address-book', sections: [
    { title: 'Configurações de cadastros', entries: [page('cadastros-contatos'), page('cadastros-lotes'), page('cadastros-produtos')] },
    { title: 'Tabelas e configurações adicionais', entries: [{ label: 'Categorias de produtos', to: '/categorias-produtos', roles: PRODUCT_READERS }, { label: 'Gerenciar tipos de contatos', to: '/tipos-contatos-empresa' }] },
    // Contatos lane: Cadastros > Vendedores e Funcionários ainda sem item real no menu (o atalho do Início segue o menu).
    { title: TOOLS, entries: [{ label: 'Vendedores', to: '/vendedores-empresa', roles: ['admin', 'consulta', 'vendas', 'financeiro'], description: 'Cadastros › Vendedores: vendedores, usuário vinculado, comissionamento e descontos.' },
      { label: 'Funcionários', to: '/funcionarios-empresa', roles: ADMIN, description: 'Cadastros › Funcionários: dados cadastrais, contato e endereço.' }] },
  ] },
  { id: 'suprimentos', label: 'Suprimentos', icon: 'boxes-stacked', sections: [
    { title: 'Configurações de suprimentos', entries: [page('suprimentos-estoque'), page('suprimentos-compras')] },
    { title: 'Tabelas e configurações adicionais', entries: [{ label: 'Gerenciar grupos de tags', to: '/grupos-tags', roles: TAG_READERS }, { label: 'Gerenciar tags', to: '/tags', roles: TAG_READERS },
      { label: 'Depósitos de estoque', to: '/cadastros-reais?cadastro=warehouses', roles: ['admin', 'consulta', 'estoque'], description: 'Depósito padrão e "Desconsiderar saldo deste depósito".' }, { label: 'Grupos de produtos', to: '/grupos-produtos', roles: PRODUCT_READERS }] },
    { title: TOOLS, entries: [{ label: 'Estoque negativo', to: '/estoque-abertura', roles: ADMIN, description: 'Política "Permitir estoque negativo" para baixas, transferências e estornos.' }] },
  ] },
  { id: 'vendas', label: 'Vendas', icon: 'users', sections: [
    { title: 'Configurações de vendas', entries: [page('vendas-frente-caixa'), page('vendas-propostas'), page('vendas-vendas')] },
  ] },
  { id: 'notas-fiscais', label: 'Notas Fiscais', icon: 'file-invoice', notice: { title: 'Importante', text: 'Antes de alterar as configurações entre em contato com o seu contador.' }, sections: [
    { title: 'Configurações de notas fiscais', entries: [page('notas-nfce'), page('notas-nfe')] },
    { title: 'Tabelas e configurações adicionais', entries: [
      // Vinki: inutilização e carta de correção vão pelo emissor de notas (as consultas antigas não têm motor).
      { label: 'Inutilizar numeração de NF-e e NFC-e', to: '/certificado-a1', roles: ['admin', 'fiscal'], description: 'No emissor de notas, em Inutilizações: a faixa de números pulados, com a justificativa.' },
      { label: 'Cartas de correção de NF-e', to: '/historico-fiscal?modelo=55', roles: ['admin', 'fiscal'], description: 'Abra a nota autorizada em Notas fiscais de saída e use Carta de correção.' },
      { label: 'Naturezas de operação', to: '/naturezas-operacao', roles: FISCAL_READ, description: 'Naturezas com regras de ICMS, IPI, PIS, COFINS e II, padrões e configurações globais de impostos.' },
      { label: 'Contador e envio dos arquivos fiscais', to: '/contador-fiscal?aba=contador', roles: FISCAL_READ, description: 'Nome, e-mail e WhatsApp do contador, envio automático do pacote do mês e anexo do Simples de cada natureza.' },
    ] },
    // Vinki: rascunhos, séries e a conexão com a SEFAZ são feitos pelo emissor de notas (certificado no cofre).
    { title: TOOLS, entries: [
      { label: 'Emissor de notas', to: '/certificado-a1', roles: ['admin', 'fiscal'], description: 'Certificado, ambiente, série e numeração, teste de conexão com a SEFAZ e inutilizações.' },
    ] },
  ] },
  { id: 'certificado', label: 'Certificado Digital', icon: 'certificate', sections: [
    { title: 'Configurações do certificado digital', entries: [page('certificado-digital')] },
    { title: TOOLS, entries: [{ label: 'Emissor de notas', to: '/certificado-a1', roles: ['admin', 'fiscal'], description: 'O certificado A1 e a senha ficam guardados no emissor de notas, que assina e transmite as notas.' }] },
  ] },
  { id: 'financas', label: 'Finanças', icon: 'dollar-sign', sections: [
    { title: 'Configurações de finanças', entries: [page('financas-pagar'), page('financas-receber')] },
    { title: 'Tabelas e configurações adicionais', entries: [{ label: 'Importação de registros financeiros', to: '/financeiro-empresa?area=importacao', roles: FINANCE },
      { label: 'Gerenciar categorias de receita e despesa', to: '/financeiro-empresa?area=categories', roles: FINANCE },
      { label: 'Gerenciar contas financeiras', to: '/financeiro-empresa?area=contas-financeiras', roles: FINANCE },
      { label: 'Gerenciar formas de pagamento', to: '/formas-pagamento-empresa', roles: FINANCE }, { label: 'Controle de caixa', to: '/financeiro-empresa?area=controle-caixa', roles: FINANCE }] },
    { title: TOOLS, entries: [
      { label: 'Cobrança bancária', to: '/cobranca-empresa', roles: FINANCE, description: 'Contratos de cobrança com o banco, carteira e numeração dos boletos.' },
      { label: 'Remessas e retornos', to: '/financeiro-empresa?area=remessas', roles: FINANCE, description: 'Gerar remessas, importar retornos e baixar os títulos pagos.' },
      { label: 'Relatório de vencimentos', to: '/relatorio-vencimentos', roles: FINANCE },
      { label: 'Ficha financeira', to: '/financeiro-empresa?area=ficha', roles: FINANCE },
    ] },
  ] },
  { id: 'servicos', label: 'Serviços', icon: 'screwdriver-wrench', sections: [
    { title: 'Configurações de serviços', entries: [page('servicos-os')] },
  ] },
  // Vinki: a categoria Integrações (telas do Origin) saiu; a migração do Bling é um componente à parte (PLANO-FAGOO.md, item 17).
  // Pedido do dono (21/11): o grupo "Mais" saiu do menu superior; as telas de integração do Vinki moram neste cartão.
  { id: 'integracoes', label: 'Integrações', icon: 'link', sections: [
    { title: 'Integrações', entries: [
      { label: 'Integrações', to: '/integracoes', host: 'integrations', description: 'Pedidos, mesas, agenda e os outros módulos da área ligados ao ERP: o que entra no financeiro e no estoque.' },
      { label: 'Receber dados do Bling', to: '/receber-bling', description: 'Trazer do Bling os cadastros, pedidos, contas e notas, conferir e passar a operar aqui.' },
      { label: 'Mão dupla do Bling', to: '/receber-bling?aba=mao-dupla', description: 'Depois de passar a operar aqui: manter o ERP e o Bling iguais, com um interruptor por tipo de registro.' },
    ] },
  ] },
  { id: 'contabilidade', label: 'Contabilidade', icon: 'calculator', sections: [
    { title: 'Configurações de contabilidade', entries: [page('contabilidade-contador')] },
  ] },
  { id: 'importacoes', label: 'Importações de Dados', icon: 'file-import', sections: [
    // 228: the spreadsheet import framework; 265 adds composições, campos customizados, lista de preços and fornecedores de produto.
    // In the order of the Origin hub: Produtos (produtos, composições, Campos Customizados, Lista de Preços), Contatos, Suprimentos
    // (pedidos de compra, movimentações de estoque em massa, fornecedores de produto), Fiscal, Finanças and Vendas.
    { title: 'Planilhas modelo', entries: [{ label: 'Importar e atualizar produtos', to: '/preferencias/importacoes/produtos', roles: ADMIN, description: 'Inclui produtos e atualiza os já cadastrados pelo Código.' },
      { label: 'Importar composições', to: '/preferencias/importacoes/composicoes', roles: ADMIN, description: 'A estrutura das composições, um componente por linha.' },
      { label: 'Importar campos customizados', to: '/preferencias/importacoes/campos-customizados', roles: ADMIN, description: 'Os valores dos campos customizados dos produtos, pelo nome do campo.' },
      { label: 'Importar lista de preços', to: '/listas-precos', roles: ADMIN, description: 'Em Cadastros › Listas de preços: abra a lista, Inserir produtos e a planilha modelo (código e preço).' },
      // 300: Lotes (Origin: Produtos › Lotes), the lots of the products with Controle de lote.
      { label: 'Importar lotes', to: '/preferencias/importacoes/lotes', roles: ADMIN, description: 'Inclui lotes nos produtos com Controle de lote e atualiza as datas e a Obs. dos já cadastrados.' },
      { label: 'Importar e atualizar contatos', to: '/preferencias/importacoes/contatos', roles: ADMIN, description: 'Inclui contatos e atualiza os já cadastrados pelo CPF/CNPJ.' },
      { label: 'Importar pedidos de compra', to: '/preferencias/importacoes/pedidos-compra', roles: ADMIN }, { label: 'Importar movimentações de estoque em massa', to: '/preferencias/importacoes/movimentacoes-estoque', roles: ADMIN },
      { label: 'Importar fornecedores de produto', to: '/preferencias/importacoes/fornecedores-produtos', roles: ADMIN, description: 'Inclui ou atualiza os fornecedores de cada produto.' },
      { label: 'Importar notas fiscais em Lote', to: '/preferencias/importacoes/notas-fiscais', roles: ADMIN, description: 'Notas de saída a conferir antes de emitir, uma por número da planilha.' }, { label: 'Importar contas a receber', to: '/preferencias/importacoes/contas-receber', roles: ADMIN, description: 'Contas em aberto, sem baixa.' },
      { label: 'Importar contas a pagar', to: '/preferencias/importacoes/contas-pagar', roles: ADMIN, description: 'Contas em aberto, sem baixa.' },
      { label: 'Importar vendas', to: '/preferencias/importacoes/vendas', roles: ADMIN, description: 'Pedidos de venda em aberto, sem lançar estoque nem contas.' },
      // Vinki (versão 28): a planilha fiscal dos produtos, as naturezas com as regras fiscais e os saldos iniciais das contas.
      { label: 'Importar dados fiscais dos produtos', to: '/preferencias/importacoes/fiscal-produtos', roles: ADMIN, description: 'NCM, CEST, origem e os impostos de cada produto por natureza, com prévia do que muda.' },
      { label: 'Importar naturezas de operação e regras fiscais', to: '/preferencias/importacoes/naturezas-operacao', roles: ADMIN, description: 'Inclui ou atualiza naturezas e regras; trocar a natureza padrão pede confirmação.' },
      { label: 'Importar saldos iniciais das contas financeiras', to: '/preferencias/importacoes/saldos-iniciais', roles: ADMIN, description: 'O saldo de cada conta num dia, lançado como no Financeiro.' }] },
    { title: TOOLS, entries: [
      { label: 'Importar contatos (somente inclusão)', to: '/importar-contatos', roles: ['admin', 'vendas', 'financeiro'], description: 'Tela de Clientes e fornecedores que inclui contatos sem atualizar os existentes.' },
    ] },
  ] },
  { id: 'backup', label: 'Backup e Exportação de Dados', icon: 'database', sections: [
    { title: 'Backup e exportação', entries: [{ label: 'Backup', to: '/preferencias/backup/exportacao', roles: ADMIN, description: 'Pacote ZIP com os dados e os arquivos da empresa, gerado no servidor.' },
      // Vinki: SPED e SINTEGRA ficam em Fiscal › SPED e SINTEGRA (/sped-fiscal), com a conferência antes de gerar.
      { label: 'Gerar SPED PIS/COFINS (Contribuições)', to: '/sped-fiscal', roles: FISCAL_READ, description: 'Em SPED e SINTEGRA: o arquivo do mês, com a conferência dos cadastros antes de gerar.' },
      { label: 'Gerar SPED ICMS/IPI (Fiscal)', to: '/sped-fiscal', roles: FISCAL_READ, description: 'Em SPED e SINTEGRA: o arquivo do mês, com a conferência dos cadastros antes de gerar.' },
      { label: 'Exportar dados para o SINTEGRA', to: '/sped-fiscal', roles: FISCAL_READ, description: 'Em SPED e SINTEGRA: o arquivo do mês, com a conferência dos cadastros antes de gerar.' }] },
  ] },
];

// integrations: o painel liberou a tela Integrações (integrationRouteState === 'allowed'); sem painel, ela não aparece.
export interface CompanyAccess { role?: string; resources?: readonly string[]; capabilities?: { originIntegration?: boolean; originHistory?: boolean }; integrations?: boolean }

export function realTargetAllowed(target: RealTarget | undefined, access: CompanyAccess): target is RealTarget {
  if (!target || !access.role) return false;
  // Vinki: item de um bloco desligado na área (Fiscal, Cobrança, PDV, Origin) some do menu.
  if (!targetEnabled(target.to)) return false;
  if (isOriginIntegrationRoute(target.to) && !originHistoryAvailable(access)) return false;
  if (target.resource && !(access.resources || []).includes(target.resource)) return false;
  // Os mesmos filtros do menu de gestão (web/management/registry.ts): shownWithAny e hidden_when_modules_enabled.
  const modules = currentErpModules();
  if (target.shownWithAny && !target.shownWithAny.some(id => modules[id] === true)) return false;
  if (target.hiddenWith?.some(id => modules[id] === true)) return false;
  return !target.roles || target.roles.includes(access.role as CompanyRole);
}

export type ResolvedItem = { label: string; to?: string; disabled: boolean };
export type ResolvedColumn = { title: string; items: ResolvedItem[] };
export type ResolvedGroup = { name: MenuGroupName; columns: ResolvedColumn[]; footer?: ResolvedItem };

// Groups and columns without accessible destinations are hidden.
export function resolveMenu(area: 'real', access: CompanyAccess = {}): ResolvedGroup[] {
  const resolve = (item: MenuItemDefinition): ResolvedItem => {
    const to = realTargetAllowed(item.real, access) ? item.real.to : undefined;
    return { label: item.label, to, disabled: !to };
  };
  return ORIGIN_MENU.map(group => {
    const columns = group.columns.map(column => ({ title: column.title, items: column.items.map(resolve) })).filter(column => column.items.some(item => !item.disabled));
    const footer = group.footer ? resolve(group.footer) : undefined;
    return { name: group.name, columns, ...(footer && !footer.disabled ? { footer } : {}) };
  }).filter(group => group.columns.length > 0);
}

export type ResolvedPreferenceCategory = { id: string; label: string; icon: string; notice?: { title: string; text: string }; sections: { title: string; entries: PreferenceEntry[] }[]; entries: LinkedPreferenceEntry[] };
export type LinkedPreferenceEntry = PreferenceEntry & { to: string };
// Entries for other roles are hidden (enabled or not); a category with nothing left is hidden. "entries" lists only the
// enabled ones (search links and breadcrumbs); sections also describe unavailable tools.
export function resolvePreferences(access: CompanyAccess): ResolvedPreferenceCategory[] {
  if (!access.role) return [];
  const mine = (entry: PreferenceEntry) => (!entry.to || !isOriginIntegrationRoute(entry.to) || originHistoryAvailable(access)) && (!entry.roles || entry.roles.includes(access.role as CompanyRole))
    && (!entry.to || (entry.host === 'integrations' ? access.integrations === true : targetEnabled(entry.to)));
  return COMPANY_PREFERENCES.map(category => {
    const sections = category.sections.map(section => ({ title: section.title, entries: section.entries.filter(mine) })).filter(section => section.entries.length > 0);
    return { id: category.id, label: category.label, icon: category.icon, ...(category.notice ? { notice: category.notice } : {}), sections, entries: sections.flatMap(section => section.entries.filter((entry): entry is LinkedPreferenceEntry => Boolean(entry.to))) };
  }).filter(category => category.sections.length > 0);
}

export function matchesLocation(to: string, pathname: string, search: string) {
  const [path, query = ''] = to.split('?');
  if (pathname !== path) return false;
  const current = new URLSearchParams(search);
  return [...new URLSearchParams(query)].every(([key, value]) => current.get(key) === value);
}

export function activeGroupFor(groups: readonly ResolvedGroup[], pathname: string, search: string): ResolvedGroup | undefined {
  return groups.find(group => group.columns.some(column => column.items.some(item => item.to && matchesLocation(item.to, pathname, search))));
}
