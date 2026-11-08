"""通过 DeepEval 官方执行器运行项目自定义质量指标。"""

import asyncio
import json
import os

# 本项目只在本机保存实验，评审请求仍发送到用户配置的服务。
os.environ["DEEPEVAL_TELEMETRY_OPT_OUT"] = "1"
os.environ["DEEPEVAL_DISABLE_DOTENV"] = "1"
os.environ["DEEPEVAL_DISABLE_LEGACY_KEYFILE"] = "1"

from deepeval import evaluate
from deepeval.config.settings import get_settings
from deepeval.evaluate import AsyncConfig, CacheConfig, DisplayConfig, ErrorConfig
from deepeval.metrics import BaseMetric
from deepeval.test_case import LLMTestCase
from deepeval.tracing.tracing import trace_manager

from backend.judge_schemas import JudgeVerdict
from backend.model_client import complete
from backend.settings import ModelSettings

sdk_settings = get_settings()
with sdk_settings.edit(persist=False):
    sdk_settings.DEEPEVAL_TELEMETRY_OPT_OUT = True
    sdk_settings.CONFIDENT_API_KEY = None
    sdk_settings.DEEPEVAL_PER_TASK_TIMEOUT_SECONDS_OVERRIDE = 200.0
trace_manager.configure(tracing_enabled=False)


class MessageQualityMetric(BaseMetric):
    """一次请求评审三条，指标通过表示整组质量及差异均通过。"""

    def __init__(self, settings: ModelSettings, rubric: str):
        self.settings = settings
        self.rubric = rubric
        self.threshold = 1.0
        self.evaluation_model = settings.model
        self.async_mode = False
        self.verbose_mode = False
        self.include_reason = True
        self.raw_output = ""
        self.verdict: JudgeVerdict | None = None

    @property
    def __name__(self):
        return "序棠整组质量与差异"

    def measure(self, test_case: LLMTestCase, *args, **kwargs) -> float:
        return asyncio.run(self.a_measure(test_case))

    async def a_measure(self, test_case: LLMTestCase, *args, **kwargs) -> float:
        if test_case.actual_output is None:
            raise ValueError("评审案例缺少候选输出")
        self.raw_output = await complete(
            self.settings,
            [
                {"role": "system", "content": self.rubric},
                {
                    "role": "user",
                    "content": test_case.input
                    + "\n候选消息：\n"
                    + test_case.actual_output,
                },
            ],
            json_mode=True,
            timeout_seconds=180.0,
        )
        verdict = JudgeVerdict.model_validate_json(self.raw_output)
        messages = json.loads(test_case.actual_output)
        for candidate in verdict.candidates:
            if any(
                item.quote not in messages[candidate.index - 1]
                for item in candidate.violations
            ):
                raise ValueError("评审引用的问题原句不在对应候选中")
        self.verdict = verdict
        self.score = float(
            all(candidate.passed is True for candidate in verdict.candidates)
            and verdict.diversity >= 3
            and not verdict.diversity_needs_review
        )
        self.success = self.score == 1.0
        self.reason = verdict.diversity_reason
        return self.score


def evaluate_case(
    settings: ModelSettings, rubric: str, context: str, messages: list[str], run_id: str
) -> tuple[MessageQualityMetric, dict]:
    """在线程执行官方同步 runner；外层串行调用，避免 SDK 全局实验交叉。"""
    metric = MessageQualityMetric(settings, rubric)
    case = LLMTestCase(
        input=context,
        actual_output=json.dumps(messages, ensure_ascii=False),
        name=run_id,
    )
    result = evaluate(
        [case],
        metrics=[metric],
        async_config=AsyncConfig(run_async=False),
        cache_config=CacheConfig(use_cache=False, write_cache=False),
        error_config=ErrorConfig(ignore_errors=True),
        display_config=DisplayConfig(
            show_indicator=False,
            print_results=False,
            inspect_after_run=False,
            verbose_mode=False,
        ),
        hyperparameters={"judge_model": settings.model, "rubric": "judge-v1"},
    )
    return metric, result.model_dump(mode="json")
