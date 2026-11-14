"""Offline contract tests for the image-owned OpenHands adapter."""
import asyncio
import importlib.util
from pathlib import Path
import sys
import types
from unittest.mock import patch

import httpx
import pytest

SOURCE = Path(__file__).resolve().parents[1] / 'sandboxes/openeral/openhands-agent.py'
SPEC = importlib.util.spec_from_file_location('openhands_adapter', SOURCE)
adapter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(adapter)
CONTEXT = 'v1.' + 'a' * 32 + '.1700000000000.1700000001000.' + 'b' * 64


@pytest.fixture
def transport():
    with patch.object(httpx.Client, 'send', httpx.Client.send), patch.object(httpx.AsyncClient, 'send', httpx.AsyncClient.send):
        adapter.install_session_transport(CONTEXT)
        yield


@pytest.mark.parametrize('url,expected', [
    (adapter.BASE_URL + '/v1/messages', CONTEXT),
    (adapter.BASE_URL + '/v1/messages/count_tokens', CONTEXT),
    (adapter.BASE_URL + '/v1/chat/completions', CONTEXT),
    (adapter.BASE_URL + '/other', None),
    ('https://example.invalid/v1/messages', None),
    ('http://host.openshell.internal:9999/v1/messages', None),
])
def test_scoped_header_sync_and_async(transport, monkeypatch, url, expected):
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'test-cred')
    def respond(request):
        assert request.headers.get('x-openrind-haloop-session') == expected
        if expected:
            assert request.headers.get('x-api-key') == 'test-cred'
            assert request.headers.get('authorization') == 'Bearer test-cred'
        return httpx.Response(200, json={})
    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        client.post(url, headers={'x-openrind-haloop-session': 'untrusted'})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            await client.post(url, headers={'x-openrind-haloop-session': 'untrusted'})
    asyncio.run(run())


def test_assertion_cannot_follow_redirect(transport):
    seen = []
    def respond(request):
        seen.append(str(request.url))
        return httpx.Response(307, headers={'location': 'https://example.invalid/v1/messages'})
    with httpx.Client(transport=httpx.MockTransport(respond), follow_redirects=True) as client:
        assert client.post(adapter.BASE_URL + '/v1/messages').status_code == 307
    assert seen == [adapter.BASE_URL + '/v1/messages']


def test_task_file_is_bounded_to_workspace(tmp_path, monkeypatch):
    workspace = tmp_path / 'work'
    workspace.mkdir()
    monkeypatch.setattr(adapter, 'WORKSPACE', workspace)
    task = workspace / 'task.md'
    task.write_text('Create hello.txt', encoding='utf-8')
    assert adapter.task_file('task.md') == str(task)
    outside = tmp_path / 'outside.md'
    outside.write_text('outside', encoding='utf-8')
    with pytest.raises(ValueError):
        adapter.task_file('../outside.md')
    task.write_text('x' * (64 * 1024 + 1))
    with pytest.raises(ValueError):
        adapter.task_file('task.md')
    task.write_text('   ')
    with pytest.raises(ValueError):
        adapter.task_file('task.md')


