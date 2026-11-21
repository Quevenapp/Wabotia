import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {AccessError,type AccessState,type NativeRequestOptions} from '../lib/real-access';
import {useUnsavedChanges} from '../hooks/useUnsavedChanges';
import {parseStockPolicy,parseStockPolicyResult,policyIntent,stockPolicyPath,stockPolicyCommandPath,POLICY_CONFIRMATION,openingPolicyLabel,
 type StockPolicyView,type StockPolicyInput} from '../lib/stock-opening-model';
import './stock-opening.css';

// Vinki: a adoção do saldo de abertura vindo do Origin saiu com ele (Origin fora, motor 91213b8: os opening_* saem do motor).
// /estoque-abertura fica só com a política de estoque negativo; o saldo inicial entra por Lançamentos de estoque ou pela importação.
export interface StockOpeningController{getSnapshot:()=>AccessState;subscribe:(fn:()=>void)=>()=>void;stockOpening:(path:string,options?:NativeRequestOptions)=>Promise<unknown>}
const authorized=(s:AccessState)=>s.phase==='ready'&&s.membership?.role==='admin';
const readError=(e:unknown)=>e instanceof AccessError&&[401,403].includes(e.status)?'O acesso de administrador precisa ser confirmado.':e instanceof AccessError&&e.status===409?'Os dados mudaram. Atualize e confira novamente.':'Não foi possível concluir a consulta. Tente novamente.';
const moment=(value:string)=>new Date(value).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'});
type PolicyAttempt={body:StockPolicyInput;uncertain:boolean;ack:boolean;retryAllowed:boolean};
type PolicyEdit={allow:boolean;reason:string;confirmed:boolean};

