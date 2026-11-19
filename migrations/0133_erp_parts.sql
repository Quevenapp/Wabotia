-- 0133_erp_parts.sql
-- Aplicar antes de servir as novas declarações de módulo.

-- A versão nova grava a marca ANTES dos módulos, no mesmo batch D1.
-- Sem marca, ligar o antigo ERP ainda significa ligar o núcleo completo.
CREATE TABLE IF NOT EXISTS profile_erp_parts_managed (
  profile_id TEXT PRIMARY KEY NOT NULL
);

INSERT OR IGNORE INTO profile_modules
  (profile_id, module_id, enabled, updated, updated_by)
SELECT m.profile_id, j.value, m.enabled, m.updated, 'migration:0133'
FROM profile_modules AS m
CROSS JOIN json_each(
  '["erp-produtos","erp-vendas","erp-compras","erp-estoque","erp-financeiro"]'
) AS j
WHERE m.module_id = 'erp'
  AND NOT EXISTS (SELECT 1 FROM profile_erp_parts_managed WHERE profile_id=m.profile_id);

CREATE TRIGGER IF NOT EXISTS profile_erp_legacy_enable_insert
AFTER INSERT ON profile_modules
WHEN NEW.module_id = 'erp' AND NEW.enabled = 1
 AND NOT EXISTS (SELECT 1 FROM profile_erp_parts_managed WHERE profile_id=NEW.profile_id)
BEGIN
  INSERT INTO profile_modules (profile_id,module_id,enabled,updated,updated_by)
  SELECT NEW.profile_id, value, 1, NEW.updated, 'migration:0133-legacy'
  FROM json_each('["erp-produtos","erp-vendas","erp-compras","erp-estoque","erp-financeiro"]')
  WHERE true
  ON CONFLICT (profile_id,module_id) DO UPDATE
  SET enabled=1, updated=excluded.updated, updated_by=excluded.updated_by
  WHERE profile_modules.enabled <> 1;
END;

CREATE TRIGGER IF NOT EXISTS profile_erp_legacy_enable_update
AFTER UPDATE OF enabled ON profile_modules
WHEN NEW.module_id = 'erp' AND OLD.enabled = 0 AND NEW.enabled = 1
 AND NOT EXISTS (SELECT 1 FROM profile_erp_parts_managed WHERE profile_id=NEW.profile_id)
BEGIN
  INSERT INTO profile_modules (profile_id,module_id,enabled,updated,updated_by)
  SELECT NEW.profile_id, value, 1, NEW.updated, 'migration:0133-legacy'
  FROM json_each('["erp-produtos","erp-vendas","erp-compras","erp-estoque","erp-financeiro"]')
  WHERE true
  ON CONFLICT (profile_id,module_id) DO UPDATE
  SET enabled=1, updated=excluded.updated, updated_by=excluded.updated_by
  WHERE profile_modules.enabled <> 1;
END;

CREATE TABLE IF NOT EXISTS profile_erp_revision (
  profile_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  delivered_revision INTEGER NOT NULL DEFAULT 0
    CHECK (
      delivered_revision >= 0
      AND delivered_revision <= revision
    )
);

INSERT OR IGNORE INTO profile_erp_revision (profile_id)
SELECT DISTINCT profile_id
FROM profile_modules
WHERE module_id IN (
  'erp','erp-produtos','erp-vendas','erp-compras','erp-estoque',
  'erp-financeiro','erp-fiscal','erp-cobranca','erp-pdv'
);

CREATE TRIGGER IF NOT EXISTS profile_erp_revision_insert
AFTER INSERT ON profile_modules
WHEN NEW.module_id IN (
  'erp','erp-produtos','erp-vendas','erp-compras','erp-estoque',
  'erp-financeiro','erp-fiscal','erp-cobranca','erp-pdv'
)
BEGIN
  INSERT INTO profile_erp_revision (profile_id, revision)
  VALUES (NEW.profile_id, 1)
  ON CONFLICT (profile_id)
  DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER IF NOT EXISTS profile_erp_revision_update
AFTER UPDATE OF enabled ON profile_modules
WHEN OLD.enabled <> NEW.enabled
 AND NEW.module_id IN (
  'erp','erp-produtos','erp-vendas','erp-compras','erp-estoque',
  'erp-financeiro','erp-fiscal','erp-cobranca','erp-pdv'
)
BEGIN
  INSERT INTO profile_erp_revision (profile_id, revision)
  VALUES (NEW.profile_id, 1)
  ON CONFLICT (profile_id)
  DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER IF NOT EXISTS profile_erp_revision_delete
AFTER DELETE ON profile_modules
WHEN OLD.module_id IN (
  'erp','erp-produtos','erp-vendas','erp-compras','erp-estoque',
  'erp-financeiro','erp-fiscal','erp-cobranca','erp-pdv'
)
BEGIN
  INSERT INTO profile_erp_revision (profile_id, revision)
  VALUES (OLD.profile_id, 1)
  ON CONFLICT (profile_id)
  DO UPDATE SET revision = revision + 1;
END;
