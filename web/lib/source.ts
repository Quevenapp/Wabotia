// Código-fonte do commit em execução (AGPL-3.0, §13), lido de /api/health uma
// vez por carregamento. Enquanto não chega (ou sem rede), aponta para o
// repositório oficial.
import { useEffect, useState } from "react";

export interface SourceLink {
  url: string;
  license: string;
}
const fallback: SourceLink = {
  url: "https://github.com/Quevenapp/Wabotia",
  license: "AGPL-3.0",
};
let pending: Promise<SourceLink> | null = null;

function load(): Promise<SourceLink> {
  pending ||= fetch("/api/health", { credentials: "omit" })
    .then((r) => (r.ok ? r.json() : null))
    .then((info: any) =>
      typeof info?.source?.url === "string" && /^https:\/\//.test(info.source.url)
        ? { url: info.source.url, license: String(info.source.license || fallback.license) }
        : fallback,
    )
    .catch(() => fallback);
  return pending;
}

export function useSourceLink(): SourceLink {
  const [link, setLink] = useState(fallback);
  useEffect(() => {
    let alive = true;
    void load().then((value) => alive && setLink(value));
    return () => {
      alive = false;
    };
  }, []);
  return link;
}
