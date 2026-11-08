"""话术输入、产品资料和运行记录。"""

import re
from datetime import datetime
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

Scenario = Literal[
    "greeting",
    "recommendation",
    "post_purchase",
    "reactivation",
    "event_invitation",
    "price_objection",
]
SCENARIOS: dict[str, dict[str, str]] = {
    "greeting": {
        "label": "生日及节日祝福",
        "instruction": "温暖、克制地祝福，不借祝福强推产品；日期或节日不明时不编造。",
    },
    "recommendation": {
        "label": "产品推荐",
        "instruction": "关联客户明确的需求与产品事实，不根据年龄或性别推断偏好。",
    },
    "post_purchase": {
        "label": "购后关怀",
        "instruction": (
            "关心实际使用体验，只依据已知产品与保养资料，不擅自承诺售后权益。"
        ),
    },
    "reactivation": {
        "label": "沉睡客户唤醒",
        "instruction": "自然重新联系，不质问为何不购买，不强调监控客户，不制造紧迫感。",
    },
    "event_invitation": {
        "label": "活动邀请",
        "instruction": (
            "邀请轻松且可拒绝；时间地点权益仅用已知资料，资料不全则先询问参与意向。"
        ),
    },
    "price_objection": {
        "label": "价格异议",
        "instruction": (
            "先回应预算顾虑，解释相关使用价值；只依据已知产品推荐替代，"
            "不承诺折扣、不贬低其他渠道。"
        ),
    },
}
Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class Product(BaseModel):
    """虚构产品的可引用事实。"""

    id: str
    name: str
    price: int
    material: str
    dimensions: str
    colors: list[str]
    weight: str
    usage: str
    care: str


class GenerationRequest(BaseModel):
    """顾问提供的当次沟通资料。"""

    model_config = ConfigDict(str_strip_whitespace=True)

    scenario: Scenario
    client_information: Text
    conversation_history: str = ""
    scenario_information: str = ""
    product_ids: list[str] = Field(default_factory=list)
    contact_status: Literal["active", "just_refused", "do_not_contact"] = "active"


class CandidateOutput(BaseModel):
    """模型必须返回三条独立的中文消息。"""

    messages: list[Text] = Field(min_length=3, max_length=3)

    @field_validator("messages")
    @classmethod
    def validate_messages(cls, values: list[str]) -> list[str]:
        """检查明确结构要求，不将其视为语义质量评价。"""
        if len(set(values)) != 3:
            raise ValueError("三条候选不能完全重复")
        if any(not re.search(r"[\u4e00-\u9fff]", value) for value in values):
            raise ValueError("每条候选必须包含中文内容")
        return values


class GenerationResult(BaseModel):
    """业务结果，停止与失败均不伪造三条消息。"""

    status: Literal["generated", "stopped", "failed"]
    messages: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    source: Literal["model", "rule", "none"] = "none"
    error: str | None = None


class RunRecord(BaseModel):
    """不可覆盖的当次运行快照。"""

    id: str
    created_at: datetime
    input: GenerationRequest
    products: list[Product]
    brand_rules: str
    scenario_instruction: str
    prompt_version: str
    model: str | None = None
    base_url: str | None = None
    raw_output: str = ""
    result: GenerationResult


class TestCase(BaseModel):
    """固定测试输入；单例编辑不覆盖此数据。"""

    id: str
    title: str
    focus: str
    input: GenerationRequest


class BatchItem(BaseModel):
    """每个已完成案例对应的生成记录。"""

    case_id: str
    run_id: str
    status: Literal["generated", "stopped", "failed"]
    error: str | None = None


class BatchRun(BaseModel):
    """持久化的批次及固定输入快照，不包含密钥。"""

    id: str
    created_at: datetime
    status: Literal["running", "completed", "interrupted", "failed"] = "running"
    cases_version: str
    cases: list[TestCase]
    model: str
    base_url: str
    prompt_version: str
    brand_rules: str
    items: list[BatchItem] = Field(default_factory=list)
    error: str | None = None


class CandidateReview(BaseModel):
    """语义判断由评价者录入，未评价保持空值。"""

    passed: bool | None = None
    reason: str = ""

    @model_validator(mode="after")
    def require_failure_reason(self) -> "CandidateReview":
        if self.passed is False and not self.reason.strip():
            raise ValueError("不合格的话术须填写问题原因")
        return self


class EvaluationInput(BaseModel):
    """两种评价来源独立保存，不混合作为人工结论。"""

    source: Literal["human", "ai"]
    candidates: list[CandidateReview] = Field(min_length=3, max_length=3)
    distinct: bool | None = None
    distinct_reason: str = ""
    notes: str = ""

    @model_validator(mode="after")
    def require_distinct_reason(self) -> "EvaluationInput":
        if self.distinct is False and not self.distinct_reason.strip():
            raise ValueError("候选缺乏差异时须填写原因")
        return self


class Evaluation(EvaluationInput):
    """针对一条运行及一种来源的最新评价。"""

    run_id: str
    updated_at: datetime
