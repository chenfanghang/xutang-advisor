"""用 LangGraph 编排确定的话术生成步骤。"""

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal
from uuid import uuid4

from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from pydantic import BaseModel, ValidationError

from backend.model_client import ModelServiceError, complete
from backend.schemas import (
    SCENARIOS,
    CandidateOutput,
    GenerationRequest,
    GenerationResult,
    Product,
    RunRecord,
)
from backend.settings import ModelSettings, read_settings
from backend.store import Store

PROMPT_VERSION = "v2"


def load_brand_rules() -> str:
    """读取当前版本的品牌与生成规则。"""
    return (Path(__file__).parent / f"prompts/{PROMPT_VERSION}.md").read_text("utf-8")


class GenerationState(BaseModel):
    """每次调用独立的工作流状态，不包含模型密钥。"""

    request: GenerationRequest
    products: list[Product]
    brand_rules: str
    warnings: list[str]
    raw_output: str
    result: GenerationResult | None
    model: str | None
    base_url: str | None
    error_code: int


def build_workflow(
    settings_path: Path, model_settings: ModelSettings | None = None
) -> CompiledStateGraph:
    """编译联系意愿检查、上下文准备、生成和输出校验四个节点。"""

    def check_contact(state: GenerationState) -> dict:
        contact = state.request.contact_status
        if contact == "do_not_contact":
            return {
                "result": GenerationResult(
                    status="stopped",
                    warnings=["建议不联系：客户此前已拒联且对话结束。"],
                )
            }
        if contact == "just_refused":
            return {
                "result": GenerationResult(
                    status="generated",
                    source="rule",
                    warnings=["确认收到后停止主动触达。"],
                    messages=[
                        "好的，收到您的意思了。我会尊重您的意愿，不再主动联系。",
                        "明白，谢谢您直接告诉我。之后我不会再主动打扰您。",
                        "收到，我会停止主动联系。感谢您告知，祝您一切顺利。",
                    ],
                )
            }
        return {}

    def route(state: GenerationState) -> Literal["prepare", "finish"]:
        return "finish" if state.result is not None else "prepare"

    def prepare(state: GenerationState) -> dict:
        request = state.request
        warnings = []
        if not request.conversation_history:
            warnings.append("未提供对话历史，不应假设曾有交流或共同经历。")
        if (
            request.scenario in {"recommendation", "post_purchase", "price_objection"}
            and not state.products
        ):
            warnings.append(
                "未选择目录产品；仅使用其他资料中明确的事实，信息不足时先了解需求。"
            )
        if (
            request.scenario in {"event_invitation", "greeting"}
            and not request.scenario_information
        ):
            warnings.append(
                "未填写场景补充；若其他资料也未明确，不编造日期、地点或活动权益。"
            )
        return {"warnings": warnings}

    async def generate(state: GenerationState) -> dict:
        try:
            settings = model_settings or read_settings(settings_path)
        except (OSError, ValidationError):
            return {
                "result": GenerationResult(
                    status="failed", error="本机配置无法读取，请检查配置文件。"
                ),
                "error_code": 500,
            }
        context = {
            "input": state.request.model_dump(),
            "products": [item.model_dump() for item in state.products],
            "scenario_instruction": SCENARIOS[state.request.scenario]["instruction"],
            "missing_information_notes": state.warnings,
        }
        metadata = {"model": settings.model, "base_url": settings.base_url}
        try:
            text = await complete(
                settings,
                [
                    {"role": "system", "content": state.brand_rules},
                    {
                        "role": "user",
                        "content": json.dumps(context, ensure_ascii=False),
                    },
                ],
                json_mode=True,
            )
        except ModelServiceError as error:
            return {
                **metadata,
                "result": GenerationResult(
                    status="failed",
                    error=error.detail,
                    warnings=state.warnings,
                ),
                "error_code": error.status_code,
            }
        return {**metadata, "raw_output": text}

    def validate(state: GenerationState) -> dict:
        if state.result is not None:
            return {}
        try:
            output = CandidateOutput.model_validate_json(state.raw_output)
        except ValidationError:
            return {
                "result": GenerationResult(
                    status="failed",
                    error="模型未返回三条独立的中文候选，请重试或调整模型。",
                    warnings=state.warnings,
                ),
                "error_code": 502,
            }
        return {
            "result": GenerationResult(
                status="generated",
                source="model",
                messages=output.messages,
                warnings=state.warnings,
            )
        }

    graph = StateGraph(GenerationState)
    graph.add_node("check_contact", check_contact)
    graph.add_node("prepare", prepare)
    graph.add_node("generate", generate)
    graph.add_node("validate", validate)
    graph.add_edge(START, "check_contact")
    graph.add_conditional_edges(
        "check_contact", route, {"prepare": "prepare", "finish": END}
    )
    graph.add_edge("prepare", "generate")
    graph.add_edge("generate", "validate")
    graph.add_edge("validate", END)
    return graph.compile()


async def generate_record(
    request: GenerationRequest,
    store: Store,
    graph: CompiledStateGraph,
    *,
    brand_rules: str | None = None,
) -> tuple[RunRecord, int]:
    """执行共享生成入口并保存结果，包括停止生成和可预期失败。"""
    catalog = {product.id: product for product in store.products()}
    if any(product_id not in catalog for product_id in request.product_ids):
        raise ModelServiceError(422, "选择的产品不存在，请刷新产品资料。")
    products = [
        catalog[product_id] for product_id in dict.fromkeys(request.product_ids)
    ]
    rules = brand_rules if brand_rules is not None else load_brand_rules()
    state = await graph.ainvoke(
        {
            "request": request,
            "products": products,
            "brand_rules": rules,
            "warnings": [],
            "raw_output": "",
            "result": None,
            "model": None,
            "base_url": None,
            "error_code": 200,
        }
    )
    record = RunRecord(
        id=str(uuid4()),
        created_at=datetime.now(UTC),
        input=request,
        products=products,
        brand_rules=rules,
        scenario_instruction=SCENARIOS[request.scenario]["instruction"],
        prompt_version=PROMPT_VERSION,
        model=state["model"],
        base_url=state["base_url"],
        raw_output=state["raw_output"],
        result=state["result"],
    )
    store.save_run(record)
    return record, state["error_code"]
