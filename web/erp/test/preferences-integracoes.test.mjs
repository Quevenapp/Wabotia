// Pedido do dono (21/11): o grupo "Mais" saiu do menu superior. Os itens dele moram em Preferências:
// Sistema (Manutenção de efeitos, Registro de atividades, Consulta de exclusões) no cartão Sistema, sem repetir,
// e o cartão novo Integrações (Integrações, Receber dados do Bling e Mão dupla do Bling).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './helpers/component-recovery-harness.mjs';
import { COMPANY_PREFERENCES, resolvePreferences } from '../app/lib/origin-menu.ts';
import { setErpModuleContext } from '../blocks.ts';
import { portedTarget } from '../../management/ported-policy.ts';
import { requirementOf } from '../modules.ts';
import { ERP_MANAGEMENT_ITEMS } from '../../../src/modules/erp/panel-menu.ts';

const entriesOf = (categories, id) => categories.find(category => category.id === id)?.entries ?? [];
const tos = entries => entries.map(entry => entry.to);

test('Sistema já tem as três telas do antigo Mais › Sistema, uma vez cada', () => {
  const sistema = entriesOf(resolvePreferences({ role: 'admin', resources: [] }), 'sistema');
  for (const id of ['erp.effect-maintenance', 'erp.activity', 'erp.deletions']) {
    const to = ERP_MANAGEMENT_ITEMS.find(item => item.id === id).target.to;
    assert.equal(sistema.filter(entry => entry.to === to).length, 1, to);
  }
  // Sem duplicar: nenhum destino repetido em todas as Preferências.
  const all = COMPANY_PREFERENCES.flatMap(category => category.sections.flatMap(section => section.entries)).filter(entry => entry.to).map(entry => entry.to);
  assert.deepEqual(all.filter((to, index) => all.indexOf(to) !== index), []);
});

test('cartão Integrações: Integrações só quando o painel libera; Receber dados do Bling e Mão dupla da Base', () => {
  const card = COMPANY_PREFERENCES.find(category => category.id === 'integracoes');
  assert.equal(card.label, 'Integrações');
  assert.deepEqual(card.sections.flatMap(section => section.entries.map(entry => entry.label)), ['Integrações', 'Receber dados do Bling', 'Mão dupla do Bling']);
  assert.deepEqual(tos(entriesOf(resolvePreferences({ role: 'admin', resources: [], integrations: true }), 'integracoes')), ['/integracoes', '/receber-bling', '/receber-bling?aba=mao-dupla']);
  // Sem a liberação do painel (módulos ou papel), Integrações some e o resto fica.
  assert.deepEqual(tos(entriesOf(resolvePreferences({ role: 'vendas', resources: [] }), 'integracoes')), ['/receber-bling', '/receber-bling?aba=mao-dupla']);
  // A busca do hub de Preferências e a barra ("Buscar telas e ações") usam estas entradas.
  for (const role of ['admin', 'consulta', 'vendas', 'financeiro', 'estoque', 'fiscal'])
    assert.ok(resolvePreferences({ role, resources: [] }).flatMap(category => category.entries).some(entry => entry.label === 'Receber dados do Bling'), role);
});

test('com a Base desligada o cartão some; ligada, o endereço do cartão existe e pede só a Base', () => {
  try {
    setErpModuleContext({ erp: false });
    assert.equal(resolvePreferences({ role: 'admin', resources: [] }).some(category => category.id === 'integracoes'), false);
    setErpModuleContext({ erp: true });
    assert.ok(resolvePreferences({ role: 'admin', resources: [] }).some(category => category.id === 'integracoes'));
  } finally { setErpModuleContext(null); }
  assert.deepEqual(portedTarget('/preferencias/integracoes'), { part: 'sistema', roles: undefined, resource: undefined });
  assert.deepEqual(requirementOf('/preferencias/integracoes').requirement.all, ['erp']);
  assert.deepEqual(requirementOf('/receber-bling?aba=mao-dupla').requirement.all, ['erp']);
});

test('o hub mostra o cartão Integrações com os três destinos', async () => {
  const view = await mountComponent('PreferencesPage.tsx', { homeTo: '/acesso', initialCategory: 'integracoes', categoryHref: id => `/preferencias/${id}`, categories: resolvePreferences({ role: 'admin', resources: [], integrations: true }) });
  try {
    assert.match(view.text(), /Integrações.*Receber dados do Bling.*Mão dupla do Bling/s);
    for (const to of ['/integracoes', '/receber-bling', '/receber-bling?aba=mao-dupla', '/preferencias/integracoes', '/preferencias/sistema']) assert.ok(view.nodes().some(node => node.props.to === to), to);
    assert.doesNotMatch(view.text(), /Fagoo|Origin/);
  } finally { view.unmount(); }
});
