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

createRoot(document.getElementById("root")!).render(
  location.pathname.startsWith("/app") ? (
    <App />
  ) : location.pathname === "/install" ? (
    <Install />
  ) : location.pathname === "/api-docs" ? (
    <ApiDocs />
  ) : (
    <Landing />
  ),
);