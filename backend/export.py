"""导出案例快照及来源明确的评价，不读取模型密钥。"""

import json
from io import BytesIO

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.worksheet import Worksheet

from backend.evaluation import summarize
from backend.judge_schemas import JudgeExperiment
from backend.schemas import SCENARIOS, BatchRun, Evaluation, RunRecord

SOURCE_LABELS = {"human": "人工复核", "ai": "AI 初评"}
STATUS_LABELS = {"generated": "已生成", "stopped": "停止生成", "failed": "生成失败"}


def export_workbook(
    records: list[RunRecord], evaluations: list[Evaluation], batches: list[BatchRun]
) -> bytes:
    """文本按文本写入；超过 Excel 单元格上限的内容分段保存。"""
    workbook = Workbook()
    cases = workbook.active
    assert cases is not None
    cases.title = "案例结果"
    reviews = workbook.create_sheet("评价记录")
    stats = workbook.create_sheet("统计")
    batch_sheet = workbook.create_sheet("批次说明")
    instructions = workbook.create_sheet("口径说明")
    long_text = workbook.create_sheet("长文本")
    long_text.append(["运行ID", "字段", "分段序号", "内容"])

    def append(
        sheet: Worksheet, values: list, run_id: str = "", source: str = ""
    ) -> None:
        headers = [cell.value for cell in sheet[1]] if sheet.max_row else []
        # Excel 单元格最多容纳 32767 字符，实际输入与模型原文不截断。
        for index, value in enumerate(values):
            if isinstance(value, str) and len(value) > 32767:
                field = (
                    f"{source} / {headers[index]}" if source else str(headers[index])
                )
                for offset in range(0, len(value), 30000):
                    long_text.append(
                        [
                            run_id,
                            field,
                            offset // 30000 + 1,
                            value[offset : offset + 30000],
                        ]
                    )
                values[index] = f"全文见长文本：{run_id} / {field}"
        sheet.append(values)

    cases.append(
        [
            "运行ID",
            "批次ID",
            "案例ID",
            "案例集版本",
            "案例标题",
            "验证重点",
            "运行时间",
            "业务场景",
            "客户信息",
            "对话历史",
            "场景补充",
            "联系意愿",
            "产品快照JSON",
            "品牌规则快照",
            "场景指令快照",
            "生成状态",
            "结果来源",
            "候选1",
            "候选2",
            "候选3",
            "提示",
            "失败原因",
            "原始模型输出",
            "提示词版本",
            "模型",
            "服务地址",
            "完整运行JSON",
        ]
    )
    membership = {
        item.run_id: (batch, case)
        for batch in batches
        for item in batch.items
        for case in batch.cases
        if case.id == item.case_id
    }
    for record in records:
        member = membership.get(record.id)
        batch, case = member if member else (None, None)
        messages = record.result.messages + [""] * 3
        append(
            cases,
            [
                record.id,
                batch.id if batch else "",
                case.id if case else "",
                batch.cases_version if batch else "",
                case.title if case else "",
                case.focus if case else "",
                record.created_at.isoformat(),
                SCENARIOS[record.input.scenario]["label"],
                record.input.client_information,
                record.input.conversation_history,
                record.input.scenario_information,
                record.input.contact_status,
                json.dumps(
                    [p.model_dump() for p in record.products], ensure_ascii=False
                ),
                record.brand_rules,
                record.scenario_instruction,
                STATUS_LABELS[record.result.status],
                {"model": "模型生成", "rule": "规则回复", "none": "无输出"}[
                    record.result.source
                ],
                *messages[:3],
                "\n".join(record.result.warnings),
                record.result.error or "",
                record.raw_output,
                record.prompt_version,
                record.model or "未调用模型",
                record.base_url or "",
                record.model_dump_json(),
            ],
            record.id,
        )
    reviews.append(
        [
            "运行ID",
            "评价来源",
            "更新时间",
            "候选1判断",
            "候选1原因",
            "候选2判断",
            "候选2原因",
            "候选3判断",
            "候选3原因",
            "切入点有差异",
            "差异原因",
            "备注",
        ]
    )

    def judgment(value: bool | None) -> str:
        return "未评估" if value is None else "合格" if value else "不合格"

    for review in evaluations:
        values: list = [
            review.run_id,
            SOURCE_LABELS[review.source],
            review.updated_at.isoformat(),
        ]
        for candidate in review.candidates:
            values.extend([judgment(candidate.passed), candidate.reason])
        values.extend([judgment(review.distinct), review.distinct_reason, review.notes])
        append(reviews, values, review.run_id, SOURCE_LABELS[review.source])
    summary = summarize(records, evaluations)
    stats.append(["来源", "指标", "数量", "分母", "比例"])
    for key, label in (
        ("total", "全部记录"),
        ("generated", "已生成"),
        ("failed", "生成失败"),
        ("stopped", "停止生成"),
    ):
        stats.append(["程序检查", label, summary[key], summary["total"], None])
    for source, label in SOURCE_LABELS.items():
        data = summary[source]
        for key, title, denominator in (
            ("passed_messages", "单条合格", data["total_messages"]),
            ("usable_cases", "案例可用", summary["generated"]),
            ("qualified_groups", "整组达标", summary["generated"]),
            ("reviewed_messages", "已评话术", data["total_messages"]),
            ("unreviewed_messages", "未评话术", data["total_messages"]),
            ("fully_reviewed_cases", "完整评价案例", summary["generated"]),
        ):
            stats.append(
                [
                    label,
                    title,
                    data[key],
                    denominator,
                    data[key] / denominator if denominator else None,
                ]
            )
    batch_sheet.append(
        [
            "批次ID",
            "批次状态",
            "固定案例总数",
            "已完成数",
            "本次导出数",
            "案例集版本",
            "提示词版本",
        ]
    )
    ids = {record.id for record in records}
    for batch in batches:
        count = sum(item.run_id in ids for item in batch.items)
        if count:
            batch_sheet.append(
                [
                    batch.id,
                    batch.status,
                    len(batch.cases),
                    len(batch.items),
                    count,
                    batch.cases_version,
                    batch.prompt_version,
                ]
            )
    for row in [
        ["项目", "说明"],
        [
            "数据范围",
            "导出当前筛选下已完成的运行；批次未完成时仅导出已保存结果，见批次说明。",
        ],
        ["单条合格", "评价者判定符合事实、权限、客户意愿、场景及品牌表达要求。"],
        ["案例可用", "三条中至少一条明确合格。"],
        ["整组达标", "三条均明确合格，且切入点差异明确通过。"],
        [
            "统计分母",
            "当前范围全部已生成话术或案例；未评估不算合格；失败及停止单列。分母为零时不计算比例。",
        ],
        [
            "评价来源",
            "人工复核与 AI 初评独立保存；AI 初评手动录入，不能视为人工结论。"
            "程序仅检查结构与运行状态。",
        ],
        [
            "长文本",
            "超过单元格上限的字段按运行ID及字段名在长文本表分段保存，依序拼接即为全文。",
        ],
        [
            "数据声明",
            "品牌、产品及客户为虚构。规则回复与模型生成明确区分；导出不证明已完成真实模型质量评估。",
        ],
    ]:
        instructions.append(row)
    for sheet in workbook:
        sheet.freeze_panes = "A2"
        sheet.auto_filter.ref = sheet.dimensions
        for row in sheet:
            for cell in row:
                if isinstance(cell.value, str):
                    cell.data_type = "s"
                cell.alignment = Alignment(vertical="top", wrap_text=True)
                if cell.row == 1:
                    cell.font = Font(bold=True, color="FFFFFF")
                    cell.fill = PatternFill("solid", fgColor="25334D")
        for column in range(1, sheet.max_column + 1):
            sheet.column_dimensions[get_column_letter(column)].width = 28
        sheet.row_dimensions[1].height = 30
    for row in stats.iter_rows(min_row=2, min_col=5, max_col=5):
        row[0].number_format = "0.0%"
    stream = BytesIO()
    workbook.save(stream)
    workbook.close()
    return stream.getvalue()


