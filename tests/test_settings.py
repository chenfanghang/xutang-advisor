"""从 HTTP 接口验证模型配置行为。"""

from pathlib import Path

import httpx2
import pytest
from fastapi.testclient import TestClient

from backend.app import create_app


def test_settings_survive_restart_without_returning_key(tmp_path: Path) -> None:
    """保存后重启应用仍可读取配置，且响应不含密钥。"""
    path = tmp_path / "config.local.json"
    with TestClient(create_app(path)) as client:
        response = client.put(
            "/api/settings",
            json={
                "base_url": "https://api.deepseek.com",
                "model": "deepseek-flash",
                "api_key": "sk-fictional-test-key",
            },
        )
        assert response.status_code == 200
        assert "sk-fictional-test-key" not in response.text

    with TestClient(create_app(path)) as restarted:
        response = restarted.get("/api/settings")
        assert response.json() == {
            "base_url": "https://api.deepseek.com",
            "model": "deepseek-flash",
            "api_key_configured": True,
        }


def test_connection_uses_current_form_without_saving(
    tmp_path: Path, model_server: str
) -> None:
    """测试按钮实际调用表单指定的服务，但不隐式保存配置。"""
    with TestClient(create_app(tmp_path / "config.local.json")) as client:
        response = client.post(
            "/api/settings/test",
            json={
                "base_url": model_server,
                "model": "fixture-model",
                "api_key": "sk-fictional-test-key",
            },
        )
        assert response.status_code == 200
        assert response.json()["ok"] is True
        assert "sk-fictional-test-key" not in response.text
        assert client.get("/api/settings").json()["api_key_configured"] is False


def test_blank_key_preserves_saved_key_for_connection(
    tmp_path: Path, model_server: str
) -> None:
    """更改模型配置时留空密钥，仍能用原密钥调用服务。"""
    with TestClient(create_app(tmp_path / "config.local.json")) as client:
        client.put(
            "/api/settings",
            json={
                "base_url": model_server,
                "model": "initial-model",
                "api_key": "sk-fictional-test-key",
            },
        ).raise_for_status()
        client.put(
            "/api/settings",
            json={
                "base_url": model_server,
                "model": "fixture-model",
                "api_key": "",
            },
        ).raise_for_status()
        response = client.post(
            "/api/settings/test",
            json={
                "base_url": model_server,
                "model": "fixture-model",
                "api_key": "",
            },
        )
        assert response.status_code == 200
        assert response.json()["ok"] is True


@pytest.mark.parametrize(
    ("key", "model", "message"),
    [
        ("wrong-test-key", "fixture-model", "认证失败"),
        ("sk-fictional-test-key", "unknown-model", "未找到服务或模型"),
    ],
)
def test_connection_failure_is_actionable(
    tmp_path: Path, model_server: str, key: str, model: str, message: str
) -> None:
    """服务认证或模型错误应显示可处理原因，不伪报连接成功。"""
    with TestClient(create_app(tmp_path / "config.local.json")) as client:
        response = client.post(
            "/api/settings/test",
            json={
                "base_url": model_server,
                "model": model,
                "api_key": key,
            },
        )
        assert response.status_code == 400
        assert message in response.json()["detail"]
        assert key not in response.text


def test_missing_key_is_reported_before_request(tmp_path: Path) -> None:
    """未配置密钥时给出输入提示，不发送外部请求。"""
    with TestClient(create_app(tmp_path / "config.local.json")) as client:
        response = client.post("/api/settings/test", json={})
        assert response.status_code == 422
        assert "请填写 API Key" in response.json()["detail"]


@pytest.mark.parametrize("base_url", ["not-a-url", "http://127.0.0.1:80000"])
def test_invalid_settings_do_not_echo_key(tmp_path: Path, base_url: str) -> None:
    """配置表单校验失败时不回显随请求提交的密钥。"""
    with TestClient(create_app(tmp_path / "config.local.json")) as client:
        response = client.put(
            "/api/settings",
            json={
                "base_url": base_url,
                "model": "fixture-model",
                "api_key": "sk-fictional-test-key",
            },
        )
        assert response.status_code == 422
        assert "服务地址" in response.json()["detail"]
        assert "sk-fictional-test-key" not in response.text
        assert client.get("/api/settings").json()["api_key_configured"] is False


