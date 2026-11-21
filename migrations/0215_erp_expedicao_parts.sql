-- 0215_erp_expedicao_parts.sql
-- Expedição (parte erp-expedicao): ligar, desligar ou apagar o módulo sobe a
-- revisão das partes do ERP da área, como as outras partes (0133). Só
-- acrescenta gatilhos; os da 0133 continuam iguais. A parte nasce desligada
-- (sem linha em profile_modules).

CREATE TRIGGER IF NOT EXISTS profile_erp_revision_insert_expedicao
AFTER INSERT ON profile_modules
WHEN NEW.module_id = 'erp-expedicao'
BEGIN
  INSERT INTO profile_erp_revision (profile_id, revision)
  VALUES (NEW.profile_id, 1)
  ON CONFLICT (profile_id)
  DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER IF NOT EXISTS profile_erp_revision_update_expedicao
AFTER UPDATE OF enabled ON profile_modules
WHEN OLD.enabled <> NEW.enabled
 AND NEW.module_id = 'erp-expedicao'
BEGIN
  INSERT INTO profile_erp_revision (profile_id, revision)
  VALUES (NEW.profile_id, 1)
  ON CONFLICT (profile_id)
  DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER IF NOT EXISTS profile_erp_revision_delete_expedicao
AFTER DELETE ON profile_modules
WHEN OLD.module_id = 'erp-expedicao'
BEGIN
  INSERT INTO profile_erp_revision (profile_id, revision)
  VALUES (OLD.profile_id, 1)
  ON CONFLICT (profile_id)
  DO UPDATE SET revision = revision + 1;
END;
