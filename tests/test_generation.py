"""通过 HTTP 验证话术生成和历史快照。"""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app


def test_generated_messages_and_snapshots_survive_restart(
    tmp_path: Path, model_server: str
) -> None:
    """生成三条候选并保存完整快照，重启后历史仍可读取。"""
    path = tmp_path / "config.local.json"
    with TestClient(create_app(path)) as client:
        client.put(
            "/api/settings",
            json={
                "base_url": model_server,
                "model": "fixture-model",
                "api_key": "sk-fictional-test-key",
            },
        ).raise_for_status()
        response = client.post(
            "/api/generate",
            json={
                "scenario": "recommendation",
                "client_information": "林女士，偏好轻便的通勤包。虚构客户。",
                "conversation_history": "客户：最近想找一只轻便的包。",
                "product_ids": ["light-crossbody"],
                "scenario_information": "预算一万元以内。",
                "contact_status": "active",
            },
        )
        assert response.status_code == 200
        record = response.json()
        assert record["result"]["status"] == "generated"
        assert len(record["result"]["messages"]) == 3
        assert record["products"][0]["name"] == "轻舟斜挎包"
        assert record["products"][0]["price"] == 6800
        assert record["prompt_version"] == "v2"
        assert "sk-fictional-test-key" not in response.text

    with TestClient(create_app(path)) as restarted:
        history = restarted.get(f"/api/history/{record['id']}")
        assert history.json() == record
        assert restarted.get("/api/history").json()[0]["id"] == record["id"]


@pytest.mark.parametrize(
    "scenario",
    [
        "greeting",
        "recommendation",
        "post_purchase",
        "reactivation",
        "event_invitation",
        "price_objection",
    ],
)
def test_all_scenarios_use_generation_entry(
    tmp_path: Path, model_server: str, scenario: str
) -> None:
    """六场景可用同一入口运行，返回输入缺口而非编造场景资料。"""
    with TestClient(create_app(tmp_path / "config.local.json")) as client:
        client.put(
            "/api/settings",
            json={
                "base_url": model_server,
                "model": "fixture-model",
                "api_key": "sk-fictional-test-key",
            },
        ).raise_for_status()
        response = client.post(
            "/api/generate",
            json={
                "scenario": scenario,
                "client_information": "虚构客户，偏好轻便。",
            },
        )
        assert response.status_code == 200
        assert len(response.json()["result"]["messages"]) == 3
        assert response.json()["result"]["warnings"]


@pytest.mark.parametrize(
    ("contact", "status", "count"),
    [
        ("just_refused", "generated", 3),
        ("do_not_contact", "stopped", 0),
    ],
)
def test_refusal_does_not_require_model_credentials(
    tmp_path: Path, contact: str, status: str, count: int
) -> None:
    """两种拒联状态不调用模型，且分别确认与停止。"""
    with TestClient(create_app(tmp_path / "config.local.json")) as client:
        response = client.post(
            "/api/generate",
            json={
                "scenario": "reactivation",
                "client_information": "虚构客户。",
                "contact_status": contact,
            },
        )
        assert response.status_code == 200
        record = response.json()
        assert record["result"]["status"] == status
        assert len(record["result"]["messages"]) == count
        assert record["model"] is None
        assert record["result"]["warnings"]
        assert all(
            "不再主动" in text or "不会再主动" in text or "停止主动" in text
            for text in record["result"]["messages"]
        )


@pytest.mark.parametrize("model", ["two-candidates", "invalid-json"])
def test_invalid_model_output_is_saved_as_failed(
    tmp_path: Path, model_server: str, model: str
) -> None:
    """不合格结构不能展示为三条候选，保留原输出和失败原因。"""
    with TestClient(create_app(tmp_path / "config.local.json")) as client:
        client.put(
            "/api/settings",
            json={
                "base_url": model_server,
                "model": model,
                "api_key": "sk-fictional-test-key",
            },
        ).raise_for_status()
        response = client.post(
            "/api/generate",
            json={
                "scenario": "greeting",
                "client_information": "虚构客户。",
            },
        )
        assert response.status_code == 502
        record = client.get(f"/api/history/{response.json()['run_id']}").json()
        assert record["result"]["status"] == "failed"
        assert record["result"]["messages"] == []
        assert record["raw_output"]


def test_new_inputs_do_not_change_existing_history(tmp_path: Path) -> None:
    """后续更改输入与产品选择不影响旧记录的事实快照。"""
    with TestClient(create_app(tmp_path / "config.local.json")) as client:
        first = client.post(
            "/api/generate",
            json={
                "scenario": "reactivation",
                "client_information": "虚构客户甲。",
                "contact_status": "do_not_contact",
                "product_ids": ["light-crossbody"],
            },
        ).json()
        client.post(
            "/api/generate",
            json={
                "scenario": "greeting",
                "client_information": "虚构客户乙。",
                "contact_status": "just_refused",
                "product_ids": ["fold-cardholder"],
            },
        ).raise_for_status()
        assert client.get(f"/api/history/{first['id']}").json() == first


def test_missing_key_failure_keeps_input_in_history(tmp_path: Path) -> None:
    """缺少密钥时如实报错，仍可从历史查看当次输入。"""
    with TestClient(create_app(tmp_path / "config.local.json")) as client:
        response = client.post(
            "/api/generate",
            json={
                "scenario": "price_objection",
                "client_information": "虚构客户，预算有限。",
            },
        )
        assert response.status_code == 422
        record = client.get(f"/api/history/{response.json()['run_id']}").json()
        assert record["input"]["client_information"] == "虚构客户，预算有限。"
        assert record["result"]["status"] == "failed"


def test_missing_client_information_has_chinese_feedback(tmp_path: Path) -> None:
    """必填资料缺失时用中文说明，不回显内部字段名。"""
    with TestClient(create_app(tmp_path / "config.local.json")) as client:
        response = client.post("/api/generate", json={"scenario": "greeting"})
        assert response.status_code == 422
        assert "客户信息" in response.json()["detail"]
        assert "client_information" not in response.json()["detail"]


def test_provider_error_is_saved_without_returning_key(
    tmp_path: Path, model_server: str
) -> None:
    """认证失败保留运行记录，并提供安全的错误原因。"""
    with TestClient(create_app(tmp_path / "config.local.json")) as client:
        client.put(
            "/api/settings",
            json={
                "base_url": model_server,
                "model": "fixture-model",
                "api_key": "wrong-fictional-key",
            },
        ).raise_for_status()
        response = client.post(
            "/api/generate",
            json={
                "scenario": "greeting",
                "client_information": "虚构客户。",
            },
        )
        assert response.status_code == 400
        assert "认证失败" in response.json()["detail"]
        record = client.get(f"/api/history/{response.json()['run_id']}")
        assert record.json()["result"]["status"] == "failed"
        assert "wrong-fictional-key" not in record.text
