-- Boleto registrado pela API do banco (src/erp/boleto-api/): o interruptor de
-- cada banco na área, a escolha da conta financeira (API ou CNAB), o boleto de
-- cada conta a receber e o registro do que foi feito. Os segredos (Client
-- Secret, certificado, chave privada) ficam no cofre do núcleo (tabela
-- secrets, cifrados com a MASTER_KEY), nunca aqui.
-- Só tabelas novas; nada é apagado nem reescrito.

-- Interruptor de cada banco na área: nasce desligado, em homologação.
CREATE TABLE IF NOT EXISTS erp_boleto_api_banks (
  profile_id TEXT NOT NULL,
  -- inter | sicoob | bb | itau
  bank TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  -- sandbox | producao
  environment TEXT NOT NULL DEFAULT 'sandbox',
  enabled_by TEXT,
  enabled_at INTEGER,
  updated_by TEXT NOT NULL,
  updated INTEGER NOT NULL,
  PRIMARY KEY (profile_id, bank)
);

-- Como a conta financeira do ERP (erp_finance__account.id) emite boleto:
-- pela remessa CNAB (o padrão, como antes) ou pela API do banco.
CREATE TABLE IF NOT EXISTS erp_boleto_api_accounts (
  profile_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  -- cnab | api
  mode TEXT NOT NULL DEFAULT 'cnab',
  bank TEXT,
  -- Boleto com Pix (híbrido), quando o banco oferece.
  hybrid INTEGER NOT NULL DEFAULT 1,
  -- Dados comuns digitados (convênio, carteira, beneficiário...), em JSON.
  settings TEXT NOT NULL DEFAULT '{}',
  -- Quais segredos estão guardados no cofre (só os nomes), em JSON.
  secret_fields TEXT NOT NULL DEFAULT '[]',
  -- SHA-256 do código do endereço do aviso de pagamento (webhook) desta conta.
  webhook_hash TEXT,
  -- Sequência do nosso número escolhido pelo Vinki (Banco do Brasil e Itaú).
  next_number INTEGER NOT NULL DEFAULT 0,
  -- Última conferência das credenciais e o resultado, em português.
  checked_at INTEGER,
  check_note TEXT,
  updated_by TEXT NOT NULL,
  updated INTEGER NOT NULL,
  PRIMARY KEY (profile_id, account_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS erp_boleto_api_accounts_webhook ON erp_boleto_api_accounts(webhook_hash) WHERE webhook_hash IS NOT NULL;

-- O boleto de uma conta a receber (erp_finance__title.id), registrado pela API.
CREATE TABLE IF NOT EXISTS erp_boleto_api_titles (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  title_id TEXT NOT NULL,
  -- Versão da conta no registro: baixa ou mudança à mão depois disso vira pendência.
  title_version INTEGER,
  account_id TEXT NOT NULL,
  bank TEXT NOT NULL,
  environment TEXT NOT NULL,
  seu_numero TEXT NOT NULL,
  -- Identificação no banco (código da solicitação, nosso número ou id do boleto).
  bank_ref TEXT,
  our_number TEXT,
  barcode TEXT,
  digitable_line TEXT,
  pix_code TEXT,
  pix_txid TEXT,
  amount_cents INTEGER NOT NULL,
  due_on TEXT NOT NULL,
  issued_on TEXT NOT NULL,
  -- Pagador como foi registrado (nome, documento, endereço), para o PDF.
  payer TEXT NOT NULL DEFAULT '{}',
  -- registrando | incerto | registrado | pago | baixado | falhou
  status TEXT NOT NULL,
  -- aguardando | baixar | sugestao | baixada | pendencia | encerrada
  -- (como erp_title_charges.settle_state, migrations/0165_erp_title_charges.sql)
  settle_state TEXT NOT NULL DEFAULT 'aguardando',
  settlement_id TEXT,
  paid_cents INTEGER,
  paid_on TEXT,
  -- boleto | pix
  paid_via TEXT,
  -- Identificação do pagamento no banco (o comprovante da observação da baixa).
  receipt TEXT,
  -- Motivo da pendência ou da última falha, em português.
  note TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  -- Próxima consulta periódica ao banco e próxima tentativa de baixa.
  next_poll_at INTEGER,
  next_at INTEGER,
  actor TEXT NOT NULL,
  confirmed_by TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS erp_boleto_api_titles_title ON erp_boleto_api_titles(profile_id, title_id, created);
-- Um boleto vivo por conta a receber: registrar duas vezes não registra dois.
CREATE UNIQUE INDEX IF NOT EXISTS erp_boleto_api_titles_live ON erp_boleto_api_titles(profile_id, title_id)
  WHERE status IN ('registrando', 'incerto', 'registrado');
CREATE INDEX IF NOT EXISTS erp_boleto_api_titles_poll ON erp_boleto_api_titles(profile_id, status, next_poll_at);
CREATE INDEX IF NOT EXISTS erp_boleto_api_titles_work ON erp_boleto_api_titles(profile_id, settle_state, next_at);
CREATE INDEX IF NOT EXISTS erp_boleto_api_titles_ref ON erp_boleto_api_titles(profile_id, account_id, bank_ref);

-- Registro de quem ligou, configurou, registrou, alterou, baixou e de cada
-- baixa ou pendência feita pelo aviso do banco. Sem segredo no detalhe.
CREATE TABLE IF NOT EXISTS erp_boleto_api_audit (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  boleto_id TEXT,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS erp_boleto_api_audit_profile ON erp_boleto_api_audit(profile_id, created);