function PolicyView({controller,actor,allowed}:{controller:StockOpeningController;actor:string;allowed:boolean}){
 const alive=useRef(true),request=useRef<AbortController|null>(null),meta=useRef<AbortController|null>(null),policyAttempt=useRef<PolicyAttempt|null>(null);
 const [policy,setPolicy]=useState<StockPolicyView|null>(null),[reload,setReload]=useState(0);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[edit,setEdit]=useState<PolicyEdit|null>(null),[pending,setPending]=useState(0);
 const live=useRef({edit,policy});live.current={edit,policy};
 const may=()=>alive.current&&authorized(controller.getSnapshot())&&controller.getSnapshot().membership?.user_id===actor;
 const free=()=>may()&&!request.current;
 useUnsavedChanges(Boolean(edit),busy||Boolean(policyAttempt.current));
 const valid=(p:AbortController)=>may()&&!p.signal.aborted&&request.current===p;
 const start=()=>{const p=new AbortController();request.current=p;setBusy(true);setError('');return p;};
 const finish=(p:AbortController)=>{if(request.current===p){request.current=null;setBusy(false);}};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;request.current?.abort();meta.current?.abort();policyAttempt.current=null;};},[controller]);
 // Losing the role cancels reads but keeps an already captured command for the same administrador.
 useEffect(()=>{if(!allowed){request.current?.abort();request.current=null;meta.current?.abort();meta.current=null;setBusy(false);const a=policyAttempt.current;if(a){a.uncertain=true;a.retryAllowed=false;}else setEdit(null);}},[allowed]);
 useEffect(()=>{if(!may())return;meta.current?.abort();const p=new AbortController();meta.current=p;const ok=()=>may()&&!p.signal.aborted&&meta.current===p;void(async()=>{try{
  const v=await controller.stockOpening(stockPolicyPath(),{method:'GET',signal:p.signal});if(ok())setPolicy(parseStockPolicy(v));
 }catch(e){if(ok())setError(readError(e));}finally{if(meta.current===p)meta.current=null;}})();return()=>{p.abort();if(meta.current===p)meta.current=null;};},[controller,actor,allowed,reload]);
 // Policy switch: explicit confirmation text and reason; the server checks the version and the administrador role again.
 const runPolicy=async(a:PolicyAttempt|null,send=false)=>{if(!may()||request.current||!a||policyAttempt.current!==a||send&&a.uncertain&&!a.retryAllowed)return;const p=start();a.retryAllowed=false;let reading=false;
  try{
   if(send){const raw=await controller.stockOpening(stockPolicyPath(),{method:'POST',body:a.body,signal:p.signal});if(!valid(p)||policyAttempt.current!==a)return;parseStockPolicyResult(raw,{commandId:a.body.command_id,input:a.body});a.ack=true;}
   if(!valid(p)||policyAttempt.current!==a)return;reading=true;
   const result=parseStockPolicyResult(await controller.stockOpening(stockPolicyCommandPath(a.body.command_id),{method:'GET',signal:p.signal}),{commandId:a.body.command_id,input:a.body,lookup:true});
   if(!valid(p)||policyAttempt.current!==a)return;policyAttempt.current=null;setPending(n=>n+1);setEdit(null);
   setPolicy(v=>v&&{...v,policy:result.policy});setNotice(result.receipt.to.allow_negative?'Estoque negativo permitido a partir de agora. A alteração ficou registrada.':'Estoque negativo não permitido a partir de agora. Saldos negativos existentes foram mantidos.');setReload(n=>n+1);
  }catch(e){if(valid(p)&&policyAttempt.current===a){
   if(send&&!reading&&!a.uncertain&&!a.ack&&e instanceof AccessError&&[400,404,409].includes(e.status)){policyAttempt.current=null;setPending(n=>n+1);setEdit(null);setError(e.status===409?'A política foi alterada por outra pessoa. Atualize e confira antes de mudar.':'A alteração não foi aceita. Confira o motivo informado.');setReload(n=>n+1);}
   else{a.uncertain=true;a.retryAllowed=reading&&!a.ack&&e instanceof AccessError&&e.status===404;setPending(n=>n+1);setError(a.retryAllowed?'A consulta ainda não encontrou a alteração. Isso não comprova que nada mudou.':'Não foi possível confirmar a alteração da política. Use “Conferir resultado da política”.');}
  }}finally{finish(p);}};
 const startPolicy=(allow:boolean)=>{const v=live.current.policy;if(!free()||policyAttempt.current||!v||!v.can_manage||allow===v.policy.allow_negative&&!live.current.edit)return;
  setEdit(allow===v.policy.allow_negative?null:{allow,reason:'',confirmed:false});setNotice('');};
 const submitPolicy=()=>{const v=live.current.policy,e=live.current.edit;if(!free()||policyAttempt.current||!v||!e||!e.confirmed||e.reason.trim().length<3)return;
  let body:StockPolicyInput;try{body=policyIntent(v.policy,e.allow,e.reason,crypto.randomUUID(),true);}catch{setError('Informe o motivo e confirme o texto da alteração.');return;}
  const a:PolicyAttempt={body,uncertain:false,ack:false,retryAllowed:false};policyAttempt.current=a;setPending(n=>n+1);void runPolicy(a,true);};

 const activePolicy=policyAttempt.current;
 void pending;
 return <section className="stock-opening" aria-busy={busy}>
  <header className="real-heading"><div><h1>Estoque negativo</h1><p>Defina se as baixas de estoque podem deixar o saldo abaixo de zero. O saldo inicial entra por Lançamentos de estoque ou pela importação de movimentações em massa.</p></div><span className="real-mode">Administrador</span></header>
  {error&&<p className="real-alert" role="alert">{error}</p>}{notice&&<p className="real-success" role="status">{notice}</p>}
  {policy&&<section className="stock-opening-panel" aria-label="Política de estoque negativo"><header><h2>Permitir estoque negativo</h2><span className={`status-badge status-${policy.policy.allow_negative?'warning':'neutral'}`}>{openingPolicyLabel(policy.policy)}</span></header>
   <p>Desligada (padrão), nenhuma baixa deixa o saldo abaixo de zero. Ligada, vendas, saídas, transferências e estornos podem deixar o saldo negativo; reservas continuam exigindo saldo disponível.</p>
   {policy.can_manage&&<label className="stock-opening-switch" htmlFor="policy-switch"><input id="policy-switch" type="checkbox" role="switch" checked={edit?edit.allow:policy.policy.allow_negative} disabled={busy||Boolean(activePolicy)} onChange={e=>startPolicy(e.target.checked)}/>Permitir estoque negativo</label>}
   {edit&&!activePolicy&&<div className="stock-opening-confirm"><p><strong>{edit.allow?'Ligar a política':'Desligar a política'}</strong></p>
    <label className="stock-opening-check" htmlFor="policy-confirm"><input id="policy-confirm" type="checkbox" checked={edit.confirmed} disabled={busy} onChange={e=>{if(free()&&live.current.edit===edit)setEdit({...edit,confirmed:e.target.checked});}}/>{POLICY_CONFIRMATION[edit.allow?'enable':'disable']}</label>
    <label htmlFor="policy-reason">Motivo da alteração<input id="policy-reason" maxLength={500} value={edit.reason} disabled={busy} onChange={e=>{if(free()&&live.current.edit===edit)setEdit({...edit,reason:e.target.value});}}/></label>
    <div className="stock-opening-actions"><button type="button" className="primary-button" disabled={busy||!edit.confirmed||edit.reason.trim().length<3} onClick={submitPolicy}>Confirmar alteração da política</button><button type="button" className="secondary-button" disabled={busy} onClick={()=>{if(free())setEdit(null);}}>Cancelar alteração</button></div></div>}
   {activePolicy&&<div className="stock-opening-confirm" aria-label="Alteração da política pendente"><p>A alteração da política aguarda confirmação. Identificador: <code>{activePolicy.body.command_id}</code>.</p><div className="stock-opening-actions"><button type="button" className="primary-button" disabled={busy} onClick={()=>void runPolicy(activePolicy)}>Conferir resultado da política</button>{activePolicy.retryAllowed&&<button type="button" className="secondary-button" disabled={busy} onClick={()=>void runPolicy(activePolicy,true)}>Reenviar a mesma alteração</button>}</div></div>}
   <small>Versão {policy.policy.version}{policy.policy.updated_at?` · alterada em ${moment(policy.policy.updated_at)}`:' · configuração inicial'}</small>
  </section>}
 </section>;
}
// The route renders this screen for every role (as086): a role that never was administrador sees the refusal and sends
// nothing, while the same administrador losing the role keeps a captured command hidden until the role returns.
function Held({controller,actor,allowed}:{controller:StockOpeningController;actor:string;allowed:boolean}){const[opened,setOpened]=useState(allowed);useEffect(()=>{if(allowed)setOpened(true);},[allowed]);
 if(!opened)return <section className="real-state-panel"><h1>Estoque negativo não liberado</h1><p>Somente administradores podem alterar a política de estoque negativo.</p></section>;
 return <>{!allowed&&<p role="alert">Esta configuração exige acesso ativo de administrador. Um comando pendente do mesmo usuário permanece preservado para conferência quando o acesso voltar.</p>}{opened&&<div hidden={!allowed} inert={!allowed} aria-hidden={!allowed}><PolicyView controller={controller} actor={actor} allowed={allowed}/></div>}</>;}
export default function RealStockOpening({controller}:{controller:StockOpeningController}){const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot),identity=useRef({controller,key:0});if(identity.current.controller!==controller)identity.current={controller,key:identity.current.key+1};const actor=state.membership?.user_id;
 if(!actor||state.phase==='signed_out')return <p role="alert">Entre com acesso de administrador para alterar a política de estoque negativo.</p>;
 return <Held key={`${actor}:${identity.current.key}`} actor={actor} controller={controller} allowed={authorized(state)}/>;}
