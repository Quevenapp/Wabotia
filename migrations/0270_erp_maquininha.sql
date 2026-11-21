-- Maquininha integrada ao caixa (src/erp/terminal/): a configuração da área,
-- o terminal de cada caixa do PDV e cada cobrança enviada à maquininha, com o
-- registro do que foi feito. A credencial própria (Access Token e assinatura
-- do aviso) fica no cofre do núcleo (tabela secrets, cifrada com a
-- MASTER_KEY), nunca aqui; com a conta da Cobrança, vale a dela.
-- Só tabelas novas; nada é apagado nem reescrito.

-- Configuração da área: nasce desligada.
CREATE TABLE IF NOT EXISTS erp_terminal_settings (
  profile_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  -- mercadopago
  provider TEXT NOT NULL DEFAULT 'mercadopago',
  -- cobranca (a conta do Mercado Pago da Cobrança) | propria (cofre: erp-maquininha:<área>)
  credential TEXT NOT NULL DEFAULT 'cobranca',
  -- Formas de pagamento do ERP (erp_catalog__payment_method.id) que vão para a maquininha.
  debit_method_id TEXT,
  credit_method_id TEXT,
  max_installments INTEGER NOT NULL DEFAULT 12,
  -- loja (sem juros para o cliente) | cliente
  installments_cost TEXT NOT NULL DEFAULT 'loja',
  -- SHA-256 do código do endereço do aviso (webhook) desta área.
  webhook_hash TEXT,
  enabled_by TEXT,
  enabled_at INTEGER,
  updated_by TEXT NOT NULL,
  updated INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS erp_terminal_settings_webhook ON erp_terminal_settings(webhook_hash) WHERE webhook_hash IS NOT NULL;

-- A maquininha de cada caixa (loja do PDV: erp_finance__account.id do tipo caixa).
CREATE TABLE IF NOT EXISTS erp_terminal_cashiers (
  profile_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated INTEGER NOT NULL,
  PRIMARY KEY (profile_id, account_id)
);

-- Cada cobrança enviada à maquininha (uma venda pode ter várias tentativas,
-- mas nunca duas em andamento ao mesmo tempo).
CREATE TABLE IF NOT EXISTS erp_terminal_payments (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  -- Venda do PDV (erp_pos__sale.id) e caixa (erp_finance__account.id).
  sale_id TEXT NOT NULL,
  sale_number TEXT,
  account_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  device_id TEXT NOT NULL,
  -- Forma de pagamento do ERP das parcelas cobradas.
  payment_method_id TEXT NOT NULL,
  -- debito | credito
  kind TEXT NOT NULL,
  installments INTEGER NOT NULL DEFAULT 1,
  amount_cents INTEGER NOT NULL,
  -- Referência do Vinki no provedor (referência externa): a mesma em cada reenvio.
  reference TEXT NOT NULL,
  -- Id da cobrança no provedor (intenção de pagamento) e do pagamento do cartão.
  provider_ref TEXT,
  provider_payment_id TEXT,
  -- enviando | aguardando | processando | aprovado | recusado | cancelado | incerto | erro
  status TEXT NOT NULL,
  -- O motivo em palavras (recusa, cancelamento, onde a cobrança está).
  reason TEXT,
  brand TEXT,
  authorization_code TEXT,
  nsu TEXT,
  card_last4 TEXT,
  fee_cents INTEGER,
  paid_at INTEGER,
  -- A venda foi finalizada com este pagamento (0 ou 1) e quando.
  sale_finished_at INTEGER,
  -- Conciliação de cartões: matched | pending | skipped, e o porquê.
  reconcile_state TEXT,
  reconcile_note TEXT,
  -- Comando do caixa (repetir o mesmo pedido devolve a mesma cobrança).
  command_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  checked_at INTEGER,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS erp_terminal_payments_command ON erp_terminal_payments(profile_id, command_id);
CREATE INDEX IF NOT EXISTS erp_terminal_payments_sale ON erp_terminal_payments(profile_id, sale_id, created);
CREATE INDEX IF NOT EXISTS erp_terminal_payments_ref ON erp_terminal_payments(profile_id, provider_ref);
CREATE INDEX IF NOT EXISTS erp_terminal_payments_day ON erp_terminal_payments(profile_id, created);

-- O que foi feito (sem segredo, sem dado de cartão além da bandeira e do final).
CREATE TABLE IF NOT EXISTS erp_terminal_audit (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  payment_id TEXT,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS erp_terminal_audit_profile ON erp_terminal_audit(profile_id, created);
