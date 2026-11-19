/** Preferências and Sistema routes of this lane (migrations 115-118), wired into the Worker as a single module:
 * - /v1/preferencias/:pagina (GET, POST) and /v1/preferencias/comandos/:id (GET): company and user preferences (115);
 * - /v1/preferencias-listas/:lista (GET, POST) and /v1/preferencias-listas/comandos/:id (GET): list preferences (116);
 * - /v1/usuarios, /v1/usuarios/:id, /v1/usuarios/convites and /v1/usuarios/comandos/:id: Sistema > Usuários (117);
 * - /v1/registro-atividades and /v1/gerenciador-arquivos: Registro de atividades and Gerenciador de arquivos (118);
 * - /v1/meu-negocio/<painel> and /v1/meu-negocio/metas: Meu Negócio dashboards and Metas (150);
 * - /v1/sistema/*: Meu perfil, armazenamento, notificações, dados da empresa e segurança dos usuários (151);
 * - /v1/importacoes/*: Importações de Dados por planilha and Consultar gestão de ações (228).
 * Strict routes, closed DTOs from packages/erp-domain and bounded I/O; every RPC runs through executeRoute. */
import { HOME_CHARTS, TOP_PRODUCT_ROLES } from '../../../packages/erp-domain/src/system-profile.mjs';
import { responseParts, responsePartsMetadata, erpRequirementMet } from './preferences-kit.mjs';
import { erpPreferenceFieldRequirement, erpPreferenceRequirement, erpEntityRequirement } from '../../../../parts-requirements.ts';
import { storedFields } from '../../../packages/erp-domain/src/preferences/core.mjs';
import{PREFERENCES_BASE,PREFERENCES_MAX_BYTES,PREFERENCES_BODY_BYTES,capturePreferencesSave,parsePreferencesPage,parsePreferencesResult,PreferencesContractError}from'../../../packages/erp-domain/src/preferences/dto.mjs';
import{storedPreferencePage}from'../../../packages/erp-domain/src/preferences/catalog.mjs';
import{LIST_PREFERENCES_BASE,LIST_PREFERENCES_BODY_BYTES,captureListPreferencesSave,parseListPreferences,parseListPreferencesResult,listPreferenceId,ListPreferencesContractError}from'../../../packages/erp-domain/src/list-preferences.mjs';
import{PreferencesError,fail,need,uuid,freezeRoute,readJsonBody,baseChecks,getWithoutBody,executeRoute}from'./preferences-kit.mjs';
import{usersRouter}from'./access-users.mjs';
import{activityRouter,filesRouter}from'./activity.mjs';
import{businessRouter}from'./business.mjs';
import{systemRouter}from'./system.mjs';
import{importRouter}from'./spreadsheet-import.mjs';
import{BUSINESS_MAX_BYTES}from'../../../packages/erp-domain/src/business-dashboards.mjs';
export function systemPartsResponse(router,route,args,raw) {
 const parts=responseParts(raw,badParts);
 if(!Object.hasOwn(raw,'unavailable_parts'))return router.result(route,args,raw);
 const {unavailable_parts,...value}=structuredClone(raw);
 if(['charts','charts-save'].includes(route.action)) {
  const allowed=HOME_CHARTS.filter(key=>key!=='top_skus'||TOP_PRODUCT_ROLES.includes(value.role));
  const visible=key=>key==='resumo'||erpRequirementMet(parts,erpEntityRequirement('sales_orders'));
  const expected=allowed.filter(visible);
  if(!Array.isArray(value.available)||JSON.stringify(value.available)!==JSON.stringify(expected)||!Array.isArray(value.charts)||value.charts.some(k=>!expected.includes(k)))badParts();
  value.available=allowed;
  let input=route.input;
  if(route.action==='charts-save') {
   const charts=value.receipt?.charts;
   if(!Array.isArray(charts)||charts.some(k=>!HOME_CHARTS.includes(k))||new Set(charts).size!==charts.length
    ||JSON.stringify(charts.filter(visible))!==JSON.stringify(input.charts.filter(visible)))badParts();
   input={...input,charts};
  }
  const parsed=router.result({...route,input},args,value);
  return {...parsed,available:expected,...responsePartsMetadata(raw)};
 }
 return {...router.result(route,args,value),...responsePartsMetadata(raw)};
}

