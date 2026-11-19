// Entrada do site: página pública, instalação, documentação da API e o
// painel em /app. O painel vive em web/app; cada área tem seu módulo.
import React from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/bubbles.css";
import "./style.css";
import "./workspace.css";
import { App } from "./app/App";
import { Landing } from "./site/Landing";
import { Install } from "./site/Install";
import { ApiDocs } from "./site/ApiDocs";
import { WebInstall } from "./site/WebInstall";
import { Privacy } from "./site/Privacy";
import { QueueDisplay } from "./queue/QueueDisplay";
import { lazyWithRecovery } from "./management/pages";

const ResponsiblePage = lazyWithRecovery<object>(() =>
  import("./modules/ensino/ResponsiblePage").then((m) => ({ default: m.ResponsiblePage })),
);
const MoradorPage = lazyWithRecovery<object>(() =>
  import("./modules/condominio/MoradorPage").then((m) => ({ default: m.MoradorPage })),
);

export function SiteEntry({ pathname = location.pathname }: { pathname?: string }) {
  return pathname.startsWith("/app") ? (
    <App />
  ) : pathname === "/ensino/acesso" ? (
    <ResponsiblePage />
  ) : pathname === "/condominio/acesso" ? (
    <MoradorPage />
  ) : pathname === "/install" ? (
    <Install />
  ) : pathname === "/instalar" ? (
    <WebInstall />
  ) : pathname === "/privacidade" ? (
    <Privacy />
  ) : pathname === "/api-docs" ? (
    <ApiDocs />
  ) : pathname === "/painel" ? (
    <QueueDisplay />
  ) : (
    <Landing />
  );
}

createRoot(document.getElementById("root")!).render(<SiteEntry />);
