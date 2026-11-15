-- Módulos embutidos (docs/MODULOS.md): estado ligado/desligado por área de
-- atendimento. Sem linha, vale o padrão declarado pelo módulo em src/modules.
CREATE TABLE IF NOT EXISTS profile_modules (
  profile_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (profile_id, module_id)
);
-- A fila de senhas já existia antes dos módulos: instalações existentes
-- continuam com ela ligada, registrado de forma explícita.
INSERT OR IGNORE INTO profile_modules(profile_id,module_id,enabled,updated,updated_by)
SELECT id,'queue',1,CAST(strftime('%s','now') AS INTEGER)*1000,'migration' FROM profiles;
