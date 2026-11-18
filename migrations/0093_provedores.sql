-- Aditiva: os cofres antigos continuam disponíveis para a versão anterior.
CREATE TABLE IF NOT EXISTS ai_providers(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('openai','anthropic','deepseek','compatible','typesafe')),
  credential TEXT NOT NULL DEFAULT 'api_key',
  base_url TEXT,
  profiles TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
  capabilities TEXT NOT NULL DEFAULT '{}',
  models TEXT NOT NULL DEFAULT '[]',
  prices TEXT NOT NULL DEFAULT '{}',
  key_fingerprint TEXT,
  verified_at INTEGER,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_usage_daily(
  provider_id TEXT NOT NULL, profile_id TEXT NOT NULL, use TEXT NOT NULL,
  model TEXT NOT NULL, day TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0, input INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0, audio_seconds INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(provider_id, profile_id, use, model, day)
);
INSERT OR IGNORE INTO ai_providers(id,name,kind,base_url,profiles,capabilities,created,updated)
SELECT 'p-'||id, coalesce(nullif(name,''),json_extract(config,'$.provider')),
  json_extract(config,'$.provider'), json_extract(config,'$.base_url'), json_array(profile_id),
  json_object('text',json('true'),
    'image',json(CASE WHEN json_extract(config,'$.vision') THEN 'true' ELSE 'false' END),
    'pdf',json(CASE WHEN json_extract(config,'$.pdf') THEN 'true' ELSE 'false' END),
    'tools',json(CASE WHEN json_extract(config,'$.tools_unsupported_at') IS NULL THEN 'true' ELSE 'false' END)),
  created, created
FROM connections WHERE kind='ai' AND json_extract(config,'$.provider_id') IS NULL;
INSERT OR IGNORE INTO secrets(id,value)
SELECT 'provider:p-'||c.id,s.value FROM secrets s JOIN connections c ON s.id='connection:'||c.id
WHERE c.kind='ai' AND json_extract(c.config,'$.provider_id') IS NULL;
UPDATE connections SET config=json_set(config,'$.provider_id','p-'||id)
WHERE kind='ai' AND json_extract(config,'$.provider_id') IS NULL;
INSERT OR IGNORE INTO ai_providers(id,name,kind,profiles,capabilities,created,updated)
SELECT 'p-jev-'||p.id,'TypeSafe (JEV)','typesafe',json_array(p.id),'{"decision":true}',p.created,p.created
FROM profiles p JOIN secrets s ON s.id='jev:'||p.id
WHERE json_extract(p.settings,'$.jev_provider_id') IS NULL;
INSERT OR IGNORE INTO secrets(id,value)
SELECT 'provider:p-jev-'||p.id,s.value FROM profiles p JOIN secrets s ON s.id='jev:'||p.id
WHERE json_extract(p.settings,'$.jev_provider_id') IS NULL;
UPDATE profiles SET settings=json_set(settings,'$.jev_provider_id','p-jev-'||id)
WHERE EXISTS(SELECT 1 FROM secrets WHERE secrets.id='jev:'||profiles.id)
  AND json_extract(settings,'$.jev_provider_id') IS NULL;
