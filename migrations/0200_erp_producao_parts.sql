-- 0200_erp_producao_parts.sql
-- Parte nova do ERP: Produção (erp-producao, ordem de produção; depende de
-- Estoque e Produtos, desligada por padrão). Só adição: os gatilhos da 0133
-- sobem a revisão das partes quando um módulo do ERP liga, desliga ou some,
-- para o motor receber o estado novo; estes fazem o mesmo para erp-producao.
-- Nada é ligado aqui: a área liga a Produção em Gestão → Módulos.

INSERT OR IGNORE INTO profile_erp_revision (profile_id)
SELECT DISTINCT profile_id
FROM profile_modules
WHERE module_id = 'erp-producao';

CREATE TRIGGER IF NOT EXISTS profile_erp_revision_producao_insert
AFTER INSERT ON profile_modules
WHEN NEW.module_id = 'erp-producao'
BEGIN
  INSERT INTO profile_erp_revision (profile_id, revision)
  VALUES (NEW.profile_id, 1)
  ON CONFLICT (profile_id)
  DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER IF NOT EXISTS profile_erp_revision_producao_update
AFTER UPDATE OF enabled ON profile_modules
WHEN OLD.enabled <> NEW.enabled AND NEW.module_id = 'erp-producao'
BEGIN
  INSERT INTO profile_erp_revision (profile_id, revision)
  VALUES (NEW.profile_id, 1)
  ON CONFLICT (profile_id)
  DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER IF NOT EXISTS profile_erp_revision_producao_delete
AFTER DELETE ON profile_modules
WHEN OLD.module_id = 'erp-producao'
BEGIN
  INSERT INTO profile_erp_revision (profile_id, revision)
  VALUES (OLD.profile_id, 1)
  ON CONFLICT (profile_id)
  DO UPDATE SET revision = revision + 1;
END;
