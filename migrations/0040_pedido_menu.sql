-- Pedido (módulo "pedido", docs/PEDIDO.md): cardápio. Valores em centavos.
-- Os pedidos guardam uma cópia das linhas, então itens e adicionais podem
-- ser alterados ou excluídos sem mexer nos pedidos já feitos.

CREATE TABLE IF NOT EXISTS pedido_categories (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pedido_categories_profile ON pedido_categories(profile_id, position);

CREATE TABLE IF NOT EXISTS pedido_items (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL,
  -- Foto enviada pelo caminho de mídia do núcleo (POST /media): vai no
  -- WhatsApp e no painel.
  photo_media_id TEXT,
  -- Foto pública HTTPS opcional, mostrada na página do carrinho.
  image_url TEXT,
  -- 0: esgotado (aparece no cardápio sem poder pedir).
  available INTEGER NOT NULL DEFAULT 1,
  max_quantity INTEGER NOT NULL DEFAULT 20,
  -- product_retailer_id do catálogo da Meta (carrinho enviado pelo WhatsApp).
  retailer_id TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pedido_items_category ON pedido_items(profile_id, category_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS pedido_items_retailer ON pedido_items(profile_id, retailer_id) WHERE retailer_id IS NOT NULL;

-- Grupos de adicionais (ponto da carne, adicionais, sabores, tamanho),
-- reutilizáveis em vários itens. Opções em JSON:
-- [{id, name, price_cents, available}].
CREATE TABLE IF NOT EXISTS pedido_groups (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  min INTEGER NOT NULL DEFAULT 0,
  max INTEGER NOT NULL DEFAULT 1,
  options TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pedido_groups_profile ON pedido_groups(profile_id, name);

CREATE TABLE IF NOT EXISTS pedido_item_groups (
  profile_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, group_id)
);
CREATE INDEX IF NOT EXISTS pedido_item_groups_group ON pedido_item_groups(group_id);

-- Imagens do cardápio enviadas no WhatsApp antes do botão Fazer pedido
-- (mídia do núcleo: imagens ou PDF).
CREATE TABLE IF NOT EXISTS pedido_menu_images (
  profile_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (profile_id, media_id)
);
