import React, { useEffect, useRef, useState } from "react";
import "./whatsapp-insights.css";

type Template = {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components: {
    type?: string;
    text?: string;
    format?: string;
    buttons?: { text?: string; type?: string }[];
  }[];
};
const categories: Record<string, string> = {
  UTILITY: "Utilidade",
  MARKETING: "Marketing",
  AUTHENTICATION: "Autenticação",
};
const statuses: Record<string, string> = {
  APPROVED: "Aprovado",
  PENDING: "Em análise",
  REJECTED: "Rejeitado",
  PAUSED: "Pausado",
  DISABLED: "Desativado",
  IN_APPEAL: "Em recurso",
};
const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
const demoTemplates: Template[] = [
  {
    id: "template-demo",
    name: "atualizacao_atendimento",
    language: "pt_BR",
    status: "APPROVED",
    category: "UTILITY",
    components: [
      {
        type: "BODY",
        text: "Olá, {{1}}. Seu atendimento {{2}} foi atualizado.",
      },
    ],
  },
];

export function ZernioTemplatesCatalog({
  api,
  root,
  numberId,
  demo = false,
}: {
  api: any;
  root: string;
  numberId: string;
  demo?: boolean;
}) {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const version = useRef(0);
  useEffect(() => {
    version.current++;
    setTemplates(null);
    setQuery("");
    setError("");
    setBusy(false);
    return () => {
      version.current++;
    };
  }, [root, numberId, demo]);
  async function load() {
    const request = ++version.current;
    setBusy(true);
    setError("");
    try {
      const result = demo
        ? { data: demoTemplates }
        : await api(
            `${root}/router/numbers/${encodeURIComponent(numberId)}/templates`,
          );
      if (request === version.current) setTemplates(result.data || []);
    } catch (e: any) {
      if (request === version.current) setError(e.message);
    } finally {
      if (request === version.current) setBusy(false);
    }
  }
  const term = fold(query.trim());
  const filtered =
    templates?.filter((template) =>
      fold(
        [
          template.name,
          template.language,
          template.category,
          categories[template.category],
          template.status,
          statuses[template.status],
          ...(template.components || []).flatMap((component) => [
            component.text,
            ...(component.buttons || []).map((button) => button.text),
          ]),
        ]
          .filter(Boolean)
          .join(" "),
      ).includes(term),
    ) || [];
  return (
    <details className="zernio-template-catalog">
      <summary>Templates da Zernio</summary>
      <p>
        Consulte os modelos da integração deste telefone. A consulta não envia
        mensagens nem altera os templates.
      </p>
      <button type="button" disabled={busy} onClick={load}>
        {busy
          ? "Consultando templates…"
          : templates
            ? "Atualizar templates"
            : "Consultar templates da Zernio"}
      </button>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {templates && (
        <>
          <label>
            Buscar templates
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Nome, texto, idioma ou categoria"
            />
          </label>
          <p role="status">
            {filtered.length} de {templates.length} templates encontrados.
          </p>
          {!templates.length ? (
            <p>
              Nenhum template disponível nesta integração. Gerencie os modelos
              no painel da Zernio.
            </p>
          ) : !filtered.length ? (
            <p>Nenhum template corresponde à busca.</p>
          ) : (
            <div className="template-results">
              {filtered.map((template) => (
                <details
                  key={`${template.id}:${template.name}:${template.language}`}
                >
                  <summary>
                    <strong>{template.name}</strong>
                    <span>
                      {categories[template.category] || template.category} ·{" "}
                      {template.language} ·{" "}
                      {statuses[template.status] || template.status}
                    </span>
                  </summary>
                  {(template.components || []).map((component, index) => (
                    <div className="template-preview" key={index}>
                      {component.text && <p>{component.text}</p>}
                      {component.format && component.format !== "TEXT" && (
                        <small>Cabeçalho: {component.format}</small>
                      )}
                      {component.buttons?.map((button, i) => (
                        <span className="template-button-preview" key={i}>
                          {button.text || button.type}
                        </span>
                      ))}
                    </div>
                  ))}
                </details>
              ))}
            </div>
          )}
          <small>
            As variáveis, como {"{{1}}"}, precisam de valores no envio. Enviar
            um template não abre nem renova a janela de 24 horas.
          </small>
        </>
      )}
    </details>
  );
}
