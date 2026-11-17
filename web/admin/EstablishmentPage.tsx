// Dados do estabelecimento da área (nome fantasia, CPF/CNPJ, endereço,
// telefone, rodapé). Gravados em PUT /settings {establishment}; módulos,
// páginas do passo web e aplicativos leem em GET /establishment.
// O endereço tem o texto livre de sempre e, opcional, os campos separados
// (os mesmos da Empresa do ERP) e a posição da loja: com eles o pedido
// completa a cidade do cliente e o app do entregador procura o destino perto
// da loja. Sem provedor de mapa: a posição vem do aparelho ou é colada.
import React, { useEffect, useState } from "react";
import { LocateFixed, Store } from "lucide-react";
import { useApp } from "../app/AppContext";
import { useAction } from "../app/hooks";
import type { Row } from "../lib/api";
import { Button, Field, Notice, Pill, SkeletonRows } from "../ui";
import { useResource } from "./shared";

const UFS = [
  "AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT", "PA",
  "PB", "PE", "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO",
];

const ADDRESS_KEYS = [
  "street",
  "number",
  "complement",
  "district",
  "city",
  "state",
  "postal_code",
  "municipality_code",
] as const;

/** "-22.9056" ou "-22,9056" → número; vazio → null; inválido → NaN. */
const coordinate = (text: string) => {
  const t = String(text || "").trim().replace(",", ".");
  return t ? Number(t) : null;
};

export function EstablishmentPage() {
  const app = useApp();
  const resource = useResource(app.root + "/establishment");
  const { busy, run } = useAction();
  const data: Row | null = resource.data;
  const [form, setForm] = useState<Row>({});
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState("");
  useEffect(() => {
    if (data)
      setForm({
        name: data.name || "",
        document: data.document_display || "",
        // O texto livre gravado (o `address` da leitura pode vir montado).
        address: data.address_free ?? data.address ?? "",
        phone: data.phone || "",
        footer: data.footer || "",
        ...Object.fromEntries(ADDRESS_KEYS.map((k) => [k, data[k] || ""])),
        latitude: data.latitude ?? "",
        longitude: data.longitude ?? "",
      });
  }, [data]);
  const set = (key: string) => (value: any) =>
    setForm((current) => ({ ...current, [key]: value }));
  const save = () =>
    run(
      async () => {
        const latitude = coordinate(form.latitude),
          longitude = coordinate(form.longitude);
        if (Number.isNaN(latitude) || Number.isNaN(longitude))
          throw new Error("Posição da loja: use números, como -22.9056 e -47.0608.");
        await app.api(app.root + "/settings", "PUT", {
          establishment: { ...form, latitude, longitude },
        });
        await resource.reload();
      },
      { success: "Dados do estabelecimento salvos." },
    );
  // Geolocalização do navegador: só em HTTPS (ou localhost) e com a permissão
  // da pessoa. Recusa ou erro: a mensagem, e os campos ficam para colar.
  const locate = () => {
    setLocateError("");
    if (!("geolocation" in navigator) || !window.isSecureContext) {
      setLocateError(
        "Este navegador não fornece a localização aqui (precisa de HTTPS). Cole a latitude e a longitude.",
      );
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setForm((current) => ({
          ...current,
          latitude: pos.coords.latitude.toFixed(6),
          longitude: pos.coords.longitude.toFixed(6),
        }));
      },
      (error) => {
        setLocating(false);
        setLocateError(
          error.code === error.PERMISSION_DENIED
            ? "A permissão de localização foi negada. Libere no navegador ou cole a latitude e a longitude."
            : "Não foi possível obter a localização deste aparelho. Cole a latitude e a longitude.",
        );
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  };
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
        label="Endereço em texto (opcional)"
        value={form.address || ""}
        onChange={set("address")}
        maxLength={300}
        help="Vale enquanto rua e cidade abaixo estiverem vazias."
      />
      <h3>Endereço da loja (opcional)</h3>
      <p className="workspace-help">
        Com rua e cidade preenchidas, o cupom e as páginas mostram o endereço
        montado destes campos. A cidade e a UF completam o endereço dos pedidos
        de entrega que vierem sem cidade.
      </p>
      <div className="form-field-grid">
        <Field label="Rua" value={form.street || ""} onChange={set("street")} maxLength={200} />
        <Field label="Número" value={form.number || ""} onChange={set("number")} maxLength={30} />
      </div>
      <div className="form-field-grid">
        <Field label="Bairro" value={form.district || ""} onChange={set("district")} maxLength={100} />
        <Field
          label="Complemento"
          value={form.complement || ""}
          onChange={set("complement")}
          maxLength={200}
        />
      </div>
      <div className="form-field-grid">
        <Field label="Cidade" value={form.city || ""} onChange={set("city")} maxLength={100} />
        <Field
          label="UF"
          value={form.state || ""}
          onChange={set("state")}
          options={UFS.map((uf) => [uf, uf])}
          emptyOption="—"
        />
      </div>
      <div className="form-field-grid">
        <Field
          label="CEP"
          value={form.postal_code || ""}
          onChange={set("postal_code")}
          maxLength={9}
          placeholder="00000-000"
        />
        <Field
          label="Código IBGE da cidade"
          value={form.municipality_code || ""}
          onChange={set("municipality_code")}
          maxLength={7}
          placeholder="7 dígitos"
        />
      </div>
      <h3>Posição da loja (opcional)</h3>
      <p className="workspace-help">
        O app do entregador procura o endereço do cliente perto daqui. Use o
        botão estando na loja, ou cole a latitude e a longitude (por exemplo,
        de um mapa).
      </p>
      <div className="card-actions" style={{ marginBottom: 12 }}>
        <Button type="button" variant="secondary" busy={locating} disabled={locating} onClick={locate}>
          <LocateFixed size={16} /> Usar a localização deste aparelho
        </Button>
      </div>
      {locateError && <Notice tone="warn">{locateError}</Notice>}
      <div className="form-field-grid">
        <Field
          label="Latitude"
          value={form.latitude ?? ""}
          onChange={set("latitude")}
          placeholder="-22.905600"
        />
        <Field
          label="Longitude"
          value={form.longitude ?? ""}
          onChange={set("longitude")}
          placeholder="-47.060800"
        />
      </div>
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
