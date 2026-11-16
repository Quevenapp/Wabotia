-- Cadastro de clientes (módulo "clientes", docs/CLIENTES.md): ficha com os
-- dados de destinatário de NF-e, NFC-e e NFS-e, ligada às conversas pelos
-- telefones. Faixa reservada: 0085 a 0089.
CREATE TABLE IF NOT EXISTS clientes_customers (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  -- active | erasing (exclusão confirmada, em andamento) | erased (dados
  -- pessoais apagados a pedido do titular; a linha fica como vínculo)
  status TEXT NOT NULL DEFAULT 'active',
  -- pf (pessoa física) | pj (pessoa jurídica)
  kind TEXT NOT NULL DEFAULT 'pf',
  -- Nome ou razão social; nome fantasia só na PJ.
  name TEXT NOT NULL DEFAULT '',
  trade_name TEXT NOT NULL DEFAULT '',
  -- CPF (11 dígitos) ou CNPJ (12 alfanuméricos + 2 dígitos), sem pontuação.
  document TEXT,
  document_type TEXT,
  -- CNPJ de pessoa física (MEI, empresário individual): mascarado como CPF.
  individual_business INTEGER NOT NULL DEFAULT 0,
  -- Inscrição estadual e indicador da IE do destinatário (indIEDest da NF-e):
  -- 1 contribuinte, 2 isento, 9 não contribuinte.
  ie TEXT NOT NULL DEFAULT '',
  ie_indicator TEXT NOT NULL DEFAULT '9',
  -- Inscrição municipal (tomador da NFS-e).
  im TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  -- Endereço do destinatário, com o código IBGE do município (7 dígitos).
  cep TEXT NOT NULL DEFAULT '',
  street TEXT NOT NULL DEFAULT '',
  number TEXT NOT NULL DEFAULT '',
  complement TEXT NOT NULL DEFAULT '',
  district TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  city_ibge TEXT NOT NULL DEFAULT '',
  uf TEXT NOT NULL DEFAULT '',
  country_code TEXT NOT NULL DEFAULT '1058',
  -- Observações da equipe (notas internas).
  notes TEXT NOT NULL DEFAULT '',
  -- self (o cliente preencheu) | panel | api
  source TEXT NOT NULL,
  -- Nome normalizado para a busca (sem documento, telefone ou e-mail).
  search_text TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  erased_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS clientes_customers_document
  ON clientes_customers(profile_id, document) WHERE document IS NOT NULL;
CREATE INDEX IF NOT EXISTS clientes_customers_list
  ON clientes_customers(profile_id, status, updated, id);

-- Telefones da ficha (só dígitos, com DDI). `verified`: confirmado pelo
-- próprio canal (o cliente preencheu o link pela conversa desse telefone).
-- Um telefone confirmado pertence a uma ficha só na área.
CREATE TABLE IF NOT EXISTS clientes_phones (
  customer_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  verified INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (customer_id, phone)
);
CREATE INDEX IF NOT EXISTS clientes_phones_phone ON clientes_phones(profile_id, phone);
CREATE UNIQUE INDEX IF NOT EXISTS clientes_phones_verified
  ON clientes_phones(profile_id, phone) WHERE verified = 1;
