#!/usr/bin/env python3
"""Enable the native Hermes API using its CLI; never copy a bot's channels."""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import subprocess
import sys
from datetime import datetime
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def private_write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink():
        raise RuntimeError(f"O destino não pode ser um link simbólico: {path}")
    temporary = path.with_name(path.name + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(text)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def read_key(path, key):
    if not path.exists():
        return None
    found = None
    for line in path.read_text().splitlines():
        match = re.match(r"^\s*(?:export\s+)?" + re.escape(key) + r"\s*=\s*(.*)$", line)
        if match:
            values = shlex.split(match.group(1), comments=True)
            found = values[0] if len(values) == 1 else None
    if found is not None and (len(found) < 16 or "$" in found or "\n" in found):
        raise RuntimeError(f"{key} já existe em {path}, mas exige configuração manual. Não foi substituída.")
    return found


def cli(executable, profile, *args, optional=False):
    result = subprocess.run([executable, "-p", profile, *args], text=True, capture_output=True)
    if result.returncode:
        if optional:
            return None
        # CLI output/arguments can contain credentials; do not relay them.
        raise RuntimeError(f"Hermes recusou o comando {args[0]} {args[1] if len(args) > 1 else ''} no perfil {profile}. Confira o Hermes pelo terminal.")
    return result.stdout.strip()


def config_path(executable, profile, kind, optional=False):
    value = cli(executable, profile, "config", kind, optional=optional)
    if value is None:
        return None
    path = Path(value)
    if not path.is_absolute() or "\n" in value:
        raise RuntimeError("O Hermes não retornou um caminho de configuração reconhecido.")
    return path


def backup(paths, output):
    directory = output / "backups" / datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    directory.mkdir(parents=True, mode=0o700)
    manifest = []
    for index, source in enumerate(dict.fromkeys(paths)):
        if source.exists():
            destination = directory / f"{index}-{source.name}"
            private_write(destination, source.read_text())
            manifest.append({"original": str(source), "backup": str(destination)})
    private_write(directory / "manifest.json", json.dumps(manifest, indent=2))
    return directory


def prepare(args):
    executable = shutil.which(args.hermes)
    if not executable:
        raise RuntimeError("Hermes não encontrado. Instale-o primeiro ou use --hermes /caminho/do/hermes.")
    default_config = config_path(executable, "default", "path")
    default_env = config_path(executable, "default", "env-path")
    profile_config = config_path(executable, args.profile, "path", optional=True)
    if profile_config is None:
        if not args.create_profile:
            raise RuntimeError("Perfil não encontrado. Use --create-profile para criar um perfil vazio, sem copiar canais.")
        cli(executable, "default", "profile", "create", args.profile, "--no-alias",
            "--description", "Atendente conectado ao Wabotia pelas APIs nativas do Hermes.")
        profile_config = config_path(executable, args.profile, "path")
    if (profile_config.parent / "gateway.parked").exists():
        raise RuntimeError("O perfil está pausado no Hermes. Inicie-o conscientemente pelo Hermes antes de preparar a conexão.")
    multiplex = cli(executable, "default", "config", "get", "gateway.multiplex_profiles")
    if multiplex.lower() == "false":
        raise RuntimeError("gateway.multiplex_profiles está false. Este assistente usa o gateway compartilhado; revise essa opção no Hermes antes de continuar.")
    profile_env = config_path(executable, args.profile, "env-path")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(output, 0o700)
    saved = backup([default_config, default_env, profile_config, profile_env], output)
    print(f"1/4 · Backup privado: {saved}")
    listener_key = read_key(default_env, "API_SERVER_KEY") or secrets.token_hex(32)
    profile_key = listener_key if args.profile == "default" else read_key(profile_env, "API_SERVER_KEY") or secrets.token_hex(32)
    if args.profile != "default" and profile_key == listener_key:
        raise RuntimeError("As chaves do default e do perfil devem ser diferentes. Corrija a chave do perfil no Hermes.")
    admin_env = output / "backend.env"
    admin_key = read_key(admin_env, "HERMES_DASHBOARD_SESSION_TOKEN") or secrets.token_hex(32)
    private_write(admin_env, f"HERMES_DASHBOARD_SESSION_TOKEN={admin_key}\n")
    for profile, key in dict([("default", listener_key), (args.profile, profile_key)]).items():
        cli(executable, profile, "config", "set", "API_SERVER_KEY", key)
    for name, value in [("enabled", "true"), ("host", "127.0.0.1"), ("port", str(args.api_port))]:
        cli(executable, "default", "config", "set", f"gateway.api_server.{name}", value)
    print("2/4 · API nativa habilitada no loopback. Chaves existentes foram preservadas.")
    payload = {
        "name": f"Hermes · {args.profile}", "kind": "hermes", "mode": "direct",
        "config": {"url": f"https://{args.admin_hostname}" if args.admin_hostname else "",
                   "api_url": f"https://{args.api_hostname}" if args.api_hostname else ""},
        "secrets": {"dashboard_token": admin_key, "profile_keys": {args.profile: profile_key}},
    }
    private_write(output / "connection.local.json", json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    private_write(output / "chaves.local.txt", "CHAVES PRIVADAS — não publicar nem enviar no suporte.\n\n"
                  + f"Nome do perfil Hermes: {args.profile}\nToken administrativo Hermes: {admin_key}\n"
                  + f"API_SERVER_KEY desse perfil: {profile_key}\n\n"
                  + "O Client ID e o Client Secret serão criados no Cloudflare Access.\n"
                  + "Estas chaves não são MASTER_KEY nem SETUP_TOKEN do Wabotia.\n")
    # A dedicated backend leaves the Desktop's dynamic-port backend untouched.
    unit = "\n".join([
        "[Unit]", "Description=Hermes backend para descoberta Wabotia", "After=network-online.target", "",
        "[Service]", "Type=simple", f'EnvironmentFile={str(admin_env).replace(chr(37), chr(37) * 2)}',
        f'WorkingDirectory={str(profile_config.parent).replace(chr(37), chr(37) * 2)}',
        f'ExecStart="{executable}" -p {args.profile} serve --isolated --host 127.0.0.1 --port {args.admin_port} --skip-build',
        "Restart=on-failure", "RestartSec=5", "UMask=0077", "", "[Install]", "WantedBy=default.target", "",
    ])
    private_write(output / "hermes-wabotia-admin.service", unit)
    private_write(output / "state.local.json", json.dumps({"profile": args.profile, "api_port": args.api_port,
        "admin_port": args.admin_port, "config": str(profile_config), "env": str(profile_env)}, indent=2) + "\n")
    print(f"3/4 · Chaves e modelo de serviço salvos em: {output}")
    print("4/4 · Reinicie o gateway existente e inicie o backend conforme o manual. O assistente não reinicia serviços nem publica portas.")
    print(f"Depois execute: python3 scripts/prepare-hermes.py --output {shlex.quote(str(output))} --check")


def check(args):
    output = args.output.resolve()
    state = json.loads((output / "state.local.json").read_text())
    connection = json.loads((output / "connection.local.json").read_text())
    profile = state["profile"]
    prefix = "" if profile == "default" else "/p/" + profile
    services = [
        ("Descoberta", f'http://127.0.0.1:{state["admin_port"]}/api/profiles', connection["secrets"]["dashboard_token"]),
        ("API de bots", f'http://127.0.0.1:{state["api_port"]}{prefix}/v1/capabilities', connection["secrets"]["profile_keys"][profile]),
    ]
    for name, url, key in services:
        with urlopen(Request(url, headers={"Authorization": "Bearer " + key}), timeout=10) as response:
            data = json.load(response)
        if name == "API de bots":
            feature = data.get("features", {}).get("runs_idempotency", {})
            if not feature.get("supported") or not feature.get("durable"):
                raise RuntimeError("Atualize o Hermes: a API precisa anunciar idempotência durável.")
        else:
            if not any(p.get("name") == profile for p in data.get("profiles", [])):
                raise RuntimeError("A descoberta não retornou o perfil configurado.")
        try:
            with urlopen(url, timeout=10):
                raise RuntimeError(f"{name} aceitou acesso sem chave. Não publique o túnel.")
        except HTTPError as error:
            if error.code not in (401, 403):
                raise RuntimeError(f"{name}: resposta inesperada sem chave ({error.code}).") from None
        print(f"OK · {name}: autenticado e recusando acesso sem chave.")


def serve_admin(args):
    """Run the dedicated backend with a stable token, also usable inside Docker."""
    output = args.output.resolve()
    state = json.loads((output / "state.local.json").read_text())
    token = read_key(output / "backend.env", "HERMES_DASHBOARD_SESSION_TOKEN")
    executable = shutil.which(args.hermes)
    if not token or not executable:
        raise RuntimeError("Execute a preparação primeiro e confira o caminho do Hermes.")
    environment = dict(os.environ, HERMES_DASHBOARD_SESSION_TOKEN=token)
    os.execve(executable, [executable, "-p", state["profile"], "serve", "--isolated",
              "--host", "127.0.0.1", "--port", str(state["admin_port"]), "--skip-build"], environment)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", default="wabotia")
    parser.add_argument("--create-profile", action="store_true")
    parser.add_argument("--hermes", default="hermes")
    parser.add_argument("--output", type=Path, default=Path.home() / ".config" / "wabotia" / "hermes")
    parser.add_argument("--api-port", type=int, default=8642)
    parser.add_argument("--admin-port", type=int, default=9119)
    parser.add_argument("--admin-hostname", default="")
    parser.add_argument("--api-hostname", default="")
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--check", action="store_true")
    action.add_argument("--serve-admin", action="store_true", help="Mantém o backend dedicado ligado neste processo.")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", args.profile):
        parser.error("Nome de perfil inválido.")
    if any(not 1 <= port <= 65535 for port in [args.api_port, args.admin_port]) or args.api_port == args.admin_port:
        parser.error("Use duas portas válidas e diferentes.")
    for hostname in [args.admin_hostname, args.api_hostname]:
        if hostname and (not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}", hostname) or ".." in hostname):
            parser.error("Informe somente o hostname, sem https:// ou caminho.")
    try:
        if args.check:
            check(args)
        elif args.serve_admin:
            serve_admin(args)
        else:
            prepare(args)
    except (OSError, ValueError, RuntimeError) as error:
        print(f"Não concluído: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