def export_experiment(
    experiment: JudgeExperiment,
    records: list[RunRecord],
    batches: list[BatchRun],
    evaluations: list[Evaluation] | None = None,
) -> bytes:
    """复用完整案例导出，另存自动评审及分段原文，不混合旧初评统计。"""
    from backend.judging import experiment_summary

    workbook = load_workbook(BytesIO(export_workbook(records, [], batches)))
    for name in ("评价记录", "统计", "口径说明"):
        del workbook[name]
    overview = workbook.create_sheet("自动评测统计")
    evidence = workbook.create_sheet("评审证据")
    raw = workbook.create_sheet("评审原文")
    overview.append(["项目", "值"])
    for key, value in {
        "实验ID": experiment.id,
        "评审模型": experiment.judge_model,
        "服务地址": experiment.base_url,
        "准则版本": experiment.rubric_version,
        "DeepEval版本": experiment.framework_version,
        "评审超时秒": experiment.request_timeout_seconds,
        "校准状态": "未完成人工校准",
        "实验状态": experiment.status,
        "重复次数": experiment.repetitions,
        "说明": (
            "规则、自动评审、手动初评及人工复核分别保存。"
            "分母含全部应评轮次；待复核与执行错误不算合格。"
            "重复结果不是独立案例。"
        ),
        **experiment_summary(experiment, records, evaluations),
    }.items():
        overview.append(
            [
                key,
                json.dumps(value, ensure_ascii=False)
                if isinstance(value, dict)
                else value,
            ]
        )
    evidence.append(
        [
            "运行ID",
            "轮次",
            "评审状态",
            "候选编号",
            "判断",
            "个性化",
            "品牌",
            "场景",
            "自然度",
            "可独立发送",
            "原因",
            "严重问题JSON",
            "差异分",
            "差异原因",
        ]
    )
    raw.append(["运行ID", "轮次", "字段", "分段", "内容"])

    def raw_text(identifier: str, trial: int, label: str, value: str) -> None:
        for offset in range(0, len(value), 30000):
            raw.append(
                [
                    identifier,
                    trial,
                    label,
                    offset // 30000 + 1,
                    value[offset : offset + 30000],
                ]
            )

    raw_text(experiment.id, 0, "完整评测准则", experiment.rubric)
    for item in experiment.items:
        raw_text(item.run_id, item.trial, "评审输入", item.judge_input)
        raw_text(item.run_id, item.trial, "原始响应", item.raw_output)
        raw_text(
            item.run_id,
            item.trial,
            "框架结果",
            json.dumps(item.framework_result, ensure_ascii=False),
        )
        raw_text(
            item.run_id,
            item.trial,
            "规则结果",
            json.dumps([c.model_dump() for c in item.rules], ensure_ascii=False),
        )
        if not item.verdict:
            evidence.append(
                [
                    item.run_id,
                    item.trial,
                    item.status,
                    "",
                    "未作语义判断",
                    "",
                    "",
                    "",
                    "",
                    "",
                    item.error,
                ]
            )
            continue
        for candidate in item.verdict.candidates:
            decision = candidate.passed
            values = [
                item.run_id,
                item.trial,
                item.status,
                candidate.index,
                "待复核" if decision is None else "合格" if decision else "不合格",
                candidate.scores.personalization,
                candidate.scores.brand,
                candidate.scores.scenario,
                candidate.scores.naturalness,
                candidate.independent,
                candidate.reason,
                json.dumps(
                    [v.model_dump() for v in candidate.violations], ensure_ascii=False
                ),
                item.verdict.diversity,
                item.verdict.diversity_reason,
            ]
            for column, value in enumerate(values):
                if isinstance(value, str) and len(value) > 32767:
                    label = (
                        f"候选{candidate.index}/{evidence.cell(1, column + 1).value}"
                    )
                    raw_text(item.run_id, item.trial, label, value)
                    values[column] = "全文见评审原文表：" + label
            evidence.append(values)
    for sheet in (overview, evidence, raw):
        sheet.freeze_panes = "A2"
        sheet.auto_filter.ref = sheet.dimensions
        for row in sheet:
            for cell in row:
                if isinstance(cell.value, str):
                    cell.data_type = "s"
                cell.alignment = Alignment(vertical="top", wrap_text=True)
                if cell.row == 1:
                    cell.font = Font(bold=True, color="FFFFFF")
                    cell.fill = PatternFill("solid", fgColor="25334D")
        for index in range(1, sheet.max_column + 1):
            sheet.column_dimensions[get_column_letter(index)].width = 28
    stream = BytesIO()
    workbook.save(stream)
    workbook.close()
    return stream.getvalue()
