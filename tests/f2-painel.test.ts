import { afterEach, describe, expect, it, vi } from 'vitest';
import { ERP_MANAGEMENT_ITEMS } from '../src/modules/erp/panel-menu';
import { ERP_MODULE_IDS, erpRequirement } from '../src/erp/parts';
import { ERP_PREFERENCE_PARTS, erpPreferenceRequirement } from '../src/erp/parts-requirements';
import { ERP_PART_OWNERS, requirementOf, requirementsEnabled } from '../web/erp/modules';
import { setErpModuleContext, targetEnabled } from '../web/erp/blocks';
import { MANAGEMENT_ITEMS, managementContext, managementEntryState, managementLanding, resolveManagement } from '../web/management/registry';
import { portedTargetState } from '../web/management/ported-policy';
import { loadAuthorizedPorted } from '../web/erp/ErpArea';

const all = Object.fromEntries(ERP_MODULE_IDS.map(id => [id, true]));
const context = (modules: Record<string, boolean>, role='admin', access: string[] | null=null) => managementContext({ statusLoaded:true, modules, role, access });
afterEach(() => setErpModuleContext(null));

describe('A5: nove partes na mesma casa', () => {
  it('classifica cada part e cada exceção pelo ID, mantendo os requisitos completos', () => {
    const exceptions: Record<string, [string,string,string[]]> = {
      'erp.overview':['sistema','erp',[]],
      'erp.sales-dashboard':['vendas','erp-vendas',[]],
      'erp.customers-dashboard':['vendas','erp-vendas',[]],
      'erp.abc-curve':['vendas','erp-vendas',[]],
      'erp.goals':['vendas','erp-vendas',[]],
      'erp.order-margin':['vendas','erp-vendas',['erp-compras','erp-estoque']],
      'erp.products-dashboard':['estoque','erp-estoque',[]],
      'erp.payment-methods':['cadastro','erp',[]],
      'erp.purchase-suggestions':['compras','erp-compras',['erp-estoque']],
      'erp.receiving-checkin':['fiscal','erp-fiscal',['erp-estoque']],
      'erp.grouped-billing':['financeiro','erp-financeiro',[]],
    };
    for(const [id,[part,module,requires]] of Object.entries(exceptions)) {
      const item=ERP_MANAGEMENT_ITEMS.find(item=>item.id===id);
      expect(item,id).toBeDefined();expect(item?.part,id).toBe(part);expect(item?.module,id).toBe(module);
      expect([...(item?.requires??[])].sort(),id).toEqual([...requires].sort());
    }
    expect(new Set(ERP_MANAGEMENT_ITEMS.map(item=>item.module))).toEqual(new Set(ERP_MODULE_IDS));
    for(const item of ERP_MANAGEMENT_ITEMS) {
      expect(item.module,item.id).toBe(ERP_PART_OWNERS[item.part]);
      const resolved=requirementOf(item.target.to);expect(resolved,item.id).not.toBeNull();
      const expected=erpRequirement(item.module,...(item.requires??[]));
      expect(new Set(resolved?.requirement.all),item.id).toEqual(new Set(expected.all));
      for(const id of expected.all)expect(requirementsEnabled(resolved!.requirement,{...all,[id]:false}),`${item.id}/${id}`).toBe(false);
    }
    const renamed=ERP_MANAGEMENT_ITEMS.map(item=>({...item,label:'Texto traduzido'}));
    expect(resolveManagement(renamed,context(all),true).map(item=>item.id)).toEqual(resolveManagement(ERP_MANAGEMENT_ITEMS,context(all),true).map(item=>item.id));
  });

  it('abre Clientes com Base, visão geral com outras partes e destinos nativos isolados', () => {
    const base=context({erp:true}),baseItems=resolveManagement(MANAGEMENT_ITEMS,base,true);
    expect(managementLanding(baseItems)).toBe('/app/erp/cadastros-reais?cadastro=contacts');
    expect(baseItems.every(item=>item.module==='erp')).toBe(true);
    expect(managementLanding(resolveManagement(MANAGEMENT_ITEMS,context(all),true))).toBe('/app/erp/visao-geral');
    const native=resolveManagement(MANAGEMENT_ITEMS,context({os:true,juridico:true}),true);
    expect(native.length).toBeGreaterThan(0);expect(native.every(item=>item.target.kind==='native')).toBe(true);
    expect(managementLanding(native)).toBeTruthy();
    expect(managementEntryState(context({}),[])).toBe('empty');
    expect(resolveManagement(MANAGEMENT_ITEMS,{...base,statusLoaded:false},true)).toEqual([]);
  });

  it('nega URL direta e importação suspensas antes do import e do prefetch', () => {
    const c=context({erp:true});
    for(const target of ['/documentos-empresa?tipo=sales_orders','/cadastros-reais?cadastro=products','/preferencias/importacoes/produtos','/financeiro-empresa?area=remessas','/frente-caixa-empresa']) {
      const state=portedTargetState(target,c,true);expect(state,target).toBe('disabled');
      const load=vi.fn(),prefetch=vi.fn();expect(loadAuthorizedPorted(state,load,prefetch)).toBeNull();expect(load).not.toHaveBeenCalled();expect(prefetch).not.toHaveBeenCalled();
    }
    for(const state of ['disabled','loading','denied','unavailable','not-found'] as const) {
      const load=vi.fn(),prefetch=vi.fn();loadAuthorizedPorted(state,load,prefetch);expect(load).not.toHaveBeenCalled();expect(prefetch).not.toHaveBeenCalled();
    }
    expect(portedTargetState('/cadastros-reais?cadastro=desconhecido',c,true)).toBe('not-found');
    expect(portedTargetState('/manutencao-efeitos',c,true)).toBe('allowed');
    expect(portedTargetState('/financeiro-empresa',context(all,'member',['erp:vendas']),true)).toBe('denied');
  });

  it('respeita dependências e não transforma uma chave em permissão', () => {
    setErpModuleContext({...all,'erp-estoque':false});
    expect(targetEnabled('/meu-negocio?painel=margem-pedido')).toBe(false);
    expect(targetEnabled('/meu-negocio?painel=previsao-estoque')).toBe(false);
    expect(targetEnabled('/checkin-recebimentos')).toBe(false);
    expect(targetEnabled('/painel-produtos-empresa?painel=sugestao')).toBe(false);
    expect(targetEnabled('/frente-caixa-empresa')).toBe(false);
    expect(targetEnabled('/documentos-empresa?tipo=sales_orders')).toBe(true);
    expect(targetEnabled('/documentos-empresa?tipo=sales_orders&acao=xml')).toBe(true);
    setErpModuleContext({...all,'erp-fiscal':false});
    expect(targetEnabled('/documentos-empresa?tipo=sales_orders&acao=xml')).toBe(false);
    for(const [page,owner] of Object.entries(ERP_PREFERENCE_PARTS)) {
      const requirement=erpPreferenceRequirement(page)!;
      expect(requirement.all).toContain(owner);expect(requirementsEnabled(requirement,{...all,[owner]:false}),page).toBe(false);
    }
  });
});
