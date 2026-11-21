// Emissor de notas do Vinki (cofre NFapi; src/erp/emissor/README.md, "Rotas
// para o painel"). No Vinki o certificado A1 nunca fica no sistema: fica no
// cofre. O ERP do Fagoo mostrava "Certificado inválido" a partir do próprio
// cofre A1 (que aqui não existe, e o motor responde sempre 'missing'); o
// painel passa a ler o estado do cofre em /api/v1/profiles/<área>/erp-emissor.
import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";

export type EmissorAlert = {
  code: string;
  level: "error" | "warning" | "info";
  message: string;
  days_left?: number;
};
export type EmissorCertificate = {
  holder: string;
  document: { kind: "cnpj" | "cpf"; id: string } | null;
  valid_until: string;
  days_left: number;
};
export type EmissorView = {
  configured: boolean;
  provider: string | null;
  url: string | null;
  api_key_set: boolean;
  contract_version: string;
  updated: number | null;
  checked: null | {
    at: number;
    ok: boolean;
    error: { code: string; message: string; provider_code: string | null } | null;
    state: null | {
      provider: string;
      version: string;
      update: { published: string | null; pending: boolean };
      certificate: EmissorCertificate | null;
      production_released: boolean;
    };
  };
  alerts: EmissorAlert[];
};

/** O que o painel fala com o emissor (mount.tsx registra; a demonstração não grava). */
export type EmissorPort = {
  read(signal?: AbortSignal): Promise<EmissorView>;
  save(body: { url: string; api_key?: string }): Promise<EmissorView>;
  remove(): Promise<EmissorView>;
  test(): Promise<EmissorView>;
};

export const CERTIFICATE_WARNING_DAYS = 30;
const READ_MS = 60_000;

/** Visão vazia: nenhum cofre nesta área (e a da demonstração). */
export const NOT_CONFIGURED: EmissorView = {
  configured: false,
  provider: null,
  url: null,
  api_key_set: false,
  contract_version: "",
  updated: null,
  checked: null,
  alerts: [],
};

export function createEmissorPort(profile: string): EmissorPort {
  const base = `v1/profiles/${encodeURIComponent(profile)}/erp-emissor`;
  let cached: { at: number; value: Promise<EmissorView> } | null = null;
  const keep = (value: Promise<EmissorView>) => {
    cached = { at: Date.now(), value };
    value.catch(() => {
      if (cached?.value === value) cached = null;
    });
    return value;
  };
  return {
    read(signal) {
      if (cached && Date.now() - cached.at < READ_MS) return cached.value;
      return keep(api(base, "GET", undefined, signal));
    },
    save: (body) => keep(api(base, "PUT", body)),
    remove: () => keep(api(base, "DELETE")),
    test: () => keep(api(`${base}/test`, "POST", {})),
  };
}

export function createDemoEmissorPort(): EmissorPort {
  const refuse = () =>
    Promise.reject(
      Object.assign(new Error("Na demonstração nada é gravado."), {
        status: 403,
        code: "demo",
      }),
    );
  return {
    read: async () => NOT_CONFIGURED,
    save: refuse,
    remove: refuse,
    test: refuse,
  };
}

const DAY = 86_400_000;
/** Dias até vencer pela data (o número do último teste envelhece). */
export function daysLeft(certificate: EmissorCertificate, at = Date.now()) {
  const end = Date.parse(certificate.valid_until);
  return Number.isFinite(end)
    ? Math.floor((end - at) / DAY)
    : certificate.days_left;
}

export const dateBR = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
};

export type EmissorBadge = {
  tone: "ok" | "warning" | "error";
  text: string;
  title: string;
  /** Atalho para a configuração (ERP › Fiscal › Emissor de notas). */
  action: { label: string; to: string } | null;
};

export const EMISSOR_SETTINGS_PATH = "/certificado-a1";

/** O selo do topo (Frente de caixa): null quando não há o que dizer. */
export function emissorBadge(
  view: EmissorView | null,
  at = Date.now(),
): EmissorBadge | null {
  if (!view) return null;
  const configure = { label: "Configurar", to: EMISSOR_SETTINGS_PATH };
  if (!view.configured)
    return {
      tone: "warning",
      text: "Emissão não configurada",
      title:
        "Nenhum emissor de notas está ligado a esta área: a NFC-e não é emitida. O certificado A1 fica no emissor, não no Vinki.",
      action: configure,
    };
  const state = view.checked?.state;
  if (!state)
    return {
      tone: "warning",
      text: "Emissor sem teste de conexão",
      title:
        view.checked?.error?.message ||
        "Teste a conexão com o cofre para conferir o certificado.",
      action: { label: "Testar", to: EMISSOR_SETTINGS_PATH },
    };
  const certificate = state.certificate;
  if (!certificate)
    return {
      tone: "error",
      text: "Cofre sem certificado A1",
      title:
        "O cofre de emissão não tem certificado digital A1 instalado: a NFC-e não pode ser autorizada.",
      action: configure,
    };
  const days = daysLeft(certificate, at);
  const until = dateBR(certificate.valid_until);
  if (days < 0)
    return {
      tone: "error",
      text: "Certificado vencido",
      title: `O certificado A1 do cofre venceu em ${until}: a NFC-e não pode ser autorizada. Renove o certificado no painel do cofre.`,
      action: configure,
    };
  if (days <= CERTIFICATE_WARNING_DAYS)
    return {
      tone: "warning",
      text:
        days === 0
          ? "Certificado vence hoje"
          : `Certificado vence em ${days} ${days === 1 ? "dia" : "dias"}`,
      title: `O certificado A1 do cofre vale até ${until}. Renove no painel do cofre.`,
      action: configure,
    };
  return {
    tone: "ok",
    text: "Certificado válido",
    title: `Certificado A1 do cofre válido até ${until}.`,
    action: null,
  };
}

/** Estado do emissor para uma tela (null enquanto lê, ou sem acesso/módulo). */
export function useEmissorView(port: EmissorPort | undefined) {
  const [view, setView] = useState<EmissorView | null>(null);
  useEffect(() => {
    if (!port) return;
    const request = new AbortController();
    port.read(request.signal).then(
      (value) => {
        if (!request.signal.aborted) setView(value);
      },
      () => {
        // Sem papel, Fiscal desligado (409 module_disabled) ou sem rede: o selo some.
        if (!request.signal.aborted) setView(null);
      },
    );
    return () => request.abort();
  }, [port]);
  return view;
}
