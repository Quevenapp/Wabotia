/** Meu Negócio (migration 150): /v1/meu-negocio/<painel> (GET, read-only dashboards) and /v1/meu-negocio/metas (GET list,
 * POST one audited command) plus /v1/meu-negocio/metas/comandos/:id ("Conferir resultado"). Strict query parameters,
 * closed DTOs from packages/erp-domain; the SQL functions check the role again. */
import { responseParts, responsePartsMetadata, erpRequirementMet } from './preferences-kit.mjs';
import { erpEntityRequirement, erpOperationRequirement } from '../../../../parts-requirements.ts';
import{COST_ROLES,STOCK_ROLES,BUSINESS_BASE,BUSINESS_BODY_BYTES,BUSINESS_PANELS,BUSINESS_RPC,captureBusinessQuery,businessArgs,parseBusinessPanel,captureGoalsQuery,parseGoals,captureGoalSave,parseGoalResult,
 BusinessContractError}from'../../../packages/erp-domain/src/business-dashboards.mjs';
import{PreferencesError,need,uuid,readJsonBody,getWithoutBody}from'./preferences-kit.mjs';
export function businessResponse(raw, query) {
 const bad=()=>{throw new BusinessContractError(502,'ERP_UPSTREAM_INVALID_RESPONSE');};
 const parts=responseParts(raw,bad);
 if(!Object.hasOwn(raw,'unavailable_parts')) return parseBusinessPanel(raw,query);
 const available=requirement=>erpRequirementMet(parts,requirement);
 if(!available(erpEntityRequirement('sales_orders')) || query.panel==='margem-pedido'&&!available(erpOperationRequirement('margin')) || query.panel==='previsao-estoque'&&!available(erpOperationRequirement('forecast'))) bad();
 const costRole=COST_ROLES.includes(raw.role),stockRole=STOCK_ROLES.includes(raw.role);
 const cost=costRole&&available(erpOperationRequirement('margin')),stock=stockRole&&available(erpOperationRequirement('forecast'));
 if(raw.cost_visible!==cost||raw.stock_visible!==stock) bad();
 const {unavailable_parts,...value}=structuredClone(raw);
 // Validate absent values first, then reuse every scalar, shape, total and filter check of the original parser.
 const walk=v=>{if(!v||typeof v!=='object')return;for(const [key,entry] of Object.entries(v)){
  if(!cost&&['cost','gross_margin','gross_margin_pct','lines_without_cost','profit','margin_pct','contribution_pct'].includes(key)&&entry!==null)bad();
  if(!stock&&['stock','forecast_days'].includes(key)&&entry!==null)bad();
  if(entry&&typeof entry==='object')walk(entry);
 }};walk(value);
 value.cost_visible=costRole;value.stock_visible=stockRole;
 const restored={};
 if(!cost&&costRole&&['mensal','diario'].includes(query.panel)) for(const key of ['cost','gross_margin','lines_without_cost']) {
  if(value.indicators?.[key]!==null)bad();restored[key]=null;value.indicators[key]=key==='lines_without_cost'?0:'0.00';
 }
 const parsed=parseBusinessPanel(value,query);
 if(Object.keys(restored).length)Object.assign(parsed.indicators,restored);
 return {...parsed,cost_visible:cost,stock_visible:stock,...responsePartsMetadata(raw)};
}

const contract=fn=>{try{return fn();}catch(e){if(e instanceof BusinessContractError)throw new PreferencesError(e.status,e.code);throw e;}};
function params(url){
 const out={};for(const k of url.searchParams.keys()){need(url.searchParams.getAll(k).length===1&&/^[a-z_]{1,20}$/.test(k),400,'ERP_INVALID_QUERY');out[k]=url.searchParams.get(k);}
 return out;
}
export const businessRouter={base:BUSINESS_BASE,
 methods:rest=>rest==='metas'?['GET','POST']:['GET'],
 async parse(request,rest,url){
  if(rest.startsWith('metas/comandos/')){const id=rest.slice(15);need(uuid(id)&&!url.search,404,'ERP_NOT_FOUND');getWithoutBody(request);return{action:'goal-command',rpc:'erp_home_business_panel',mutation:false,args:{p_panel:'metas_command',p_args:{p_command_id:id}}};}
  if(rest==='metas'){
   if(request.method==='GET'){getWithoutBody(request);const q=contract(()=>captureGoalsQuery(params(url)));return{action:'goals',rpc:'erp_home_business_panel',mutation:false,query:q,args:{p_panel:'metas',p_args:{p_tab:q.tab}}};}
   need(!url.search,400,'ERP_INVALID_QUERY');const body=await readJsonBody(request,BUSINESS_BODY_BYTES),sent=contract(()=>captureGoalSave(body));
   return{action:'goal-save',rpc:'erp_home_business_panel',mutation:true,input:sent,args:{p_panel:'metas_save',p_args:{p_command_id:sent.command_id,p_goal_id:sent.goal_id,p_expected_version:sent.expected_version,p_data:{...sent.data}}}};
  }
  need(BUSINESS_PANELS.includes(rest),404,'ERP_NOT_FOUND');getWithoutBody(request);
  const q=contract(()=>captureBusinessQuery(rest,params(url)));
  // 229: every panel goes through erp_home_business_panel, which checks the Meu Negócio › Dashboard permissions first.
  return{action:'panel',rpc:'erp_home_business_panel',mutation:false,query:q,args:{p_panel:rest,p_args:businessArgs(q)}};
 },
 result(route,args,result){
  if(route.action==='panel')return businessResponse(result,route.query);
  if(route.action==='goals')return parseGoals(result,route.query);
  if(route.action==='goal-save')return parseGoalResult(result,{commandId:args.p_args.p_command_id,input:route.input});
  return parseGoalResult(result,{commandId:args.p_args.p_command_id,lookup:true});
 },
 contractError:e=>e instanceof BusinessContractError};
