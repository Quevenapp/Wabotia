"""Plugin Wabotia para o Hermes Agent. O adaptador só é importado no registro."""


def register(ctx):
    from .adapter import register as register_adapter

    register_adapter(ctx)
