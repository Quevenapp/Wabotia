"""Vínculo Wabotia: busca operações no Wabotia e as executa na API local do Hermes.

Sem dependências do Hermes, para poder ser testado sozinho. O cliente HTTP é
injetado e segue a interface de httpx.AsyncClient. Contrato: docs/HERMES-PLUGIN.md.
"""
import asyncio
import logging
import os
import re
import shlex
from collections import OrderedDict
from pathlib import Path
from urllib.parse import quote, urlsplit

PLUGIN_VERSION = "1.0.0"
PROFILE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
RUN_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,200}$")
ARTIFACT_ID = re.compile(r"^[A-Za-z0-9_-]{8,200}$")
JOB_ID = re.compile(r"^[0-9a-f-]{36}$")
MAX_ARTIFACT = 20 * 1024 * 1024
LOOPBACK = {"127.0.0.1", "localhost", "::1"}
logger = logging.getLogger("wabotia.link")


class Revoked(Exception):
    """O Wabotia recusou o token: o vínculo foi revogado ou pareado de novo."""


def hermes_root():
    home = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
    # Dentro de um perfil o HERMES_HOME aponta para profiles/<nome>.
    return home.parent.parent if home.parent.name == "profiles" else home


def profile_dirs(root):
    found = {"default": root}
    folder = root / "profiles"
    if folder.is_dir():
        for child in sorted(folder.iterdir()):
            if child.is_dir() and PROFILE.match(child.name) and child.name != "default":
                found[child.name] = child
    return found