const badParts=()=>fail(502,'ERP_UPSTREAM_INVALID_RESPONSE');
function expandPage(raw,pageId,receipt=null) {
 const parts=responseParts(raw,badParts),page=storedPreferencePage(pageId);
 if(!page||!erpRequirementMet(parts,erpPreferenceRequirement(pageId)))badParts();
 const fields=storedFields(page),visible=f=>{const r=erpPreferenceFieldRequirement(pageId,f.key);return r&&erpRequirementMet(parts,r);};
 const shown=fields.filter(visible);
 if(!Array.isArray(raw.items)||raw.items.length!==shown.length||raw.items.some((item,i)=>item?.key!==shown[i].key))badParts();
 const {unavailable_parts,...value}=structuredClone(raw);
 value.items=fields.map(field=>{
  if(visible(field))return raw.items.find(item=>item.key===field.key);
  const change=receipt?.changes?.find(c=>c.key===field.key);
  return {key:field.key,value:change?change.after:field.default,version:change?change.to_version:0,updated_at:change?receipt.changed_at:null};
 });
 if(!shown.some(f=>f.kind==='users')&&fields.some(f=>f.kind==='users')&&raw.can_manage){if(raw.directory!==null)badParts();value.directory=[];}
 if(raw.situations?.some(s=>!erpRequirementMet(parts,erpEntityRequirement(s.kind))))badParts();
 return {value,shown,parts};
}
export function preferencesPageResponse(raw,pageId) {
 responseParts(raw,badParts);
 if(!Object.hasOwn(raw,'unavailable_parts'))return parsePreferencesPage(raw,pageId);
 const {value,shown}=expandPage(raw,pageId),parsed=parsePreferencesPage(value,pageId);
 return {...parsed,items:parsed.items.filter(item=>shown.some(f=>f.key===item.key)),directory:raw.directory,...responsePartsMetadata(raw)};
}
export function preferencesResultResponse(raw,options) {
 responseParts(raw?.page,badParts);
 if(!Object.hasOwn(raw.page,'unavailable_parts')&&!Object.hasOwn(raw,'unavailable_parts'))return parsePreferencesResult(raw,options);
 const {value,parts:pageParts}=expandPage(raw.page,raw.receipt?.page,raw.receipt);
 const parts=Object.hasOwn(raw,'unavailable_parts')?responseParts(raw,badParts):pageParts;
 const sent=options.input?capturePreferencesSave(options.input,raw.receipt.page):null;
 const changes=sent?.changes.filter(c=>erpRequirementMet(parts,erpPreferenceFieldRequirement(raw.receipt.page,c.key))||raw.receipt?.changes?.some(change=>change.key===c.key));
 const input=sent?{...sent,changes}:null;
 // A request consisting only of unchanged hidden fields has an empty receipt, without incrementing field versions.
 if(raw.receipt?.changes?.length===0){
  if((sent?changes.length:!options.lookup)||options.lookup&&raw.replayed!==true||raw.scope!=='preferences_command'||raw.data_mode!=='erp_native'||typeof raw.replayed!=='boolean'||raw.receipt.command_id!==options.commandId
    ||!Object.hasOwn(raw,'unavailable_parts')||Object.keys(raw).sort().join(',')!=='data_mode,page,receipt,replayed,scope,unavailable_parts'||Object.keys(raw.receipt).sort().join(',')!=='changed_at,changes,command_id,page'
    ||!uuid(options.commandId)||(options.pageId!=null&&options.pageId!==raw.receipt.page)||typeof raw.receipt.changed_at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw.receipt.changed_at)||!Number.isFinite(Date.parse(raw.receipt.changed_at)))badParts();
  return {...raw,page:preferencesPageResponse(raw.page,raw.receipt.page)};
 }
 const parsed=parsePreferencesResult({...raw,page:value},{...options,input});
 return {...parsed,page:preferencesPageResponse(raw.page,raw.receipt.page)};
}

export{PreferencesError};
// Upper bound of any upstream answer of these routes (256 KiB); dashboards keep their long tables inside it (BUSINESS_MAX_BYTES).
export const PREFERENCES_RESPONSE_BYTES=Math.max(PREFERENCES_MAX_BYTES,BUSINESS_MAX_BYTES);
const under=(path,base)=>path===base||path.startsWith(base+'/');
const contractError=e=>e instanceof PreferencesContractError||e instanceof ListPreferencesContractError||usersRouter.contractError(e)||activityRouter.contractError(e)||businessRouter.contractError(e)||systemRouter.contractError(e)||importRouter.contractError(e);
const capture=fn=>{try{return fn();}catch(e){if(contractError(e))throw new PreferencesError(e.status,e.code);throw e;}};

const settings={base:PREFERENCES_BASE,
 methods:rest=>/^[a-z][a-z0-9-]{1,47}$/.test(rest)&&rest!=='comandos'?['GET','POST']:['GET'],
 async parse(request,rest,url){
  need(!url.search,400,'ERP_INVALID_QUERY');
  if(rest.startsWith('comandos/')){const id=rest.slice(9);need(uuid(id),404,'ERP_NOT_FOUND');getWithoutBody(request);return{action:'command',rpc:'erp_preferences_command',mutation:false,args:{p_command_id:id}};}
  const page=storedPreferencePage(rest);need(page,404,'ERP_NOT_FOUND');
  if(request.method==='GET'){getWithoutBody(request);return{action:'page',rpc:'erp_preferences_page',mutation:false,page:page.id,args:{p_page:page.id}};}
  const body=await readJsonBody(request,PREFERENCES_BODY_BYTES),sent=capture(()=>capturePreferencesSave(body,page.id));
  return{action:'save',rpc:'erp_preferences_save',mutation:true,page:page.id,input:sent,args:{p_page:page.id,p_command_id:sent.command_id,p_changes:sent.changes.map(c=>({key:c.key,expected_version:c.expected_version,value:c.value}))}};
 },
 result(route,args,result){
  if(route.action==='page')return preferencesPageResponse(result,route.page);
  if(route.action==='save')return preferencesResultResponse(result,{commandId:args.p_command_id,pageId:route.page,input:route.input});
  return preferencesResultResponse(result,{commandId:args.p_command_id,lookup:true});
 }};
