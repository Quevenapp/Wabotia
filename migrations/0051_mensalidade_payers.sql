-- Mensalidade: pagador (CPF ou CNPJ, nome e vários telefones autorizados) e
-- planos vendáveis pelo WhatsApp. Aditiva: cada assinatura existente vira um
-- pagador com o telefone que já tem.

CREATE TABLE IF NOT EXISTS mensalidade_payers (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  -- Só dígitos (CPF) ou 12 alfanuméricos + 2 dígitos (CNPJ); NULL se ainda
  -- não informado (pagadores criados das assinaturas antigas).
  document TEXT,
  -- cpf | cnpj
  document_type TEXT,
  name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS mensalidade_payers_document ON mensalidade_payers(profile_id, document);
CREATE INDEX IF NOT EXISTS mensalidade_payers_name ON mensalidade_payers(profile_id, name);

-- Telefones autorizados a falar em nome do pagador (empresa com vários
-- funcionários, família). Só dígitos, com DDI.
CREATE TABLE IF NOT EXISTS mensalidade_payer_phones (
  payer_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (payer_id, phone)
);
CREATE INDEX IF NOT EXISTS mensalidade_payer_phones_phone ON mensalidade_payer_phones(profile_id, phone);

ALTER TABLE mensalidade_subscriptions ADD COLUMN payer_id TEXT;
-- Contratação pelo WhatsApp: repetir a mesma chave não cria outra assinatura.
ALTER TABLE mensalidade_subscriptions ADD COLUMN source_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS mensalidade_subscriptions_source ON mensalidade_subscriptions(source_key);
CREATE INDEX IF NOT EXISTS mensalidade_subscriptions_payer ON mensalidade_subscriptions(payer_id, status);

-- Plano oferecido para contratação pelo WhatsApp (módulo Suporte, por exemplo).
ALTER TABLE mensalidade_plans ADD COLUMN sellable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mensalidade_plans ADD COLUMN description TEXT NOT NULL DEFAULT '';

-- Primeira parcela cobrada na contratação: só conta como em dia depois de paga.
ALTER TABLE mensalidade_installments ADD COLUMN upfront INTEGER NOT NULL DEFAULT 0;
-- Forma da cobrança em uso (pix | link), para reaproveitar só a da mesma forma.
ALTER TABLE mensalidade_installments ADD COLUMN payment_method TEXT;

INSERT INTO mensalidade_payers(id,profile_id,document,document_type,name,created_by,created,updated)
  SELECT 'payer-' || id, profile_id, NULL, NULL, customer_name, 'migration', created, updated
  FROM mensalidade_subscriptions WHERE payer_id IS NULL;
INSERT OR IGNORE INTO mensalidade_payer_phones(payer_id,profile_id,phone,label,created_by,created)
  SELECT 'payer-' || id, profile_id, phone, '', 'migration', created
  FROM mensalidade_subscriptions WHERE payer_id IS NULL AND phone <> '';
UPDATE mensalidade_subscriptions SET payer_id = 'payer-' || id WHERE payer_id IS NULL;
