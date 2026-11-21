// Seletor "Empresa" no topo do painel: aparece quando a pessoa tem acesso a
// mais de uma área com o ERP ligado e papel no ERP (GET
// /profiles/:area/erp-empresas). Mostra o nome fantasia e o CNPJ de cada
// empresa (não o nome técnico da área) e troca para a mesma tela na outra
// empresa, sem novo login: o que é registro de uma empresa (conversa,
// protocolo, pedido aberto) fica para trás, a tela continua.
import React from "react";
import { Building2 } from "lucide-react";
import { useRoute } from "../lib/routes";
import { useApp } from "./AppContext";
import { companyLabel, companySwitchRoute } from "./company-switch";
import "./company.css";

export function CompanySwitcher() {
  const app = useApp();
  const route = useRoute();
  const companies = app.companies;
  if (companies.length < 2) return null;
  const current = companies.find((company) => company.area === app.profile);
  return (
    <div className="company-bar" role="navigation" aria-label="Empresa">
      <Building2 size={15} aria-hidden />
      <label>
        <span>Empresa</span>
        <select
          value={current ? app.profile : ""}
          onChange={(event) => {
            const id = event.target.value;
            if (id && id !== app.profile) app.chooseProfile(id, companySwitchRoute(route));
          }}
        >
          {!current && <option value="">Esta área não tem ERP: escolha uma empresa</option>}
          {companies.map((company) => (
            <option key={company.area} value={company.area}>{companyLabel(company)}</option>
          ))}
        </select>
      </label>
    </div>
  );
}
