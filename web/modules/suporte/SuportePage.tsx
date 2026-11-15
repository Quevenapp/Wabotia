// Gestão → Suporte pago: liberações (quem, como, por qual pagador, até
// quando) e compras avulsas com filtro, e busca de pagador (Mensalidade).
import React, { useEffect, useState } from "react";
import { LifeBuoy } from "lucide-react";
import { useApp } from "../../app/AppContext";
import type { Row } from "../../lib/api";
import {
  Chip,
  Empty,
  Notice,
  Pill,
  SearchBox,
  Segmented,
  SkeletonRows,
  Table,
} from "../../ui";
import { Pager, useList } from "../../admin/shared";
import {
  kindLabels,
  money,
  phoneLabel,
  purchaseLabels,
  purchaseTones,
  stampLabel,
} from "./shared";

function useDebounced(value: string) {
  const [out, setOut] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setOut(value.trim()), 300);
    return () => clearTimeout(timer);
  }, [value]);
  return out;
}

function ReleasesTab() {
  const app = useApp();
  const [kind, setKind] = useState("");
  const [search, setSearch] = useState("");
  const q = useDebounced(search);
  const params = new URLSearchParams();
  if (kind) params.set("kind", kind);
  if (q) params.set("q", q);
  const list = useList(`${app.root}/suporte/releases?${params}`);
  const counts: Row = list.raw?.counts || {};
  return (
    <>
      <div className="toolbar">
        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder="Buscar por pagador ou telefone"
        />
      </div>
      <div className="chip-row" role="group" aria-label="Filtrar por forma">
        <Chip active={!kind} onClick={() => setKind("")}>
          Todas
        </Chip>
        {Object.entries(kindLabels).map(([id, label]) => (
          <Chip
            key={id}
            active={kind === id}
            count={counts[id] || 0}
            onClick={() => setKind(id)}
          >
            {label}
          </Chip>
        ))}
      </div>
      <section className="card">
        {!list.loaded && !list.error ? (
          <SkeletonRows rows={5} avatar={false} />
        ) : (
          <Table
            rows={list.rows}
            columns={[
              ["created", "Quando", (row) => stampLabel(row.created)],
              ["phone", "Telefone", (row) => phoneLabel(row.phone)],
              [
                "payer_name",
                "Pagador",
                (row) => (
                  <>
                    {row.payer_name || "—"}
                    {!row.phone_linked && row.payer_id && (
                      <>
                        {" "}
                        <Pill tone="warn">telefone não vinculado</Pill>
                      </>
                    )}
                  </>
                ),
              ],
              ["kind", "Como", (row) => kindLabels[row.kind] || row.kind],
              [
                "valid_until",
                "Até",
                (row) =>
                  row.valid_until
                    ? stampLabel(row.valid_until)
                    : `protocolo fechar (máx. ${stampLabel(row.expires_at)})`,
              ],
              [
                "actor",
                "Por",
                (row) =>
                  row.actor === "provider"
                    ? "Pagamento confirmado"
                    : row.actor === "system"
                      ? "Automático"
                      : app.names[row.actor] || row.actor,
              ],
              [
                "status",
                "Estado",
                (row) => (
                  <Pill tone={row.status === "active" ? "ok" : "muted"}>
                    {row.status === "active" ? "Ativa" : "Encerrada"}
                  </Pill>
                ),
              ],
            ]}
            empty={
              <Empty
                compact
                icon={<LifeBuoy size={28} />}
                title="Nenhuma liberação"
                description="Quando um cliente for liberado para o atendimento humano, aparece aqui com o motivo."
              />
            }
          />
        )}
        <Pager
          cursor={list.cursor}
          nextCursor={list.nextCursor}
          setCursor={list.setCursor}
        />
      </section>
    </>
  );
}

