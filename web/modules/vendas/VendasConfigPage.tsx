// Gestão → Regras e nota fiscal (módulo "vendas", administrador): chave
// "vendas" de PUT /settings (validateVendasSettings em
// src/modules/vendas/model.ts) — orçamento, formas de pagamento, limites da
// equipe, textos do comprovante — e o emitente da nota fiscal, com as
// pendências de GET /vendas/fiscal. Nenhum emissor de nota está integrado
// ainda: a tela não oferece escolher provedor.
import React, { useState } from "react";
import { Check, FileWarning } from "lucide-react";
import { useApp } from "../../app/AppContext";
import { useAction, useUnsavedGuard } from "../../app/hooks";
import type { Row } from "../../lib/api";
import { Button, Card, Field, Notice, Pill, SkeletonRows, Switch } from "../../ui";
import { useResource } from "../../admin/shared";
import { decimal, numberInput, onlineMethods, paymentLabels, paymentOrder } from "./shared";
import {
  csosnOptions,
  icmsCstOptions,
  originOptions,
  pisCofinsOptions,
  regimeOptions,
  UFS,
  withCurrent,
} from "./fiscal";
import "./vendas.css";

/** Padrões do servidor (src/modules/vendas/model.ts, FISCAL_DEFAULTS). */
const fiscalDefaults: Row = {
  regime: null,
  legal_name: "",
  ie: "",
  im: "",
  cnae: "",
  street: "",
  number: "",
  complement: "",
  district: "",
  city: "",
  city_code: "",
  uf: "",
  cep: "",
  environment: "homologacao",
  nfce_series: 1,
  nfe_series: 1,
  default_cfop: "5102",
  default_origin: 0,
  default_csosn: "102",
  default_icms_cst: "00",
  default_pis_cst: "49",
  default_cofins_cst: "49",
  provider: null,
  auto_emit: false,
};
/** Padrões do servidor (VENDAS_DEFAULTS). */
const defaults: Row = {
  quote_valid_days: 7,
  payment_methods: {
    cash: true,
    card_credit: true,
    card_debit: true,
    pix_manual: true,
    pix: false,
    link: false,
    other: false,
  },
  pix_key: "",
  max_discount_percent: 10,
  operator_can_cancel: false,
  low_stock_alert: true,
  receipt_footer: "",
  quote_intro: "",
  quote_footer: "",
};

function draftOf(saved: Row | undefined): Row {
  const v = { ...defaults, ...(saved || {}) };
  const f = { ...fiscalDefaults, ...(saved?.fiscal || {}) };
  return {
    quote_valid_days: String(v.quote_valid_days),
    payment_methods: { ...defaults.payment_methods, ...(saved?.payment_methods || {}) },
    pix_key: v.pix_key || "",
    max_discount_percent: numberInput(v.max_discount_percent),
    operator_can_cancel: !!v.operator_can_cancel,
    low_stock_alert: !!v.low_stock_alert,
    receipt_footer: v.receipt_footer || "",
    quote_intro: v.quote_intro || "",
    quote_footer: v.quote_footer || "",
    fiscal: {
      ...f,
      regime: f.regime || "",
      nfce_series: String(f.nfce_series),
      nfe_series: String(f.nfe_series),
      default_origin: String(f.default_origin),
    },
  };
}

