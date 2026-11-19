-- 0133_erp_parts.sql
-- Aplicar antes de servir as novas declarações de módulo.

INSERT OR IGNORE INTO profile_modules
  (profile_id, module_id, enabled, updated, updated_by)
SELECT m.profile_id, j.value, m.enabled, m.updated, 'migration:0133'
FROM profile_modules AS m
CROSS JOIN json_each(
  '["erp-produtos","erp-vendas","erp-compras","erp-estoque","erp-financeiro"]'
) AS j
WHERE m.module_id = 'erp';

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
