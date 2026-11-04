#!/usr/bin/env python3
"""Install into an explicitly selected Hermes profile without changing its bots."""
import argparse, getpass, json, shutil, os
from pathlib import Path
p=argparse.ArgumentParser(description='Instalar transporte Wabotia em um perfil Hermes existente')
p.add_argument('--profile-home', required=True, type=Path)
p.add_argument('--url', required=True)
p.add_argument('--connection-id', required=True)
p.add_argument('--platform',choices=['whatsapp','whatsapp_cloud'],required=True)
a=p.parse_args(); home=a.profile_home.expanduser().resolve()
if not home.is_dir() or not (home/'config.yaml').exists():p.error('O perfil deve existir e conter config.yaml. Não foi alterado.')
if not a.url.startswith('https://'):p.error('Use HTTPS.')
binding=home/'exclusive-ingress.json'; rows=json.loads(binding.read_text()) if binding.exists() else []
if any(r['platform']==a.platform and r['consumer']!='wabotia_transport' for r in rows):p.error('Este canal pertence a outro consumidor. Pause e migre explicitamente antes de instalar.')
token=getpass.getpass('Chave do conector (não aparece na tela): ')
if not token:p.error('A chave é obrigatória.')
target=home/'plugins'/'wabotia_transport'; target.parent.mkdir(exist_ok=True)
if target.exists():shutil.copytree(target,target.with_name('wabotia_transport.backup'),dirs_exist_ok=True)
shutil.copytree(Path(__file__).resolve().parents[1]/'connectors'/'hermes',target,dirs_exist_ok=True)
cfg=home/'wabotia-connector.json'
fd=os.open(cfg,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'w') as f:json.dump({'url':a.url,'connection_id':a.connection_id,'platform':a.platform,'token':token},f)
if not any(r['platform']==a.platform for r in rows):rows.append({'platform':a.platform,'consumer':'wabotia_transport'})
if binding.exists():shutil.copy2(binding,binding.with_suffix('.json.backup'))
binding.write_text(json.dumps(rows,indent=2));binding.chmod(0o600)
print('Instalado. Aplique a extensão compatível no checkout Hermes com o gateway parado e habilite wabotia_transport em modo in_process. Reinicie e teste no Wabotia. Não removemos bots nem dados.')
