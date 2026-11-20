import { describe, expect, it } from "vitest";
import type { BlingContext, BlingRawRecord } from "../src/erp/bling/contracts.ts";
import { BLING_OPERATIONS, authorizeBlingOperation } from "../src/erp/bling/schema.ts";
import { normalizeErpParts } from "../src/erp/parts.ts";
import { observedDecimal, parseHistoricalPayload, projectRecord, validateCapture, coverageFromPasses, explicitOrderReference, resolveOrderReference } from "../src/erp/bling/projection.ts";
import { selectXmlCandidates, validateXmlBytes, xmlFingerprint, blingXmlObjectKey } from "../src/erp/bling/xml.ts";

const at = Date.UTC(2026,10,19,15);
const hash = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(v=>v.toString(16).padStart(2,"0")).join("");
const raw = (entity: BlingRawRecord["identity"]["entity"],payload_text: string): BlingRawRecord => ({
  identity:{profile:"area",account_id:"conta",entity,source_id:"1"},version:"1",semantic_hash:"a".repeat(64),
  payload_text,document_links:[],observed_at:new Date(at).toISOString(),source_updated_at:null,source_time_quality:"unknown",deleted:false,deletion_evidence:null,capture:null,
});
const context = (): BlingContext => ({profile:"area",origin:"app",clock:{now:()=>at},identity:{
  actor:{user_id:"pessoa",name:null,email:null,erp_role:"admin",session_id:"sessao",aal:"aal2",verified_factor:true,is_agent:true},people:[],
  parts:normalizeErpParts({sales:false,stock:false,finance:false,fiscal:false}),partsControl:{profile:"area",revision:"1",expires_at:at+600000},
}});

