// Dados do estabelecimento da área (nome fantasia, CPF/CNPJ, endereço,
// telefone, rodapé). Gravados em PUT /settings {establishment}; módulos,
// páginas do passo web e aplicativos leem em GET /establishment.
import React, { useEffect, useState } from "react";
import { Store } from "lucide-react";
import { useApp } from "../app/AppContext";
import { useAction } from "../app/hooks";
import type { Row } from "../lib/api";
import { Button, Field, Notice, Pill, SkeletonRows } from "../ui";
import { useResource } from "./shared";

export function EstablishmentPage() {
  const app = useApp();
  const resource = useResource(app.root + "/establishment");
  const { busy, run } = useAction();
  const data: Row | null = resource.data;
  const [form, setForm] = useState<Row>({});
  useEffect(() => {
    if (data)
      setForm({
        name: data.name || "",
        document: data.document_display || "",
        address: data.address || "",
        phone: data.phone || "",
        footer: data.footer || "",
      });
  }, [data]);
  const set = (key: string) => (value: any) =>
    setForm((current) => ({ ...current, [key]: value }));
  const save = () =>
    run(
      async () => {
        await app.api(app.root + "/settings", "PUT", {
          establishment: form,
        });
        await resource.reload();
      },
      { success: "Dados do estabelecimento salvos." },
    );
  if (!data)
    return resource.error ? (
      <Notice tone="error" onRetry={() => void resource.reload()}>
        {resource.error}
      </Notice>
    ) : (
      <div className="card">
        <SkeletonRows rows={3} avatar={false} />
      </div>
    );
  return (
    <form
      className="card"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="section-heading">
        <span className="integration-icon">
          <Store />
        </span>
        {data.configured ? (
          <Pill tone="ok">Preenchido</Pill>
        ) : (
          <Pill tone="warn">Não preenchido</Pill>
        )}
      </div>
      <h2>Dados do estabelecimento</h2>
      <p className="workspace-help">
        Aparecem no cupom do totem, na comanda, no recibo da ordem de serviço e
        nas páginas abertas pelo cliente a partir do WhatsApp (formulários e
        pedidos). Sem preenchimento, vale o nome da área.
      </p>
      <Field
        label="Nome fantasia"
        value={form.name || ""}
        onChange={set("name")}
        maxLength={100}
      />
      <Field
        label="CPF ou CNPJ (opcional)"
        value={form.document || ""}
        onChange={set("document")}
        maxLength={18}
        help="Com ou sem pontuação. Aceita o CNPJ com letras."
      />
      <Field
        label="Endereço (opcional)"
        value={form.address || ""}
        onChange={set("address")}
        maxLength={300}
      />
      <Field
        label="Telefone (opcional)"
        value={form.phone || ""}
        onChange={set("phone")}
        maxLength={40}
      />
      <Field
        label="Texto de rodapé (opcional)"
        value={form.footer || ""}
        onChange={set("footer")}
        type="textarea"
        rows={3}
        maxLength={500}
        help="Garantia, horário, agradecimento. Sai no fim do cupom e das páginas."
      />
      <div className="card-actions">
        <Button type="submit" busy={busy} disabled={busy || !app.isAdmin}>
          Salvar
        </Button>
      </div>
    </form>
  );
}
