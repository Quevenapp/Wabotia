"""Adaptador de plataforma: dá ao vínculo Wabotia o ciclo de vida do gateway.

Não é um canal de chat: não recebe mensagens (handle_message) e send() recusa.
As execuções chegam pelo vínculo e rodam na API local do Hermes.
"""
import asyncio
import logging
import os

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import BasePlatformAdapter, SendResult

try:
    from .link import WabotiaLink
except ImportError:  # carregado como arquivo solto, fora de um pacote
    import importlib.util
    from pathlib import Path

    _spec = importlib.util.spec_from_file_location("wabotia_link", Path(__file__).with_name("link.py"))
    _module = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_module)
    WabotiaLink = _module.WabotiaLink

logger = logging.getLogger("wabotia.adapter")
NAME = "wabotia"


def _env(name):
    return (os.environ.get(name) or "").strip()


def _setting(config, key, env):
    extra = getattr(config, "extra", None) or {}
    return str(extra.get(key) or "").strip() or _env(env)


class WabotiaAdapter(BasePlatformAdapter):
    def __init__(self, config: PlatformConfig):
        super().__init__(config, Platform(NAME))
        self._url = _setting(config, "url", "WABOTIA_URL")
        self._token = _setting(config, "token", "WABOTIA_LINK_TOKEN")
        self._api = _setting(config, "hermes_api", "WABOTIA_HERMES_API") or "http://127.0.0.1:8642"
        self._http = None
        self._task = None

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        import httpx

        try:
            # Sem redirecionamentos: o token só vai ao endereço configurado.
            self._http = httpx.AsyncClient(follow_redirects=False)
            link = WabotiaLink(self._url, self._token, self._http, api_base=self._api)
        except ValueError as error:
            logger.error("Plugin Wabotia não iniciado: %s", error)
            await self._close()
            return False
        self._task = asyncio.ensure_future(link.run())
        self._mark_connected()
        return True

    async def _close(self):
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    async def disconnect(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        await self._close()
        self._mark_disconnected()

    async def send(self, chat_id, content, reply_to=None, metadata=None):
        return SendResult(success=False)

    async def get_chat_info(self, chat_id):
        return {"name": "Wabotia", "type": "service"}


def check_requirements() -> bool:
    return bool(_env("WABOTIA_URL") and _env("WABOTIA_LINK_TOKEN"))


def validate_config(config) -> bool:
    return bool(_setting(config, "url", "WABOTIA_URL") and _setting(config, "token", "WABOTIA_LINK_TOKEN"))


def register(ctx):
    kwargs = dict(
        name=NAME,
        label="Wabotia",
        adapter_factory=WabotiaAdapter,
        check_fn=check_requirements,
        validate_config=validate_config,
        required_env=["WABOTIA_URL", "WABOTIA_LINK_TOKEN"],
        install_hint="Gere o comando de instalação no painel do Wabotia, em Conexões.",
    )
    # Campos de adaptadores de serviço: núcleos antigos recusam argumentos desconhecidos.
    try:
        import dataclasses

        from gateway.platform_registry import PlatformEntry

        known = {field.name for field in dataclasses.fields(PlatformEntry)}
        for key, value in (("display_tier", "minimal"), ("emoji", "🔌")):
            if key in known:
                kwargs[key] = value
    except Exception:
        pass
    ctx.register_platform(**kwargs)
