// Acabamento do painel do ERP: rotas, menu, papéis, textos e mensagens de erro (sem rede, sem DOM).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ORIGIN_MENU, COMPANY_PREFERENCES, resolveMenu, resolvePreferences } from './app/lib/origin-menu.ts';
import { ERP_MANAGEMENT_ITEMS } from '../../src/modules/erp/panel-menu.ts';
import { portedTarget, portedPermissionAllowed } from '../management/ported-policy.ts';
import { ROLE_RESOURCES } from '../../src/erp/role-resources.ts';
import { ERP_MODULE_IDS } from '../../src/erp/parts.ts';
import { setErpBlocks, setErpModuleContext } from './blocks.ts';
import { requirementOf } from './modules.ts';
import { setMotorReal } from './motor.ts';
import { movedTarget } from './moved-routes.ts';
import { AccessError, accessErrorText } from './app/lib/real-access.ts';
import { FINANCE_SCREENS } from './app/lib/finance-screens.ts';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const ALL = Object.fromEntries(ERP_MODULE_IDS.map(id => [id, true]));
const ADMIN = { role: 'admin', resources: ROLE_RESOURCES.admin };
const item = (menu, label) => menu.flatMap(group => [...group.columns.flatMap(column => column.items), ...(group.footer ? [group.footer] : [])]).find(entry => entry.label === label);

test('rotas: /relatorios-graficos e /manutencao-efeitos abrem pelo App; endereços antigos vão para a tela nova', () => {
  const app = read('./app/App.tsx');
  for (const route of ["'/relatorios-graficos'", "'/manutencao-efeitos'"]) assert.ok(app.includes(route), route);
  assert.equal(movedTarget('/notas-recebidas'), '/notas-recebidas-compras');
  assert.equal(movedTarget('/conexao-sefaz'), '/certificado-a1');
  // Sem motor (demonstração), as telas antigas abrem; contra o motor, vão para o emissor de notas.
  assert.equal(movedTarget('/inutilizacoes-nfe'), null);
  setMotorReal(true);
  try {
    assert.equal(movedTarget('/inutilizacoes-nfe'), '/certificado-a1');
    assert.equal(movedTarget('/cartas-correcao'), '/historico-fiscal?modelo=55');
    assert.equal(movedTarget('/numeracao-fiscal'), '/certificado-a1');
  } finally { setMotorReal(false); }
  assert.equal(movedTarget('/historico-fiscal'), null);
  // A casca confere o endereço antigo antes do destino (senão a tela sem motor pararia em "indisponível").
  assert.match(read('./mount.tsx'), /const moved = movedTarget\(location\.pathname\)/);
});

test('política: as importações que o servidor atende e as áreas novas do Financeiro têm destino', () => {
  for (const kind of ['contas-pagar', 'fiscal-produtos', 'naturezas-operacao', 'saldos-iniciais'])
    assert.ok(portedTarget(`/preferencias/importacoes/${kind}`), kind);
  assert.equal(portedTarget('/preferencias/importacoes/contas-pagar').part, 'financeiro');
  assert.equal(portedTarget('/preferencias/importacoes/fiscal-produtos').part, 'fiscal');
  assert.ok(FINANCE_SCREENS.includes('transferencias'));
  assert.deepEqual(portedTarget('/financeiro-empresa?area=transferencias').roles, ['admin', 'consulta', 'financeiro']);
});

test('menu: sem ordem repetida, todo rodapé com destino e cobrança num só caminho', () => {
  const seen = new Map();
  for (const entry of ERP_MANAGEMENT_ITEMS) {
    const key = `${entry.group}:${entry.order}`;
    assert.equal(seen.has(key), false, `${entry.id} repete a ordem de ${seen.get(key)}`);
    seen.set(key, entry.id);
  }
  for (const group of ORIGIN_MENU) if (group.footer) assert.ok(group.footer.real?.to, group.name);
  assert.equal(ORIGIN_MENU.find(group => group.name === 'Cadastros').footer.real.to, '/preferencias/sistema/relatorios-customizados');
  const ids = ERP_MANAGEMENT_ITEMS.map(entry => entry.id);
  for (const gone of ['erp.operational-billing', 'erp.operational-returns']) assert.equal(ids.includes(gone), false, gone);
  for (const added of ['erp.transfers', 'erp.recurring', 'erp.borderos', 'erp.due-dates', 'erp.finance-import']) assert.ok(ids.includes(added), added);
  // A conciliação por OFX tem uma tela só.
  assert.match(read('./app/components/FinanceScreens.tsx'), /area === 'conciliacao'\) return <Navigate to="\/conciliacao-bancaria"/);
});

