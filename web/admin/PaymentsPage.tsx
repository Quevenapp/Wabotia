// Cobrança (docs/COBRANCA.md): conta do Mercado Pago desta área. Os segredos
// são só escritos: a leitura diz apenas se estão guardados.
import React, { useEffect, useState } from "react";
import { CheckCircle2, CreditCard, ShieldCheck } from "lucide-react";
import { useApp } from "../app/AppContext";
import { useAction } from "../app/hooks";
import type { Row } from "../lib/api";
import {
  Button,
  CopyButton,
  Field,
  Notice,
  Pill,
  SkeletonRows,
  Switch,
} from "../ui";
import { useResource } from "./shared";

export function PaymentsPage() {
  const app = useApp();
  const account = useResource(app.root + "/payments/account");
  const { busy, busyKey, run } = useAction();
  const data: Row | null = account.data;
  const [form, setForm] = useState<Row>({});
  useEffect(() => {
    if (data)
      setForm({
        provider: data.provider || "mercadopago",
        payer_email: data.payer_email || "",
        enabled: data.configured ? data.enabled : true,
        access_token: "",
        webhook_secret: "",
      });
  }, [data?.updated, data?.configured]);
  const set = (key: string) => (value: any) =>
    setForm((current) => ({ ...current, [key]: value }));
  const save = () =>
    run(
      async () => {
        const body: Row = {
          provider: form.provider,
          payer_email: form.payer_email,
          enabled: !!form.enabled,
        };
        if (form.access_token.trim())
          body.access_token = form.access_token.trim();
        if (form.webhook_secret.trim())
          body.webhook_secret = form.webhook_secret.trim();
        await app.api(app.root + "/payments/account", "PUT", body);
        await account.reload();
      },
      { key: "save", success: "Conta de pagamento salva." },
    );
  const check = () =>
    run(
      async () => {
        await app.api(app.root + "/payments/account/check");
        await account.reload();
      },
      { key: "check", success: "Credenciais conferidas no Mercado Pago." },
    );
  if (!data)
    return account.error ? (
      <Notice tone="error" onRetry={() => void account.reload()}>
        {account.error}
      </Notice>
    ) : (
      <div className="card">
        <SkeletonRows rows={3} avatar={false} />
      </div>
    );
  return (
    <>
      <section className="card">
        <h2>Pix e link de pagamento na conversa</h2>
        <p className="workspace-help">
          Conecte a conta do Mercado Pago desta área. A equipe cobra pela
          conversa (Dados da conversa → Cobrar) e os módulos cobram sozinhos
          (pedido, reserva, mensalidade). O cliente recebe o botão de pagamento
          e o código Pix copia e cola; a confirmação vem só do Mercado Pago,
          nunca de uma mensagem do cliente.
        </p>
      </section>
      <form
        className="card"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="section-heading">
          <span className="integration-icon">
            <CreditCard />
          </span>
          {data.configured ? (
            <Pill tone={data.enabled ? "ok" : "muted"}>
              {data.enabled ? "Ativa" : "Desativada"}
            </Pill>
          ) : (
            <Pill tone="warn">Não configurada</Pill>
          )}
        </div>
        <h2>Mercado Pago</h2>
        <Field
          label="Access Token de produção"
          type="password"
          value={form.access_token || ""}
          onChange={set("access_token")}
          autoComplete="off"
          placeholder={
            data.access_token_set
              ? "Guardado. Preencha só para trocar."
              : "APP_USR-…"
          }
          help="Suas integrações → sua aplicação → Credenciais de produção. Fica cifrado e nunca é mostrado de novo."
        />
        <Field
          label="Assinatura secreta do webhook"
          type="password"
          value={form.webhook_secret || ""}
          onChange={set("webhook_secret")}
          autoComplete="off"
          placeholder={
            data.webhook_secret_set
              ? "Guardada. Preencha só para trocar."
              : "Gerada ao salvar o webhook no Mercado Pago"
          }
          help="Suas integrações → Webhooks → Configurar notificações. Sem ela nenhum pagamento é confirmado."
        />
        <Field
          label="E-mail do pagador quando o contato não tem e-mail"
          type="email"
          value={form.payer_email || ""}
          onChange={set("payer_email")}
          required
          help="O Pix do Mercado Pago exige um e-mail. Com o contato salvo e com e-mail, vale o dele."
        />
        <div className="form-enabled">
          <Switch
            label="Conta ativa"
            checked={!!form.enabled}
            onChange={set("enabled")}
          />
          <span>Com a conta desativada, ninguém cria cobranças novas.</span>
        </div>
        <div className="card-actions">
          <Button type="submit" busy={busyKey === "save"} disabled={busy}>
            Salvar
          </Button>
          {data.configured && (
            <Button
              secondary
              icon={<ShieldCheck size={16} />}
              busy={busyKey === "check"}
              disabled={busy}
              onClick={() => void check()}
            >
              Testar credenciais
            </Button>
          )}
        </div>
        {data.checked && (
          <p className="muted">
            <CheckCircle2 size={14} /> Conta conferida: {data.checked.name}
          </p>
        )}
      </form>
      {data.configured && (
        <section className="card">
          <h2>Endereço do webhook</h2>
          <p className="workspace-help">
            No Mercado Pago, em Suas integrações → Webhooks, cole este endereço
            no modo produtivo e marque o evento Pagamentos. Depois de salvar,
            copie a assinatura secreta gerada para o campo acima.
          </p>
          {data.webhook_url ? (
            <div className="secret-box">
              <code>{data.webhook_url}</code>
              <CopyButton value={data.webhook_url} />
            </div>
          ) : (
            <Notice tone="warn">
              Abra o painel pelo endereço público desta instalação para gerar o
              endereço do webhook.
            </Notice>
          )}
        </section>
      )}
    </>
  );
}