def test_webpage_response_is_reported_as_invalid_model_service(
    tmp_path: Path, model_server: str
) -> None:
    """误填普通网页地址时，返回可理解的错误而不是未处理异常。"""
    with TestClient(create_app(tmp_path / "config.local.json")) as client:
        response = client.post(
            "/api/settings/test",
            json={
                "base_url": model_server,
                "model": "html-model",
                "api_key": "sk-fictional-test-key",
            },
        )
        assert response.status_code == 502
        assert "有效的模型响应" in response.json()["detail"]


def test_environment_key_is_used_without_being_saved(
    tmp_path: Path, model_server: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """环境变量密钥可用于连接，保存其他设置时不会写入文件。"""
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-fictional-test-key")
    path = tmp_path / "config.local.json"
    with TestClient(create_app(path)) as client:
        assert client.get("/api/settings").json()["api_key_configured"] is True
        payload = {"base_url": model_server, "model": "fixture-model", "api_key": ""}
        assert client.post("/api/settings/test", json=payload).status_code == 200
        response = client.put("/api/settings", json=payload)
        assert response.json()["api_key_configured"] is True
        assert "sk-fictional-test-key" not in path.read_text()
        monkeypatch.setenv("DEEPSEEK_API_KEY", "wrong-test-key")
        assert client.post("/api/settings/test", json=payload).status_code == 400
        payload["api_key"] = "sk-fictional-test-key"
        assert client.put("/api/settings", json=payload).status_code == 200
        payload["api_key"] = ""
        assert client.post("/api/settings/test", json=payload).status_code == 200


def test_go_preset_does_not_inherit_deepseek_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """切换到 Go 时不沿用 DeepSeek 文件或环境密钥。"""
    monkeypatch.setenv("DEEPSEEK_API_KEY", "fictional-deepseek-environment-key")
    with TestClient(create_app(tmp_path / "config.local.json")) as client:
        client.put(
            "/api/settings",
            json={
                "base_url": "https://api.deepseek.com",
                "model": "deepseek-flash",
                "api_key": "fictional-deepseek-saved-key",
            },
        ).raise_for_status()
        response = client.put(
            "/api/settings",
            json={
                "base_url": "https://opencode.ai/inference/go/openai/v1",
                "model": "glm-5.3-flash",
                "api_key": "",
            },
        )
        assert response.status_code == 200
        assert response.json()["api_key_configured"] is False
        assert client.get("/api/settings").json()["api_key_configured"] is False


def test_go_requests_identify_real_client_and_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Go 请求使用真实客户端名称和会话头；不访问外部服务。"""
    seen = {}

    async def send(
        _client: httpx2.AsyncClient, request: httpx2.Request, **_kwargs
    ) -> httpx2.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        seen["agent"] = request.headers.get("user-agent")
        seen["session"] = request.headers.get("x-opencode-session")
        return httpx2.Response(
            200,
            json={
                "id": "go-fixture",
                "object": "chat.completion",
                "created": 1,
                "model": "glm-5.3-flash",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {
                            "role": "assistant",
                            "content": "连接正常",
                        },
                    }
                ],
            },
            request=request,
        )

    monkeypatch.setattr(httpx2.AsyncClient, "send", send)
    with TestClient(create_app(tmp_path / "config.local.json")) as client:
        response = client.post(
            "/api/settings/test",
            json={
                "base_url": "https://opencode.ai/inference/go/openai/v1",
                "model": "glm-5.3-flash",
                "api_key": "oc-fictional-go-key",
            },
        )
        assert response.status_code == 200
        assert (
            seen["url"] == "https://opencode.ai/inference/go/openai/v1/chat/completions"
        )
        assert seen["auth"] == "Bearer oc-fictional-go-key"
        assert seen["agent"] == "xutang-advisor/0.1"
        assert seen["session"]