def read_env(path, key):
    """Último valor de KEY em um .env; None quando ausente ou ilegível."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    found = None
    for line in lines:
        match = re.match(r"^\s*(?:export\s+)?" + re.escape(key) + r"\s*=\s*(.*)$", line)
        if match:
            try:
                values = shlex.split(match.group(1), comments=True)
            except ValueError:
                values = []
            found = values[0] if len(values) == 1 else None
    return found or None


def check_base(url, loopback_only=False):
    parts = urlsplit(url or "")
    local = parts.hostname in LOOPBACK
    if loopback_only:
        ok = parts.scheme == "http" and local
    else:
        ok = parts.scheme == "https" or (parts.scheme == "http" and local)
    if not ok or parts.username or parts.query or parts.fragment or parts.path not in ("", "/"):
        raise ValueError(
            "Use http://127.0.0.1:PORTA para a API local do Hermes." if loopback_only
            else "WABOTIA_URL precisa ser o endereço https da instalação, sem caminho."
        )
    return f"{parts.scheme}://{parts.netloc}"


class WabotiaLink:
    def __init__(self, base_url, token, http, api_base="http://127.0.0.1:8642", root=None):
        self.base = check_base(base_url)
        self.api = check_base(api_base, loopback_only=True)
        self.token = token
        self.http = http
        self.root = Path(root) if root else hermes_root()
        self.done = OrderedDict()
        self.active = set()
        self.tasks = set()
        self.revoked = False

    # --- Wabotia -----------------------------------------------------------
    def _auth(self):
        return {"Authorization": "Bearer " + self.token, "X-Wabotia-Plugin": PLUGIN_VERSION}

    async def poll(self):
        response = await self.http.request(
            "GET", self.base + "/api/hermes-link/poll", headers=self._auth(), timeout=40
        )
        if response.status_code == 401:
            raise Revoked()
        if response.status_code != 200:
            raise RuntimeError(f"poll HTTP {response.status_code}")
        jobs = response.json().get("jobs")
        return jobs if isinstance(jobs, list) else []

    async def report(self, job_id, result):
        response = await self.http.request(
            "POST", self.base + "/api/hermes-link/results", headers=self._auth(),
            json={"id": job_id, **result}, timeout=20,
        )
        if response.status_code == 401:
            raise Revoked()

    async def run(self):
        """Laço principal. Termina sozinho se o vínculo for revogado."""
        delay = 1
        while not self.revoked:
            try:
                jobs = await self.poll()
                delay = 1
            except Revoked:
                self.revoked = True
                logger.error("Wabotia recusou o token do vínculo. Pareie o plugin novamente pelo painel.")
                return
            except asyncio.CancelledError:
                raise
            except Exception as error:  # rede instável: espera progressiva
                logger.warning("Wabotia indisponível (%s). Nova tentativa em %ss.", type(error).__name__, delay)
                await asyncio.sleep(delay)
                delay = min(delay * 2, 60)
                continue
            for job in jobs:
                task = asyncio.ensure_future(self.handle(job))
                self.tasks.add(task)
                task.add_done_callback(self.tasks.discard)

    async def handle(self, job):
        job_id = job.get("id") if isinstance(job, dict) else None
        if not isinstance(job_id, str) or not JOB_ID.match(job_id) or job_id in self.active:
            return
        self.active.add(job_id)
        try:
            # Entrega é "pelo menos uma vez": repetição devolve o mesmo resultado.
            result = self.done.get(job_id)
            if result is None:
                result = await self.execute(job)
                if result is not None:
                    self.done[job_id] = result
                    while len(self.done) > 200:
                        self.done.popitem(last=False)
            if result is not None:
                await self.report(job_id, result)
        except Revoked:
            self.revoked = True
        except asyncio.CancelledError:
            raise
        except Exception as error:
            logger.warning("Falha ao devolver a operação %s (%s).", job.get("op"), type(error).__name__)
        finally:
            self.active.discard(job_id)

    # --- Hermes local ------------------------------------------------------
    def profiles(self):
        return [
            {"name": name, "display_name": name, "api_enabled": bool(read_env(folder / ".env", "API_SERVER_KEY"))}
            for name, folder in profile_dirs(self.root).items()
        ]

    async def execute(self, job):
        op = job.get("op")
        if op == "profiles.list":
            return {"ok": True, "http_status": 200, "body": {"profiles": self.profiles()}}
        profile = job.get("profile") or "default"
        folder = profile_dirs(self.root).get(profile) if isinstance(profile, str) else None
        if folder is None:
            return {"ok": False, "code": "bad_profile"}
        key = read_env(folder / ".env", "API_SERVER_KEY")
        if not key:
            return {"ok": False, "http_status": 401, "code": "local_unauthorized"}
        headers = {"Authorization": "Bearer " + key}
        base = self.api + ("" if profile == "default" else "/p/" + quote(profile, safe="")) + "/v1"
        timeout = max(3.0, float(job.get("deadline_ms") or 12000) / 1000 - 2)
        run_id, artifact_id = job.get("run_id"), job.get("artifact_id")
        if op == "capabilities.get":
            request = ("GET", base + "/capabilities", None)
        elif op == "runs.create" and isinstance(job.get("body"), dict):
            if job.get("idempotency_key"):
                headers["Idempotency-Key"] = str(job["idempotency_key"])[:200]
            request = ("POST", base + "/runs", job["body"])
        elif op in ("runs.get", "runs.stop") and isinstance(run_id, str) and RUN_ID.match(run_id):
            path = base + "/runs/" + quote(run_id, safe="")
            request = ("POST", path + "/stop", {}) if op == "runs.stop" else ("GET", path, None)
        elif op == "artifacts.download" and isinstance(artifact_id, str) and ARTIFACT_ID.match(artifact_id):
            return await self.artifact(job["id"], base + "/artifacts/download/" + artifact_id, headers, timeout)
        else:
            return {"ok": False, "code": "bad_op"}
        method, url, body = request
        try:
            response = await self.http.request(method, url, headers=headers, json=body, timeout=timeout)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            return {"ok": False, "code": "timeout" if "Timeout" in type(error).__name__ else "local_unreachable"}
        if not 200 <= response.status_code < 300:
            return {"ok": False, "http_status": response.status_code, "code": "local_error"}
        try:
            return {"ok": True, "http_status": response.status_code, "body": response.json()}
        except ValueError:
            return {"ok": False, "http_status": 502, "code": "local_error"}

    async def artifact(self, job_id, url, headers, timeout):
        """Download de uso único no Hermes: nunca é repetido após falha de envio."""
        try:
            response = await self.http.request("GET", url, headers=headers, timeout=timeout)
        except asyncio.CancelledError:
            raise
        except Exception:
            return {"ok": False, "code": "local_unreachable"}
        if not 200 <= response.status_code < 300:
            return {"ok": False, "http_status": response.status_code, "code": "local_error"}
        content = response.content
        if not content or len(content) > MAX_ARTIFACT:
            return {"ok": False, "code": "file_too_large" if content else "local_error"}
        try:
            sent = await self.http.request(
                "PUT", self.base + "/api/hermes-link/artifacts/" + job_id, content=content, timeout=60,
                headers={**self._auth(), "Content-Type": response.headers.get("Content-Type") or "application/octet-stream"},
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            return {"ok": False, "code": "upload_failed"}
        if sent.status_code == 401:
            raise Revoked()
        # Em caso de sucesso o próprio Wabotia conclui a operação.
        return None if sent.status_code == 200 else {"ok": False, "code": "upload_failed"}