@pytest.mark.parametrize('mode,confirmation,runs', [('cli', '', True), ('script', 'RUN', True), ('script', 'no', False)])
def test_launcher_selects_local_cli_or_headless(tmp_path, monkeypatch, mode, confirmation, runs):
    task = tmp_path / 'task.md'
    task.write_text('Create hello.txt', encoding='utf-8')
    monkeypatch.setattr(adapter, 'WORKSPACE', tmp_path)
    monkeypatch.setenv('OPENRIND_HALOOP_SESSION_CONTEXT', CONTEXT)
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'openshell:resolve:env:v1_ANTHROPIC_API_KEY')
    monkeypatch.setattr(sys, 'argv', ['adapter', mode])
    monkeypatch.setattr(adapter, 'install_session_transport', lambda context, *args, **kwargs: None)
    answers = iter(['task.md', confirmation])
    monkeypatch.setattr('builtins.input', lambda _: next(answers))
    calls = []
    entrypoint = types.ModuleType('openhands_cli.entrypoint')
    entrypoint.main = lambda: calls.append(list(sys.argv))
    monkeypatch.setitem(sys.modules, 'openhands_cli.entrypoint', entrypoint)
    with patch.dict('os.environ'), patch.object(adapter.os, 'chdir'):
        adapter.main()
        assert adapter.os.environ['LLM_BASE_URL'] == f"{adapter.BASE_URL}/v1"
        assert adapter.os.environ['LLM_API_KEY'] == 'openshell:resolve:env:v1_ANTHROPIC_API_KEY'
        assert adapter.os.environ['ANTHROPIC_API_KEY'] == 'openshell:resolve:env:v1_ANTHROPIC_API_KEY'
        assert adapter.os.environ['ANTHROPIC_BASE_URL'] == adapter.BASE_URL
        assert adapter.os.environ['ANTHROPIC_API_BASE'] == adapter.BASE_URL
        assert adapter.os.environ['OPENAI_BASE_URL'] == f"{adapter.BASE_URL}/v1"
        assert adapter.os.environ['OPENAI_API_BASE'] == f"{adapter.BASE_URL}/v1"
        assert adapter.os.environ['LITELLM_API_BASE'] == f"{adapter.BASE_URL}/v1"
        assert adapter.os.environ['ANTHROPIC_CUSTOM_HEADERS'] == f'x-openrind-haloop-session: {CONTEXT}'
    assert bool(calls) == runs
    if runs:
        assert calls[0][:2] == ['openhands', '--override-with-envs']
        assert ('--headless' in calls[0]) == (mode == 'script')
        assert 'serve' not in calls[0]


def test_launch_requires_signed_context(monkeypatch):
    monkeypatch.delenv('OPENRIND_HALOOP_SESSION_CONTEXT', raising=False)
    with pytest.raises(ValueError, match='signed Desktop'):
        adapter.main()


def test_launch_rejects_missing_provider_credential(monkeypatch):
    monkeypatch.setenv('OPENRIND_HALOOP_SESSION_CONTEXT', CONTEXT)
    monkeypatch.delenv('ANTHROPIC_API_KEY', raising=False)
    monkeypatch.setattr(sys, 'argv', ['adapter', 'cli'])
    with pytest.raises(ValueError, match='provider credential'):
        adapter.main()


@pytest.mark.parametrize('input_url,expected', [
    ('http://10.0.0.1:8787/v1/chat/completions', 'http://10.0.0.1:8787'),
    ('http://10.0.0.1/v1/chat/completions', 'http://10.0.0.1'),
    ('http://host.openshell.internal:8787/v1/messages', 'http://host.openshell.internal:8787'),
    ('http://host.openshell.internal:8787/chat/completions', 'http://host.openshell.internal:8787'),
    ('10.0.0.1:8787/v1/chat/completions', 'http://10.0.0.1:8787'),
    ('', ''),
    (None, ''),
])
def test_normalize_gateway_url(input_url, expected):
    assert adapter.normalize_gateway_url(input_url) == expected


def test_custom_gateway_url_attaches_session_header():
    custom_url = 'http://136.123.45.67:8787/v1/chat/completions'
    base_url = adapter.normalize_gateway_url(custom_url)
    assert base_url == 'http://136.123.45.67:8787'

    def respond(request):
        assert request.headers.get('x-openrind-haloop-session') == CONTEXT
        return httpx.Response(200, json={})

    with patch.object(httpx.Client, 'send', httpx.Client.send):
        adapter.install_session_transport(CONTEXT, base_url)
        with httpx.Client(transport=httpx.MockTransport(respond)) as client:
            client.post('http://136.123.45.67:8787/v1/chat/completions')
            client.post('http://136.123.45.67:8787/v1/messages')
