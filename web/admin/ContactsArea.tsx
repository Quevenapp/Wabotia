// Contatos (item do trilho): a agenda de sempre, na página do novo painel.
import React from "react";
import { BookOpen } from "lucide-react";
import { useApp } from "../app/AppContext";
import { navigate } from "../lib/routes";
import { PageHeader } from "../ui";
import { pageDescriptions } from "../workspace-navigation";
import { ContactsPanel } from "../ContactsPanel";
import "../styles/admin.css";

export function ContactsArea() {
  const app = useApp();
  return (
    <div className="area admin-area contacts-area">
      <div className="admin-main">
        <div className="admin-scroll">
          <div className="admin-content">
            <PageHeader
              title="Contatos"
              icon={<BookOpen size={22} />}
              description={pageDescriptions.contacts}
            />
            <ContactsPanel
              key={app.profile}
              api={app.api}
              root={app.root}
              demo={app.demo}
              openConversation={(row) =>
                navigate({ area: "conversations", id: row.id })
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
}