function PurchasesTab() {
  const app = useApp();
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const q = useDebounced(search);
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (q) params.set("q", q);
  const list = useList(`${app.root}/suporte/purchases?${params}`);
  const counts: Row = list.raw?.counts || {};
  return (
    <>
      <div className="toolbar">
        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder="Buscar por nome, CPF/CNPJ ou telefone"
        />
        <span className="muted">
          Recebido: {money(list.raw?.paid_cents || 0)}
        </span>
      </div>
      <div className="chip-row" role="group" aria-label="Filtrar por estado">
        <Chip active={!status} onClick={() => setStatus("")}>
          Todas
        </Chip>
        {Object.entries(purchaseLabels).map(([id, label]) => (
          <Chip
            key={id}
            active={status === id}
            count={counts[id] || 0}
            onClick={() => setStatus(id)}
          >
            {label}
          </Chip>
        ))}
      </div>
      <section className="card">
        {!list.loaded && !list.error ? (
          <SkeletonRows rows={5} avatar={false} />
        ) : (
          <Table
            rows={list.rows}
            columns={[
              ["created", "Quando", (row) => stampLabel(row.created)],
              [
                "name",
                "Cliente",
                (row) => (
                  <>
                    {row.name || "—"}
                    <br />
                    <small className="muted">{phoneLabel(row.phone)}</small>
                  </>
                ),
              ],
              [
                "package_name",
                "Pacote",
                (row) => `${row.package_name} · ${row.validity}`,
              ],
              ["price_cents", "Valor", (row) => money(row.price_cents)],
              [
                "method",
                "Forma",
                (row) => (row.method === "pix" ? "Pix" : "Link"),
              ],
              [
                "status",
                "Estado",
                (row) => (
                  <Pill tone={purchaseTones[row.status] || "muted"}>
                    {purchaseLabels[row.status] || row.status}
                  </Pill>
                ),
              ],
            ]}
            empty={
              <Empty
                compact
                icon={<LifeBuoy size={28} />}
                title="Nenhuma compra"
                description="Compras de suporte avulso feitas pelo WhatsApp."
              />
            }
          />
        )}
        <Pager
          cursor={list.cursor}
          nextCursor={list.nextCursor}
          setCursor={list.setCursor}
        />
      </section>
    </>
  );
}

function PendingTab() {
  const app = useApp();
  const list = useList(`${app.root}/suporte/pending`);
  return (
    <>
      <Notice>
        Pediram atendimento com o CPF/CNPJ de um cadastro por um telefone que
        ele não autorizou. Nada do cadastro foi mostrado ao cliente. Abra a
        conversa, confirme a identidade e use Dados da conversa → Suporte pago →
        Confirmar identidade e liberar.
      </Notice>
      <section className="card">
        {!list.loaded && !list.error ? (
          <SkeletonRows rows={3} avatar={false} />
        ) : (
          <Table
            rows={list.rows}
            columns={[
              ["created", "Quando", (row) => stampLabel(row.created)],
              ["phone", "Telefone", (row) => phoneLabel(row.phone)],
              ["payer_name", "Diz falar por", (row) => row.payer_name || "—"],
            ]}
            empty={
              <Empty
                compact
                icon={<LifeBuoy size={28} />}
                title="Ninguém aguardando confirmação"
              />
            }
          />
        )}
      </section>
    </>
  );
}

function PayersTab() {
  const app = useApp();
  const [search, setSearch] = useState("");
  const q = useDebounced(search);
  const list = useList(
    q ? `${app.root}/mensalidade/payers?q=${encodeURIComponent(q)}` : null,
  );
  if (!app.moduleOn("mensalidade"))
    return (
      <Notice>
        Ligue o módulo Mensalidade para identificar pagadores e vender planos
        mensais.
      </Notice>
    );
  return (
    <>
      <div className="toolbar">
        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder="Nome, CPF/CNPJ ou telefone do pagador"
        />
      </div>
      <section className="card">
        {!q ? (
          <p className="muted">
            Digite para buscar. Telefones e assinaturas ficam em Mensalidades →
            Pagadores.
          </p>
        ) : !list.loaded ? (
          <SkeletonRows rows={3} avatar={false} />
        ) : (
          <Table
            rows={list.rows}
            columns={[
              ["name", "Pagador"],
              [
                "document_display",
                "CPF/CNPJ",
                (row) => row.document_display || "—",
              ],
              [
                "phones",
                "Telefones autorizados",
                (row) =>
                  row.phones.map((p: Row) => phoneLabel(p.phone)).join(", ") ||
                  "—",
              ],
              ["subscriptions", "Assinaturas"],
            ]}
            empty={<Empty compact title="Nenhum pagador encontrado" />}
          />
        )}
      </section>
    </>
  );
}

export function SuportePage() {
  const [tab, setTab] = useState<
    "releases" | "pending" | "purchases" | "payers"
  >("releases");
  return (
    <>
      <Segmented
        label="Visão"
        value={tab}
        onChange={setTab}
        options={[
          { value: "releases", label: "Liberações" },
          { value: "pending", label: "Aguardando confirmação" },
          { value: "purchases", label: "Compras avulsas" },
          { value: "payers", label: "Pagadores" },
        ]}
      />
      {tab === "releases" && <ReleasesTab />}
      {tab === "pending" && <PendingTab />}
      {tab === "purchases" && <PurchasesTab />}
      {tab === "payers" && <PayersTab />}
    </>
  );
}
