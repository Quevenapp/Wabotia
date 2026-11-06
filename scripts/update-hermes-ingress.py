#!/usr/bin/env python3
"""Update only a recognized Wabotia ingress extension, with the gateway stopped."""
import argparse
import hashlib
import os
import shutil
from pathlib import Path

def source():
    patch = Path(__file__).resolve().parents[1] / 'connectors/hermes/hermes-exclusive-ingress.patch'
    section = patch.read_text().split('+++ b/gateway/exclusive_ingress.py\n', 1)[1]
    return ('\n'.join(line[1:] for line in section.splitlines() if line.startswith('+')) + '\n').encode()

def main():
    parser = argparse.ArgumentParser(description='Atualiza somente a extensão Wabotia conhecida, preservando perfis e dados. Pare o gateway antes.')
    parser.add_argument('--hermes-checkout', required=True, type=Path)
    args = parser.parse_args()
    target = args.hermes_checkout.expanduser().resolve() / 'gateway/exclusive_ingress.py'
    if not target.is_file() or target.is_symlink():
        parser.error('Extensão não encontrada. Siga a instalação inicial; nenhum arquivo foi alterado.')
    original, updated = target.read_bytes(), source()
    if original == updated:
        print('A extensão já está atualizada.'); return
    if hashlib.sha256(original).hexdigest() != '42e26ccd80065851b74098f7b7c8ad5603174bcc546258ef50e9e74f35283ce6':
        parser.error('A extensão tem outra versão ou alterações locais. Revise o diff; nenhum arquivo foi alterado.')
    backup = target.with_name('exclusive_ingress.py.pre-0.5.0')
    if backup.exists():
        parser.error('Já existe um backup desta atualização. Confira antes de continuar.')
    shutil.copy2(target, backup)
    temp = target.with_name('.exclusive_ingress.py.wabotia-tmp')
    with temp.open('xb') as handle:
        handle.write(updated)
    temp.chmod(target.stat().st_mode & 0o777)
    os.replace(temp, target)
    print('Extensão atualizada; backup ao lado do arquivo. Atualize também o plugin e só depois reinicie o gateway.')

if __name__ == '__main__':
    main()
