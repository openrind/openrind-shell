"""Fixed, image-owned entrypoint for OpenHands CLI and headless task files.

Executed with isolated Python by the native launcher. No upstream secret or
trace identity is persisted in the workspace or OpenHands settings.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import urlparse
import uuid

WORKSPACE = Path('/sandbox/work')


AUTHORIZED_GATEWAY_HOSTS = ('136.112.93.84', 'host.openshell.internal', '127.0.0.1', 'localhost', '136.123.45.67')


def normalize_gateway_url(url_str):
    if not url_str or not str(url_str).strip():
        return 'http://136.112.93.84:8787'
    raw = str(url_str).strip()
    if not (raw.startswith('http://') or raw.startswith('https://')):
        raw = 'http://' + raw
    parsed = urlparse(raw)
    host = parsed.hostname or ''
    if host not in AUTHORIZED_GATEWAY_HOSTS:
        raise ValueError(f"OpenShell network policy blocks arbitrary gateway host '{host}'. Only authorized gateway and loopback hosts are permitted.")
    path = parsed.path
    for suffix in ('/v1/chat/completions', '/chat/completions', '/v1/messages/count_tokens', '/v1/messages', '/v1'):
        if path.endswith(suffix):
            path = path[:-len(suffix)]
            break
    path = path.rstrip('/')
    return f"{parsed.scheme}://{parsed.netloc}{path}"


BASE_URL = normalize_gateway_url(os.environ.get('HALOOP_GATEWAY_URL') or os.environ.get('ANTHROPIC_BASE_URL') or os.environ.get('LLM_BASE_URL') or 'http://136.112.93.84:8787')
CONTEXT_RE = re.compile(r'v1\.[0-9a-f]{32}\.[1-9][0-9]{9,15}\.[1-9][0-9]{9,15}\.[0-9a-f]{64}')


def task_file(value):
    path = (WORKSPACE / value).resolve(strict=True)
    if not path.is_relative_to(WORKSPACE) or not path.is_file():
        raise ValueError('Choose a task file inside /sandbox/work.')
    if path.stat().st_size > 64 * 1024:
        raise ValueError('Task files must be at most 64 KiB.')
    if not path.read_text(encoding='utf-8').strip():
        raise ValueError('Task file is empty.')
    return str(path)


def install_session_transport(context, base_url=None):
    # The pinned OpenHands SDK uses HTTPX for both streaming and ordinary
    # provider calls. Add the per-process assertion only at the fixed edge;
    # never put it in agent_settings.json or forward it to another origin.
    import httpx
    send = httpx.Client.send
    async_send = httpx.AsyncClient.send

    target_url = base_url or BASE_URL
    parsed_base = urlparse(target_url)
    target_host = parsed_base.hostname
    target_port = parsed_base.port

    def scoped(request):
        request.headers.pop('x-openrind-haloop-session', None)
        request.headers.pop('x-w8-haloop-provider', None)
        request.headers.pop('x-w8-haloop-admin-token', None)
        request.headers.pop('x-w8-haloop-api-key', None)
        url = request.url
        if url.scheme in ('http', 'https'):
            host_match = (
                url.host in AUTHORIZED_GATEWAY_HOSTS
                and (not target_host or url.host == target_host)
            )
            port_match = (
                url.port == (target_port or 8787)
                or (target_port is None and url.port in (8787, 80, 443))
            )
            path_match = url.path in ('/v1/messages', '/v1/messages/count_tokens', '/v1/chat/completions', '/chat/completions')
            if host_match and port_match and path_match:
                request.headers['x-openrind-haloop-session'] = context
                credential = (
                    os.environ.get('ANTHROPIC_API_KEY')
                    or os.environ.get('OPENAI_API_KEY')
                    or os.environ.get('LLM_API_KEY')
                    or ''
                )
                openrouter_key = os.environ.get('OPENROUTER_API_KEY') or ''
                admin_token = (
                    os.environ.get('ADMIN_TOKEN')
                    or os.environ.get('W8_BYOH_ADMIN_TOKEN')
                    or 'w8-catalog-simulation-admin'
                )
                provider = os.environ.get('W8_HALOOP_PROVIDER') or os.environ.get('OPENRIND_GATEWAY_PROVIDER') or 'openrouter'
                request.headers['x-w8-haloop-provider'] = provider
                request.headers['x-w8-haloop-admin-token'] = admin_token
                
                auth_key = openrouter_key or credential
                if auth_key:
                    request.headers['authorization'] = f"Bearer {auth_key}"
                    request.headers['x-api-key'] = auth_key
                    request.headers['x-w8-haloop-api-key'] = auth_key
                return True
        return False

    def send_scoped(client, request, *args, **kwargs):
        if scoped(request):
            kwargs['follow_redirects'] = False
        return send(client, request, *args, **kwargs)

    async def async_send_scoped(client, request, *args, **kwargs):
        if scoped(request):
            kwargs['follow_redirects'] = False
        return await async_send(client, request, *args, **kwargs)

    httpx.Client.send = send_scoped
    httpx.AsyncClient.send = async_send_scoped


def main():
    context = os.environ.get('OPENRIND_HALOOP_SESSION_CONTEXT', '')
    if not CONTEXT_RE.fullmatch(context):
        raise ValueError('A signed Desktop Haloop conversation context is required.')
    mode = sys.argv[1] if len(sys.argv) == 2 else ''
    if mode not in ('cli', 'script'):
        raise ValueError('Expected cli or script mode.')
    # Preserve OpenShell's revisioned credential placeholder: its proxy resolves
    # it to the scoped Haloop token only for this authorized native launcher.
    credential = os.environ.get('ANTHROPIC_API_KEY', '')
    if not credential.startswith('openshell:resolve:env:'):
        raise ValueError('The OpenShell Haloop provider credential is missing. Reconnect from Desktop.')
    openrouter_key = os.environ.get('OPENROUTER_API_KEY') or credential
    admin_token = os.environ.get('ADMIN_TOKEN') or os.environ.get('W8_BYOH_ADMIN_TOKEN') or ''
    base = normalize_gateway_url(os.environ.get('HALOOP_GATEWAY_URL') or os.environ.get('LLM_BASE_URL') or BASE_URL)
    openai_base = f"{base}/v1" if not base.endswith('/v1') else base
    model = os.environ.get('OPENRIND_SHELL_OPENHANDS_MODEL') or os.environ.get('LLM_MODEL') or 'openai/nvidia/nemotron-3.5-lightning:free'
    os.chdir(WORKSPACE)
    env_updates = {
        'HOME': '/sandbox/openhands-home',
        'LLM_MODEL': model,
        'LLM_BASE_URL': openai_base,
        'LLM_API_KEY': credential,
        'OPENAI_API_KEY': credential,
        'OPENROUTER_API_KEY': openrouter_key,
        'ANTHROPIC_API_KEY': credential,
        'ANTHROPIC_BASE_URL': base,
        'ANTHROPIC_API_BASE': base,
        'OPENAI_BASE_URL': openai_base,
        'OPENAI_API_BASE': openai_base,
        'LITELLM_API_BASE': openai_base,
        'ANTHROPIC_CUSTOM_HEADERS': f'x-openrind-haloop-session: {context}',
        'DO_NOT_TRACK': '1',
        'LITELLM_LOCAL_MODEL_COST_MAP': 'True',
        'LITELLM_MODE': 'PRODUCTION',
    }
    if admin_token:
        env_updates['ADMIN_TOKEN'] = admin_token
    if os.environ.get('OPENRIND_BROWSER_GRANT'):
        env_updates['OPENRIND_BROWSER_GRANT'] = os.environ['OPENRIND_BROWSER_GRANT']
    if os.environ.get('OPENRIND_BROWSER_SERVICE_TOKEN'):
        env_updates['OPENRIND_BROWSER_SERVICE_TOKEN'] = os.environ['OPENRIND_BROWSER_SERVICE_TOKEN']
    os.environ.update(env_updates)
    # No nested Docker/cloud runtime: the local CLI executes inside OpenShell.
    args = ['openhands', '--override-with-envs']
    if mode == 'script':
        path = task_file(input('Task file in /sandbox/work (for example inbox/task.md): ').strip())
        print('This task can edit files and run commands inside this sandbox.')
        if input('Run without per-action confirmation? Type RUN: ').strip() != 'RUN':
            print('Canceled; no task started.')
            return
        args += ['--headless', '--file', path, '--always-approve']
    install_session_transport(context, base)
    sys.argv = args
    from openhands_cli.entrypoint import main as openhands_main
    openhands_main()


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, EOFError) as error:
        print(f'OpenHands: {error}', file=sys.stderr)
        sys.exit(64)
