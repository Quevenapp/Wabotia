// Link para o código-fonte do commit em execução (AGPL-3.0, §13): rodapé do
// painel, do login, das páginas públicas e do painel de TV.
import React from "react";
import { useSourceLink } from "../lib/source";

export function SourceFooterLink({ className }: { className?: string }) {
  const { url, license } = useSourceLink();
  return (
    <a className={className} href={url} target="_blank" rel="noreferrer">
      Código-fonte ({license}) ↗
    </a>
  );
}
