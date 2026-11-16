-- Vendas e orçamento (módulo "vendas", docs/VENDAS.md): catálogo de produtos
-- por área, com estoque e dados fiscais. O Caixa (módulo "caixa") usa o mesmo
-- catálogo. Valores em centavos; quantidades e estoque em milésimos da
-- unidade (1 kg = 1000), para vender fracionado sem erro de arredondamento.

CREATE TABLE IF NOT EXISTS vendas_categories (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  -- Cor do botão da categoria na grade do caixa (#RRGGBB) ou vazio.
  color TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS vendas_categories_profile ON vendas_categories(profile_id, position);

CREATE TABLE IF NOT EXISTS vendas_products (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  category_id TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL,
  -- Custo (opcional): margem nos relatórios; nunca sai para o cliente.
  cost_cents INTEGER,
  -- Unidade comercial (UN, KG, L, M, CX…): uCom da nota.
  unit TEXT NOT NULL DEFAULT 'UN',
  -- 1: aceita quantidade fracionada (balança).
  fractional INTEGER NOT NULL DEFAULT 0,
  -- GTIN/EAN (8, 12, 13 ou 14 dígitos, com dígito verificador) e código interno.
  ean TEXT,
  sku TEXT,
  -- Foto enviada pelo caminho de mídia do núcleo (POST /media), guardada no R2.
  photo_media_id TEXT,
  -- 0: arquivado (some da grade e das buscas; continua nas vendas antigas).
  active INTEGER NOT NULL DEFAULT 1,
  -- Estoque: só os produtos com track_stock=1 têm saldo e movimentos.
  track_stock INTEGER NOT NULL DEFAULT 1,
  allow_negative INTEGER NOT NULL DEFAULT 0,
  stock_milli INTEGER NOT NULL DEFAULT 0,
  min_stock_milli INTEGER NOT NULL DEFAULT 0,
  -- Campos fiscais da NF-e/NFC-e (NCM, CEST, CFOP, origem, CST/CSOSN,
  -- unidade tributável, alíquotas…), validados em src/modules/vendas/model.ts.
  fiscal TEXT NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  -- Saldo negativo só com allow_negative: a baixa de uma venda que deixaria o
  -- saldo abaixo de zero falha e desfaz o lote inteiro (venda e movimentos).
  CHECK (track_stock = 0 OR allow_negative = 1 OR stock_milli >= 0)
);
CREATE INDEX IF NOT EXISTS vendas_products_category ON vendas_products(profile_id, category_id, position);
CREATE INDEX IF NOT EXISTS vendas_products_name ON vendas_products(profile_id, name COLLATE NOCASE);
CREATE UNIQUE INDEX IF NOT EXISTS vendas_products_ean ON vendas_products(profile_id, ean) WHERE ean IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS vendas_products_sku ON vendas_products(profile_id, sku) WHERE sku IS NOT NULL;

-- Movimentos de estoque: entrada, saída, ajuste (inventário), venda,
-- devolução e cancelamento. `key` é única por área: repetir a mesma baixa
-- (venda reenviada, gancho repetido) falha e desfaz o lote, sem baixar duas
-- vezes.
CREATE TABLE IF NOT EXISTS vendas_stock_moves (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  type TEXT NOT NULL,
  -- Variação do saldo (negativa nas saídas e vendas).
  quantity_milli INTEGER NOT NULL,
  -- Saldo depois do movimento.
  balance_milli INTEGER NOT NULL,
  -- Registro de origem: sale, return, manual.
  ref_type TEXT NOT NULL DEFAULT 'manual',
  ref_id TEXT,
  key TEXT NOT NULL,
  cost_cents INTEGER,
  note TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS vendas_stock_moves_key ON vendas_stock_moves(profile_id, key);
CREATE INDEX IF NOT EXISTS vendas_stock_moves_product ON vendas_stock_moves(profile_id, product_id, created);
CREATE INDEX IF NOT EXISTS vendas_stock_moves_ref ON vendas_stock_moves(profile_id, ref_type, ref_id);