function FiscalStatus() {
  const app = useApp();
  const resource = useResource(`${app.root}/vendas/fiscal`);
  const data: Row | null = resource.data;
  return (
    <Card
      title="Nota fiscal: situação"
      description="O que falta para emitir NFC-e e NF-e. A prévia de cada venda (Vendas e orçamentos → venda → Nota fiscal) mostra também as pendências dos produtos."
    >
      {!data ? (
        resource.error ? (
          <Notice tone="error" onRetry={() => void resource.reload()}>
            {resource.error}
          </Notice>
        ) : (
          <SkeletonRows rows={3} avatar={false} />
        )
      ) : (
        <>
          {!data.provider_configured && (
            <Notice tone="warn">
              A emissão de nota fiscal ainda não está ligada: o emissor previsto é a NFapi, com integração futura. Até
              lá, o Wabotia monta a prévia da nota de cada venda e aponta as pendências, sem emitir.
            </Notice>
          )}
          <dl className="vendas-facts">
            <dt>Emitente</dt>
            <dd>
              {data.emitter_issues.length ? (
                <Pill tone="warn">{data.emitter_issues.length} pendência(s)</Pill>
              ) : (
                <Pill tone="ok">Dados completos</Pill>
              )}
            </dd>
            <dt>Produtos ativos sem NCM</dt>
            <dd>
              {data.products.without_ncm ? (
                <Pill tone="warn">
                  {data.products.without_ncm} de {data.products.active}
                </Pill>
              ) : (
                <Pill tone="ok">Nenhum ({data.products.active} ativos)</Pill>
              )}
            </dd>
            <dt>Emissor</dt>
            <dd>{data.provider_configured ? <Pill tone="ok">Ligado</Pill> : <Pill tone="muted">Não integrado</Pill>}</dd>
          </dl>
          {data.emitter_issues.length > 0 && (
            <ul className="vendas-issues">
              {data.emitter_issues.map((issue: Row) => (
                <li key={issue.field}>{issue.message}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

function ConfigForm() {
  const app = useApp();
  const { busy, run } = useAction();
  const saved = app.settings.vendas as Row | undefined;
  const base = draftOf(saved);
  const [draft, setDraft] = useState<Row>(base);
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  useUnsavedGuard(dirty);
  const set = (key: string) => (value: any) => setDraft((current) => ({ ...current, [key]: value }));
  const setF = (key: string) => (value: any) =>
    setDraft((current) => ({ ...current, fiscal: { ...current.fiscal, [key]: value } }));
  const setMethod = (method: string, on: boolean) =>
    setDraft((current) => ({ ...current, payment_methods: { ...current.payment_methods, [method]: on } }));
  const f = draft.fiscal;
  const cobranca = app.moduleOn("payments");
  return (
    <div className="vendas-page">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(
            async () => {
              const days = Number(draft.quote_valid_days);
              if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("Validade do orçamento: de 1 a 90 dias.");
              const maxDiscount = decimal(draft.max_discount_percent || "0");
              if (maxDiscount === null || maxDiscount < 0 || maxDiscount > 100)
                throw new Error("Desconto máximo da equipe: de 0 a 100%.");
              const series = (value: string, what: string) => {
                const n = Number(value);
                if (!Number.isInteger(n) || n < 0 || n > 999) throw new Error(`${what}: inteiro de 0 a 999.`);
                return n;
              };
              await app.api(app.root + "/settings", "PUT", {
                vendas: {
                  quote_valid_days: days,
                  payment_methods: draft.payment_methods,
                  pix_key: draft.pix_key,
                  max_discount_percent: maxDiscount,
                  operator_can_cancel: draft.operator_can_cancel,
                  low_stock_alert: draft.low_stock_alert,
                  receipt_footer: draft.receipt_footer,
                  quote_intro: draft.quote_intro,
                  quote_footer: draft.quote_footer,
                  fiscal: {
                    ...f,
                    regime: f.regime || null,
                    uf: (f.uf || "").toUpperCase(),
                    nfce_series: series(f.nfce_series, "Série da NFC-e"),
                    nfe_series: series(f.nfe_series, "Série da NF-e"),
                    default_origin: Number(f.default_origin) || 0,
                    // Emissor e emissão automática: ficam como estão (nenhum integrado).
                    provider: saved?.fiscal?.provider ?? null,
                    auto_emit: !!saved?.fiscal?.auto_emit,
                  },
                },
              });
              await app.refresh();
            },
            { success: "Regras de vendas salvas." },
          );
        }}
      >
        <Card title="Orçamento" description="Validade e os textos que acompanham o orçamento enviado ao cliente.">
          <Field
            label="Validade padrão (dias)"
            type="number"
            min={1}
            max={90}
            value={draft.quote_valid_days}
            onChange={set("quote_valid_days")}
            help="Conta do envio até o fim do dia; cada orçamento pode ter a sua."
          />
          <Field label="Abertura do orçamento" type="textarea" rows={2} value={draft.quote_intro} onChange={set("quote_intro")} maxLength={300} placeholder="Ex.: Segue o orçamento que você pediu:" />
          <Field label="Rodapé do orçamento" type="textarea" rows={2} value={draft.quote_footer} onChange={set("quote_footer")} maxLength={500} placeholder="Ex.: Pagamento em até 3x no cartão. Entrega em 5 dias úteis." />
        </Card>
        <Card title="Formas de pagamento" description="Oferecidas no caixa e na conversão de orçamentos em venda.">
          {paymentOrder.map((method) => {
            const online = onlineMethods.includes(method);
            const blocked = online && !cobranca && !draft.payment_methods[method];
            return (
              <label className="vendas-toggle" key={method}>
                <Switch
                  label={paymentLabels[method]}
                  checked={!!draft.payment_methods[method]}
                  disabled={blocked}
                  onChange={(on) => setMethod(method, on)}
                />
                <span>
                  {paymentLabels[method]}
                  {online && (
                    <small className="muted">
                      {" "}
                      · pelo módulo Cobrança (Mercado Pago), enviado na conversa
                      {!cobranca ? "; ligue a Cobrança em Módulos" : ""}
                    </small>
                  )}
                </span>
              </label>
            );
          })}
          <Field
            label="Chave Pix da loja"
            value={draft.pix_key}
            onChange={set("pix_key")}
            maxLength={77}
            help="Para “Pix (chave da loja)”: aparece no comprovante; a equipe confere o recebimento."
          />
        </Card>
        <Card title="Equipe e estoque">
          <Field
            label="Desconto máximo da equipe (%)"
            value={draft.max_discount_percent}
            onChange={set("max_discount_percent")}
            help="Sobre o valor dos itens. Acima disso, só administradores. Não vale para orçamento já aprovado."
          />
          <label className="vendas-toggle">
            <Switch label="Equipe pode cancelar e devolver" checked={draft.operator_can_cancel} onChange={set("operator_can_cancel")} />
            Equipe (sem ser administrador) pode cancelar e devolver vendas
          </label>
          <label className="vendas-toggle">
            <Switch label="Aviso de estoque baixo" checked={draft.low_stock_alert} onChange={set("low_stock_alert")} />
            Avisar quando um produto chegar ao estoque mínimo
          </label>
        </Card>
        <Card title="Comprovante">
          <Field
            label="Rodapé do comprovante"
            type="textarea"
            rows={2}
            value={draft.receipt_footer}
            onChange={set("receipt_footer")}
            maxLength={300}
            placeholder="Ex.: Trocas em até 7 dias com este comprovante."
            help="Impresso no fim do comprovante não fiscal. O cabeçalho vem de Estabelecimento."
          />
        </Card>
        <Card
          title="Emitente fiscal"
          description="Dados da empresa na NF-e e na NFC-e. O CNPJ, o nome fantasia e o telefone vêm de Estabelecimento."
        >
          <div className="form-field-grid">
            <Field label="Regime tributário" value={f.regime} onChange={setF("regime")} options={regimeOptions} emptyOption="Não informado" />
            <Field label="Ambiente" value={f.environment} onChange={setF("environment")} emptyOption={null} options={[["homologacao", "Homologação (testes)"], ["producao", "Produção"]]} />
          </div>
          <Field label="Razão social" value={f.legal_name} onChange={setF("legal_name")} maxLength={60} />
          <div className="vendas-grid-3">
            <Field label="Inscrição estadual" value={f.ie} onChange={setF("ie")} maxLength={20} placeholder="Só números ou ISENTO" />
            <Field label="Inscrição municipal" value={f.im} onChange={setF("im")} maxLength={20} />
            <Field label="CNAE" value={f.cnae} onChange={setF("cnae")} maxLength={9} placeholder="7 dígitos" />
          </div>
          <div className="form-field-grid">
            <Field label="Logradouro" value={f.street} onChange={setF("street")} maxLength={60} />
            <Field label="Número" value={f.number} onChange={setF("number")} maxLength={10} />
            <Field label="Complemento" value={f.complement} onChange={setF("complement")} maxLength={60} />
            <Field label="Bairro" value={f.district} onChange={setF("district")} maxLength={60} />
          </div>
          <div className="vendas-grid-4">
            <Field label="Município" value={f.city} onChange={setF("city")} maxLength={60} />
            <Field label="Código IBGE do município" value={f.city_code} onChange={setF("city_code")} maxLength={7} placeholder="7 dígitos" />
            <Field label="UF" value={f.uf} onChange={setF("uf")} options={UFS.map((uf) => [uf, uf])} emptyOption="—" />
            <Field label="CEP" value={f.cep} onChange={setF("cep")} maxLength={9} placeholder="00000-000" />
          </div>
          <div className="form-field-grid">
            <Field label="Série da NFC-e" type="number" min={0} max={999} value={f.nfce_series} onChange={setF("nfce_series")} />
            <Field label="Série da NF-e" type="number" min={0} max={999} value={f.nfe_series} onChange={setF("nfe_series")} />
          </div>
          <h3 className="vendas-h3">Padrões para produtos sem o campo</h3>
          <div className="form-field-grid">
            <Field label="CFOP" value={f.default_cfop} onChange={setF("default_cfop")} maxLength={4} placeholder="5102" help="5102: venda de mercadoria de terceiros dentro do estado." />
            <Field label="Origem" value={f.default_origin} onChange={setF("default_origin")} options={originOptions} emptyOption={null} />
            <Field label="CSOSN (Simples Nacional)" value={f.default_csosn} onChange={setF("default_csosn")} options={withCurrent(csosnOptions, f.default_csosn)} emptyOption={null} />
            <Field label="CST do ICMS (regime normal)" value={f.default_icms_cst} onChange={setF("default_icms_cst")} options={withCurrent(icmsCstOptions, f.default_icms_cst)} emptyOption={null} />
            <Field label="CST do PIS" value={f.default_pis_cst} onChange={setF("default_pis_cst")} options={withCurrent(pisCofinsOptions, f.default_pis_cst)} emptyOption={null} />
            <Field label="CST da COFINS" value={f.default_cofins_cst} onChange={setF("default_cofins_cst")} options={withCurrent(pisCofinsOptions, f.default_cofins_cst)} emptyOption={null} />
          </div>
          <p className="muted vendas-hint">
            <FileWarning size={15} aria-hidden /> Confira regime, CFOP e CSTs com a sua contabilidade antes de emitir notas em produção.
          </p>
        </Card>
        <div className="toolbar">
          <span />
          <Button type="submit" busy={busy} disabled={!dirty} icon={<Check size={17} />}>
            Salvar regras
          </Button>
        </div>
      </form>
      <FiscalStatus />
    </div>
  );
}

/** Depois de salvar, o formulário recomeça dos valores normalizados pelo servidor. */
export function VendasConfigPage() {
  const app = useApp();
  return <ConfigForm key={JSON.stringify(app.settings.vendas || {})} />;
}