const lists={base:LIST_PREFERENCES_BASE,
 methods:rest=>listPreferenceId(rest)&&rest!=='comandos'?['GET','POST']:['GET'],
 async parse(request,rest,url){
  need(!url.search,400,'ERP_INVALID_QUERY');
  if(rest.startsWith('comandos/')){const id=rest.slice(9);need(uuid(id),404,'ERP_NOT_FOUND');getWithoutBody(request);return{action:'list-command',rpc:'erp_list_preferences_command',mutation:false,args:{p_command_id:id}};}
  need(listPreferenceId(rest)&&rest!=='comandos',404,'ERP_NOT_FOUND');
  if(request.method==='GET'){getWithoutBody(request);return{action:'list',rpc:'erp_list_preferences_get',mutation:false,list:rest,args:{p_list_id:rest}};}
  const body=await readJsonBody(request,LIST_PREFERENCES_BODY_BYTES),sent=capture(()=>captureListPreferencesSave(body,rest));
  return{action:'list-save',rpc:'erp_list_preferences_save',mutation:true,list:rest,input:sent,args:{p_list_id:rest,p_command_id:sent.command_id,p_expected_version:sent.expected_version,p_columns:sent.columns,p_filters:sent.filters}};
 },
 result(route,args,result){
  if(route.action==='list')return parseListPreferences(result,route.list);
  if(route.action==='list-save')return parseListPreferencesResult(result,{commandId:args.p_command_id,listId:route.list,input:route.input});
  return parseListPreferencesResult(result,{commandId:args.p_command_id,lookup:true});
 }};
const ROUTERS=[settings,lists,usersRouter,activityRouter,filesRouter,businessRouter,systemRouter,importRouter];
const routerOf=path=>typeof path==='string'?ROUTERS.find(r=>under(path,r.base))??null:null;

export const preferencesRoute=path=>routerOf(path)!==null;
export function preferencesMethods(path){const r=routerOf(path);if(!r)return null;return path===r.base?r.root??['GET']:r.methods(path.slice(r.base.length+1));}
export async function parsePreferencesRoute(request){
 const url=baseChecks(request),path=url.pathname,r=routerOf(path);need(r,404,'ERP_NOT_FOUND');
 need(preferencesMethods(path).includes(request.method),405,'ERP_METHOD_NOT_ALLOWED');need(path!==r.base||r.root,404,'ERP_NOT_FOUND');
 const route=await r.parse(request,path===r.base?'':path.slice(r.base.length+1),url);return freezeRoute({...route,router:r.base});
}
function parse(route,args,result){
 const r=ROUTERS.find(x=>x.base===route.router);if(!r)return fail(404,'ERP_NOT_FOUND');
 try{return r===systemRouter?systemPartsResponse(r,route,args,result):r.result(route,args,result);}catch(e){if(contractError(e))throw new PreferencesError(502,'ERP_UPSTREAM_INVALID_RESPONSE');throw e;}
}
export function executePreferencesRoute(route,context){
 if(!route||typeof route!=='object')return fail(404,'ERP_NOT_FOUND');
 if(route.action==='invite')return executeRoute(route,context,(r,a,value)=>value,{extra:['authInvite','authAdmin'],invoke:async(r,args,{rpc,options,context:c})=>{
  try{return(await usersRouter.invite(r,args,{rpc,authInvite:c.authInvite,options})).value;}catch(e){if(contractError(e))throw new PreferencesError(502,'ERP_UPSTREAM_INVALID_RESPONSE');throw e;}}});
 // 229: the access controls of a user (the database command, then the Auth gate flag).
 if(route.action==='controls-save')return executeRoute(route,context,(r,a,value)=>value,{extra:['authInvite','authAdmin'],invoke:async(r,args,{rpc,options,context:c})=>{
  try{return await usersRouter.saveControls(r,args,{rpc,authAdmin:c.authAdmin,options});}catch(e){if(contractError(e))throw new PreferencesError(502,'ERP_UPSTREAM_INVALID_RESPONSE');throw e;}}});
 return executeRoute(route,context,parse,{extra:['authInvite','authAdmin']});
}