test('menu: shownWithAny e o módulo Ordem de Serviço valem também no menu do ERP', () => {
  try {
    setErpModuleContext(ALL);
    assert.ok(item(resolveMenu('real', ADMIN), 'Formas de pagamento').to);
    assert.ok(item(resolveMenu('real', ADMIN), 'Relatórios de serviço').to);
    setErpModuleContext({ ...ALL, 'erp-vendas': false, 'erp-financeiro': false, 'erp-pdv': false, 'erp-estoque': false });
    const off = resolveMenu('real', ADMIN);
    assert.equal(item(off, 'Formas de pagamento')?.to, undefined, 'Formas de pagamento sem Vendas, Financeiro e PDV');
    assert.equal(item(off, 'Relatórios em gráfico')?.to, undefined, 'Relatórios em gráfico sem Vendas, Financeiro e Estoque');
    setErpModuleContext({ ...ALL, os: true });
    assert.equal(item(resolveMenu('real', ADMIN), 'Relatórios de serviço')?.to, undefined, 'some com o módulo OS ligado');
    assert.equal(ERP_MANAGEMENT_ITEMS.find(entry => entry.id === 'erp.service-reports').hidden_when_modules_enabled?.includes('os'), true);
  } finally { setErpModuleContext(null); setErpBlocks(null); }
});

test('preferências: sem rótulo de bastidor, sem nome do provedor fiscal e SPED/SINTEGRA abrindo a tela', () => {
  const entries = COMPANY_PREFERENCES.flatMap(category => category.sections.flatMap(section => section.entries));
  for (const entry of entries) {
    assert.doesNotMatch(`${entry.label} ${entry.description ?? ''}`, /·|NFapi|homologação|rascunhos|indisponível/i, entry.label);
    assert.equal(entry.disabledReason, undefined, entry.label);
  }
  const admin = resolvePreferences({ role: 'admin' }).flatMap(category => category.entries);
  for (const label of ['Gerar SPED PIS/COFINS (Contribuições)', 'Gerar SPED ICMS/IPI (Fiscal)', 'Exportar dados para o SINTEGRA'])
    assert.equal(admin.find(entry => entry.label === label)?.to, '/sped-fiscal', label);
  for (const gone of ['/conexao-sefaz', '/numeracao-fiscal', '/emissor-fiscal?modelo=55', '/emissor-fiscal?modelo=65', '/inutilizacoes-nfe', '/cartas-correcao'])
    assert.equal(admin.some(entry => entry.to === gone), false, gone);
});

test('papéis: atalhos e botões seguem o que o servidor aceita', () => {
  // Contatos (src/erp/domains/catalog/access.ts): lê tipos quem lê contatos; importa quem grava contatos.
  for (const role of Object.keys(ROLE_RESOURCES)) {
    assert.equal(portedPermissionAllowed('/tipos-contatos-empresa', role, ROLE_RESOURCES[role]), true, role);
    assert.equal(portedPermissionAllowed('/importar-contatos', role, ROLE_RESOURCES[role]), ['admin', 'vendas', 'financeiro'].includes(role), role);
  }
  // Expedição: os papéis que escrevem no painel são os WRITE_ROLES do servidor.
  const server = /const WRITE_ROLES = (\[[^\]]*\])/.exec(readFileSync(new URL('../../src/erp/domains/shipping/rpc.ts', import.meta.url), 'utf8'))[1];
  const panel = /const SHIPPING_WRITERS: readonly string\[\] = (\[[^\]]*\])/.exec(read('./Expedicao.tsx'))[1];
  assert.deepEqual(JSON.parse(panel), JSON.parse(server));
  assert.doesNotMatch(read('./Expedicao.tsx'), /access\.role [!=]== "consulta"/);
});

test('importação de XML no pedido de compra não depende do Fiscal', () => {
  assert.equal(requirementOf('/documentos-empresa?tipo=purchase_orders&acao=xml').requirement.all.includes('erp-fiscal'), false);
  assert.equal(requirementOf('/documentos-empresa?tipo=sales_orders&acao=xml').requirement.all.includes('erp-fiscal'), true);
});

test('erro de acesso diz a causa: a frase do servidor, a parte desligada, a permissão ou o dado', () => {
  assert.equal(new AccessError(400, undefined, undefined, 'O limite de crédito do cliente foi ultrapassado.').message, 'O limite de crédito do cliente foi ultrapassado.');
  assert.match(accessErrorText(409, 'module_disabled'), /Gestão › Módulos/);
  assert.match(accessErrorText(403), /papel no ERP não permite/);
  assert.match(accessErrorText(400), /dado não foi aceito ou está faltando/);
  assert.match(accessErrorText(413), /tamanho aceito/);
  assert.match(accessErrorText(503), /o ERP não respondeu/);
  for (const status of [400, 403, 404, 409, 413, 429]) assert.doesNotMatch(accessErrorText(status), /Não foi possível concluir a operação/, String(status));
  // A recusa lê a mensagem só se for frase para gente, e com parte desligada diz quais partes ligar.
  const source = read('./app/lib/real-access.ts');
  assert.match(source, /screenSentence\(value\?\.message\)/);
  assert.match(source, /partsOffText\(options\.method \|\| 'GET', path\)/);
});
