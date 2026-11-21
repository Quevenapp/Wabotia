import test from'node:test';import assert from'node:assert/strict';
import{parseSecurityPolicy,parseSecurityPolicyAnswer,parseMfaResetAnswer}from'../../../packages/erp-domain/src/access-security.mjs';

// Vinki: os testes da senha e do aplicativo autenticador próprios saíram com app/lib/account-security.ts; esses passos são de
// Minha conta do Vinki (núcleo). Fica o contrato da exigência do segundo fator, que continua no ERP.

test('policy and reset answers are checked exactly; the browser never receives factor ids or gates',()=>{
 const U='10000000-0000-4000-8000-000000000310',C='30000000-0000-4000-8000-000000000310',S='2026-10-21T12:00:00-03:00';
 const policy={mfa_required:false,version:0,updated_at:null,members:[{user_id:U,name:'Admin',role:'admin',factor:false}]};
 assert.equal(parseSecurityPolicy({scope:'access_security_policy',data_mode:'erp_native',policy,self:{factor:false,aal2:false}}).policy.version,0);
 assert.throws(()=>parseSecurityPolicy({scope:'access_security_policy',data_mode:'erp_native',policy:{...policy,updated_at:S},self:{factor:false,aal2:false}}),e=>e.status===502);
 const input={command_id:C,expected_version:0,mfa_required:true},answer={scope:'access_security_command',data_mode:'erp_native',receipt:{command_id:C,from_version:0,to_version:1,changed_at:S},policy:{...policy,mfa_required:true,version:1,updated_at:S},replayed:false};
 assert.equal(parseSecurityPolicyAnswer(answer,input).policy.mfa_required,true);
 assert.throws(()=>parseSecurityPolicyAnswer({...answer,gates:[]},input),e=>e.status===502);
 assert.throws(()=>parseSecurityPolicyAnswer({...answer,policy:{...answer.policy,mfa_required:false}},input),e=>e.status===502);
 const reset={scope:'access_mfa_reset',data_mode:'erp_native',command_id:C,target:U,removed:1,changed_at:S,replayed:false};
 assert.equal(parseMfaResetAnswer(reset,{commandId:C,target:U}).removed,1);
 assert.throws(()=>parseMfaResetAnswer({...reset,factors:[U]},{commandId:C,target:U}),e=>e.status===502);
});
