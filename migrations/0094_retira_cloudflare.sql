-- Guarda somente nomes e IDs para a revogação manual na conta Cloudflare.
-- Os nomes usados pelo preparador vinham de spec.tunnel_name e dos hostnames.
-- Lista fechada: nunca copiar resources ou spec inteiros, nem credenciais.
UPDATE profiles
SET settings=json_set(settings, '$.retired_cloudflare', json((
  SELECT json_group_array(json_object(
    'admin_hostname', admin_hostname,
    'api_hostname', api_hostname,
    'created', created,
    'resources', json_object(
      'admin_app', CASE WHEN json_type(resources,'$.admin_app')='text' THEN json_extract(resources,'$.admin_app') END,
      'admin_app_name', json_extract(spec,'$.tunnel_name') || ' descoberta',
      'api_app', CASE WHEN json_type(resources,'$.api_app')='text' THEN json_extract(resources,'$.api_app') END,
      'api_app_name', json_extract(spec,'$.tunnel_name') || ' API',
      'service_token', CASE WHEN json_type(resources,'$.service_token')='text' THEN json_extract(resources,'$.service_token') END,
      'service_token_name', json_extract(spec,'$.tunnel_name'),
      'policy', CASE WHEN json_type(resources,'$.policy')='text' THEN json_extract(resources,'$.policy') END,
      'policy_name', json_extract(spec,'$.tunnel_name'),
      'tunnel', CASE WHEN json_type(resources,'$.tunnel')='text' THEN json_extract(resources,'$.tunnel') END,
      'tunnel_name', json_extract(spec,'$.tunnel_name'),
      'admin_dns', CASE WHEN json_type(resources,'$.admin_dns')='text' THEN json_extract(resources,'$.admin_dns') END,
      'admin_dns_name', admin_hostname,
      'api_dns', CASE WHEN json_type(resources,'$.api_dns')='text' THEN json_extract(resources,'$.api_dns') END,
      'api_dns_name', api_hostname
    )
  )) FROM (SELECT * FROM cloudflare_jobs WHERE profile_id=profiles.id ORDER BY created,id)
)))
WHERE EXISTS (SELECT 1 FROM cloudflare_jobs WHERE profile_id=profiles.id);

-- O D1 aplica o arquivo em um lote: apaga o segredo, marca e pausa juntos.
DELETE FROM secrets WHERE id IN (
  SELECT 'connection:' || json_extract(spec,'$.connection_id') FROM cloudflare_jobs
);
UPDATE connections
SET status='paused', config=json_set(config,'$.remove_pending',1,'$.retired',1)
WHERE id IN (SELECT json_extract(spec,'$.connection_id') FROM cloudflare_jobs);

DELETE FROM secrets WHERE id='cloudflare:config' OR id LIKE 'cloudflare:job:%';
DELETE FROM cloudflare_jobs;