describe("acervo histórico do Bling no Worker",()=>{
  it("preserva números lexicais, captura vinculada e nenhuma reconciliação implícita",async({task})=>{
    const source=raw("sales_orders",'{"id":"1","total":12345678901234567890.123456789,"itens":[{"valor":4.50000000000000001,"quantidade":2,"desconto":10}]}');
    const bytes=new TextEncoder().encode(`{"data":${source.payload_text}}`);
    source.capture={revision:"1",profile:"origin-sales-price-json-v1",source:"detail",bytes_sha256:await hash(bytes),semantic_hash:source.semantic_hash,semantic_version:"1",values:[{path:"/itens/0/valor",lexeme:"4.50000000000000001"}]};
    expect(validateCapture(source,bytes)).toEqual(source.capture);
    expect(parseHistoricalPayload(source.payload_text).payload.total).toBe("12345678901234567890.123456789");
    const dto=projectRecord(source);
    expect(dto.label).toBe("Consulta histórica — não opera no ERP");
    expect(dto.fields.total_observed).toMatchObject({state:"value",value:"12345678901234567890.123456789"});
    expect(dto.fields.reconciliation).toMatchObject({state:"unknown",calculated_total:null,commercial_math_reconciled:false});
    expect(dto.coverage.complete).toBe(false);
    expect(observedDecimal(undefined).state).toBe("absent");expect(observedDecimal(null).state).toBe("null");
    expect(observedDecimal("0").value).toBe("0");expect(observedDecimal("não informado").state).toBe("invalid");
    expect(()=>parseHistoricalPayload('{"id":1,"id":2}')).toThrow();
    expect(()=>validateCapture({...source,capture:{...source.capture!,semantic_version:"2"}},bytes)).toThrow();
    task.meta.orgAcervo={lexical:true,nativeEffects:false,networkCalls:0,mutations:0};
  });

  for(const name of ["erp_bling_records_list","erp_bling_record_get","erp_bling_versions_list","erp_bling_xml_list","erp_bling_xml_get","erp_bling_purge_preview","erp_bling_purge_apply"] as const) {
    it(`${name}: bot configurado alcança a operação; sem concessão e origem externa não`,()=>{
      const ctx=context(),input={entity:"nfe",command_id:"comando"};
      ctx.authorization={bot:{id:"bot",allowed_operations:[name],allowed_entities:["nfe","nfce"],data_scopes:["public","personal","sensitive","raw","xml"],allow_sensitive:true}};
      expect(BLING_OPERATIONS[name].bot.configurable).toBe(true);
      expect(()=>authorizeBlingOperation(ctx,name,input)).not.toThrow();
      expect(()=>authorizeBlingOperation(context(),name,input)).toThrow();
      expect(()=>authorizeBlingOperation({...ctx,origin:"external"},name,input)).toThrow();
      const forbidden=context();forbidden.identity.actor!.erp_role="consulta";
      if(name.startsWith("erp_bling_purge"))expect(()=>authorizeBlingOperation(forbidden,name,input)).toThrow();
    });
  }

  it("purge de bot pode ser confirmado pela pessoa e confirmação não serve a outro comando",()=>{
    const ctx=context(),requestHash="b".repeat(64),input={command_id:"apagar-1"};
    ctx.authorization={request_hash:requestHash,bot:{id:"bot",allowed_operations:["erp_bling_purge_apply"],allowed_entities:["nfe"],data_scopes:["public"],allow_sensitive:false},confirmation:{operation:"erp_bling_purge_apply",command_id:"apagar-1",request_hash:requestHash,confirmed_by:"pessoa",expires_at:at+60000}};
    expect(()=>authorizeBlingOperation(ctx,"erp_bling_purge_apply",input)).not.toThrow();
    expect(()=>authorizeBlingOperation(ctx,"erp_bling_purge_apply",{command_id:"apagar-2"})).toThrow();
  });

  it("referência explícita respeita área e modelos; último GET não prova frescor",()=>{
    const order=raw("sales_orders",'{"notaFiscal":{"id":"1"}}'),ref=explicitOrderReference(order)!;
    const nfe=raw("nfe","{}"),nfce=raw("nfce","{}");
    expect(resolveOrderReference(ref,[nfe]).state).toBe("resolved");
    expect(resolveOrderReference(ref,[nfe,nfce]).state).toBe("ambiguous");
    expect(resolveOrderReference(ref,[{...nfe,identity:{...nfe.identity,profile:"outra"}}]).state).toBe("unresolved");
    expect(explicitOrderReference(raw("sales_orders","{}"))).toBeNull();
    expect(coverageFromPasses(["recente","histórica"],[{key:"recente",started_at:"2026-11-18T00:00:00Z",completed_at:"2026-11-19T00:00:00Z"}]).freshness_at).toBeNull();
  });

  it("fingerprint preserva precisão; validação XML saneia falhas e chave R2 isola área",async()=>{
    expect(await xmlFingerprint('{"valorNota":12345678901234567890.1,"link":"a"}',hash)).toBe(await xmlFingerprint('{"valorNota":12345678901234567890.1,"link":"b"}',hash));
    expect(await xmlFingerprint('{"valorNota":12345678901234567890.1}',hash)).not.toBe(await xmlFingerprint('{"valorNota":12345678901234567890.2}',hash));
    const marker=crypto.randomUUID(),bytes=new TextEncoder().encode(`<!DOCTYPE NFe [<!ENTITY x "${marker}">]><NFe/>`);
    let error: unknown;
    try {await validateXmlBytes({bytes,entity:"nfe",access_key:"0".repeat(44),model:"55",expected_sha256:await hash(bytes)},hash);}catch(caught){error=caught;}
    expect(error).toMatchObject({code:"BLING_RESPONSE_INVALID"});
    expect(String(error)).not.toContain(marker);
    expect(blingXmlObjectKey("area-a","a".repeat(64))).not.toBe(blingXmlObjectKey("area-b","a".repeat(64)));
    const selected=selectXmlCandidates([{entity:"nfe",source_id:"1",direction:"unknown",fingerprint:"a",last_fingerprint:null,last_checked_at:null,next_attempt_at:null,verified_manifest:false}],{now:at});
    expect(selected.items).toHaveLength(1);
  });
});
