"""自动评测的分项判断、证据及独立实验记录。"""

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field, computed_field, model_validator

from backend.schemas import Text

Score = Annotated[int, Field(strict=True, ge=1, le=5)]


class QualityScores(BaseModel):
    personalization: Score | None
    brand: Score
    scenario: Score
    naturalness: Score


class Violation(BaseModel):
    kind: Literal["fact", "authorization", "contact", "privacy"]
    quote: Text
    reason: Text
    basis: Text


class JudgeCandidate(BaseModel):
    index: Annotated[int, Field(strict=True, ge=1, le=3)]
    scores: QualityScores
    independent: bool
    needs_review: bool
    reason: Text
    violations: list[Violation]

    @computed_field
    @property
    def passed(self) -> bool | None:
        """严重违规优先，其余维度不以平均分抵消。"""
        if self.violations or not self.independent:
            return False
        if any(v is not None and v < 3 for v in self.scores.model_dump().values()):
            return False
        return None if self.needs_review else True


class JudgeVerdict(BaseModel):
    candidates: list[JudgeCandidate] = Field(min_length=3, max_length=3)
    diversity: Score
    diversity_needs_review: bool
    diversity_reason: Text

    @model_validator(mode="after")
    def validate_indices(self) -> "JudgeVerdict":
        if sorted(item.index for item in self.candidates) != [1, 2, 3]:
            raise ValueError("评审候选编号须为不重复的 1、2、3")
        self.candidates.sort(key=lambda item: item.index)
        return self


class JudgeRequest(BaseModel):
    run_ids: list[Text] = Field(min_length=1, max_length=200)
    judge_model: Text = "deepseek-v4.1-flash"
    repetitions: Literal[1, 3] = 1


class RuleCheck(BaseModel):
    name: str
    passed: bool
    detail: str


class JudgeItem(BaseModel):
    run_id: str
    trial: int
    status: Literal["reviewed", "error", "skipped", "rule_failed"]
    rules: list[RuleCheck]
    verdict: JudgeVerdict | None = None
    raw_output: str = ""
    judge_input: str = ""
    framework_result: dict = Field(default_factory=dict)
    error: str | None = None


class JudgeExperiment(BaseModel):
    id: str
    created_at: datetime
    finished_at: datetime | None = None
    status: Literal["running", "completed", "interrupted", "failed"] = "running"
    run_ids: list[str]
    judge_model: str
    base_url: str
    repetitions: int
    rubric_version: str
    rubric: str
    framework_version: str
    request_timeout_seconds: float = 60.0
    calibrated: bool = False
    items: list[JudgeItem] = Field(default_factory=list)
    error: str | None = None
