import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { downloadExcel, judgeApi } from "./api";
import type { JudgeExperiment, JudgeHeader, JudgeSummary } from "./api";

const statusLabels = {
  running: "运行中",
  completed: "已完成",
  interrupted: "已中断",
  failed: "执行失败",
};
const itemLabels = {
  reviewed: "已评审",
  error: "评审失败",
  skipped: "不适用",
  rule_failed: "规则未通过",
};

export function JudgePanel({
  active,
  runIds,
  selectedRunId,
}: {
  active: boolean;
  runIds: string[];
  selectedRunId?: string;
}) {
  const [headers, setHeaders] = useState<JudgeHeader[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [experiment, setExperiment] = useState<JudgeExperiment | null>(null);
  const [summary, setSummary] = useState<JudgeSummary | null>(null);
  const [model, setModel] = useState("deepseek-v4.1-flash");
  const [repetitions, setRepetitions] = useState(1);
  const [starting, setStarting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [itemKey, setItemKey] = useState("");
  useEffect(() => {
    if (!active) return;
    let mounted = true;
    let previousKey = "";
    let inFlight = false;
    async function refresh() {
      if (inFlight) return;
      inFlight = true;
      try {
        const values = await judgeApi.list();
        if (!mounted) return;
        setHeaders(values);
        const chosen =
          values.find((value) => value.id === selectedId) ?? values[0];
        if (chosen) {
          const key = `${chosen.id}-${chosen.status}-${chosen.completed}`;
          if (key !== previousKey) {
            const [detail, totals] = await Promise.all([
              judgeApi.get(chosen.id),
              judgeApi.summary(chosen.id),
            ]);
            if (!mounted) return;
            setExperiment(detail);
            setSummary(totals);
            previousKey = key;
          }
        }
        setLoadError("");
      } catch (reason) {
        if (mounted)
          setLoadError(
            reason instanceof Error ? reason.message : "自动评测读取失败。",
          );
      } finally {
        inFlight = false;
        if (mounted) setLoading(false);
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [active, selectedId, attempt]);

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStarting(true);
    setError("");
    try {
      const value = await judgeApi.start({
        run_ids: runIds,
        judge_model: model,
        repetitions,
      });
      setSelectedId(value.id);
      setExperiment(value);
      setSummary(null);
      setItemKey("");
      setAttempt((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法启动自动评测。");
    } finally {
      setStarting(false);
    }
  }
  async function download() {
    if (!experiment) return;
    setExporting(true);
    setError("");
    try {
      await downloadExcel(
        `/api/judge-experiments/${encodeURIComponent(experiment.id)}/export.xlsx`,
        "xutang-deepeval.xlsx",
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "导出失败。");
    } finally {
      setExporting(false);
    }
  }
  const running =
    headers.some((value) => value.status === "running") ||
    experiment?.status === "running";
  const keyOf = (id: string, trial: number) => `${id}/${trial}`;
  const selectedItem =
    experiment?.items.find(
      (item) => keyOf(item.run_id, item.trial) === itemKey,
    ) ??
    experiment?.items.find((item) => item.run_id === selectedRunId) ??
    experiment?.items[0];
  return (
    <section className="judge-panel" aria-label="DeepEval 自动评测">
      <div className="result-title">
        <h2>DeepEval 自动评测</h2>
        <span className="run-status stopped">未完成人工校准</span>
      </div>
      <p className="review-reminder">
        对已保存输出进行评审，不重新生成。与手动 AI
        初评、人工复核独立保存。服务地址与密钥沿用模型设置，评审模型单独指定。
      </p>
      <form className="judge-controls" onSubmit={start}>
        <div className="field">
          <label htmlFor="judge-model">评审模型</label>
          <input
            id="judge-model"
            value={model}
            required
            onChange={(event) => setModel(event.currentTarget.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="judge-repetitions">重复评审</label>
          <select
            id="judge-repetitions"
            value={repetitions}
            onChange={(event) =>
              setRepetitions(Number(event.currentTarget.value))
            }
          >
            <option value={1}>每例 1 次</option>
            <option value={3}>每例 3 次（观察一致性）</option>
          </select>
        </div>
        <button
          type="submit"
          className="button primary"
          disabled={
            loading ||
            Boolean(loadError) ||
            starting ||
            running ||
            runIds.length === 0
          }
        >
          {starting ? "正在启动…" : `运行 DeepEval（${runIds.length} 条记录）`}
        </button>
      </form>
      <p className="review-reminder">
        将产生实际评审 API 请求。每例每轮一次，请求时限 180
        秒，不自动重试。阈值为待校准初始口径，不代表独立质量认证。
      </p>
      {error && (
        <div className="load-error" role="alert">
          {error}
        </div>
      )}
      {loadError && (
        <div className="load-error" role="alert">
          {loadError}
          <button
            className="text-button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            重试读取评测
          </button>
        </div>
      )}
      {headers.length > 0 && (
        <div className="field">
          <label htmlFor="judge-experiment">自动评测实验</label>
          <select
            id="judge-experiment"
            value={experiment?.id ?? ""}
            onChange={(event) => {
              setSelectedId(event.currentTarget.value);
              setItemKey("");
            }}
          >
            {headers.map((value) => (
              <option value={value.id} key={value.id}>
                {new Date(value.created_at).toLocaleString("zh-CN")} ·{" "}
                {value.judge_model} · {statusLabels[value.status]} ·{" "}
                {value.completed}/{value.total}
              </option>
            ))}
          </select>
        </div>
      )}
      {experiment && (
        <>
          <p className="program-summary" aria-live="polite">
            {statusLabels[experiment.status]} · {experiment.items.length}/
            {experiment.run_ids.length * experiment.repetitions} 个案例轮次 ·{" "}
            {experiment.judge_model} · {experiment.rubric_version} · DeepEval{" "}
            {experiment.framework_version}
          </p>
          <p className="review-reminder">
            实验 {experiment.id}
            ；范围在启动时固定，当前列表筛选不会更改已保存实验。
          </p>
          {experiment.error && <p className="load-error">{experiment.error}</p>}
          {summary && (
            <div className="judge-totals" aria-label="自动评测统计">
              <p>
                单条合格 {summary.passed_messages}/{summary.total_messages} ·
                案例可用 {summary.usable_cases}/{summary.total_cases} · 整组达标{" "}
                {summary.qualified_groups}/{summary.total_cases}
              </p>
              <p>
                不合格 {summary.failed_messages} 条 · 待复核{" "}
                {summary.pending_messages} 条 · 未评{" "}
                {summary.unreviewed_messages} 条
              </p>
              <p>
                评审失败 {summary.evaluation_errors} 次 · 规则未通过{" "}
                {summary.rule_failures} 次 · 不适用 {summary.skipped} 次
              </p>
              {Object.entries(summary.by_version).map(([version, data]) => (
                <p key={version}>
                  生成版本 {version}：单条 {data.passed_messages}/
                  {data.total_messages} · 案例 {data.usable_cases}/
                  {data.total_cases} · 整组 {data.qualified_groups}/
                  {data.total_cases}
                </p>
              ))}
              <p>
                人工对照 {summary.human_compared_messages} 条轮次 · 一致{" "}
                {summary.human_agreements} 条 · 错误放行{" "}
                {summary.false_acceptances} 条 · 错误拒绝{" "}
                {summary.false_rejections}{" "}
                条。只对比已明确判断的人工标签，不使用手动 AI 初评充当人工标准。
              </p>
              {experiment.repetitions > 1 && (
                <p>
                  完成全部重复的 {summary.repeated_cases} 例中，判断一致{" "}
                  {summary.consistent_cases} 例；重复轮次不等于独立样本。
                </p>
              )}
            </div>
          )}
          <button
            className="button secondary"
            disabled={exporting}
            onClick={download}
          >
            {exporting ? "导出中…" : "导出 DeepEval 实验"}
          </button>
          {experiment.items.length > 0 && (
            <div className="field judge-item-select">
              <label htmlFor="judge-item">评审案例与轮次</label>
              <select
                id="judge-item"
                value={
                  selectedItem
                    ? keyOf(selectedItem.run_id, selectedItem.trial)
                    : ""
                }
                onChange={(event) => setItemKey(event.currentTarget.value)}
              >
                {experiment.items.map((item) => (
                  <option
                    key={keyOf(item.run_id, item.trial)}
                    value={keyOf(item.run_id, item.trial)}
                  >
                    {item.run_id.slice(0, 8)} · 第 {item.trial} 轮 ·{" "}
                    {itemLabels[item.status]}
                  </option>
                ))}
              </select>
            </div>
          )}
          {selectedItem && (
            <div className="judge-evidence" aria-label="自动评测证据">
              <p className="review-reminder">
                运行 {selectedItem.run_id} · 第 {selectedItem.trial} 轮
              </p>
              <ul className="judge-rules">
                {selectedItem.rules.map((rule) => (
                  <li key={rule.name}>
                    {rule.passed ? "通过" : "未通过"} · {rule.name}：
                    {rule.detail}
                  </li>
                ))}
              </ul>
              {selectedItem.error && (
                <p className="load-error">{selectedItem.error}</p>
              )}
              {selectedItem.verdict && (
                <>
                  {selectedItem.verdict.candidates.map((candidate) => (
                    <section className="judge-candidate" key={candidate.index}>
                      <h3>
                        候选 {candidate.index} ·{" "}
                        {candidate.passed === null
                          ? "待复核"
                          : candidate.passed
                            ? "合格"
                            : "不合格"}
                      </h3>
                      <p className="review-reminder">
                        个性化 {candidate.scores.personalization ?? "不适用"} ·
                        品牌 {candidate.scores.brand} · 场景{" "}
                        {candidate.scores.scenario} · 自然度{" "}
                        {candidate.scores.naturalness}（满分 5）
                      </p>
                      <p>{candidate.reason}</p>
                      {candidate.violations.map((violation, index) => (
                        <blockquote key={index}>
                          <p>原句：{violation.quote}</p>
                          <p>问题：{violation.reason}</p>
                          <p>依据：{violation.basis}</p>
                        </blockquote>
                      ))}
                    </section>
                  ))}
                  <p>
                    候选差异 {selectedItem.verdict.diversity}/5
                    {selectedItem.verdict.diversity_needs_review
                      ? " · 待复核"
                      : ""}
                    ：{selectedItem.verdict.diversity_reason}
                  </p>
                </>
              )}
              <details className="snapshot-details">
                <summary>查看评测准则与请求原文</summary>
                <pre>
                  {experiment.rubric}
                  {"\n\n评审输入：\n"}
                  {selectedItem.judge_input}
                  {"\n\n原始响应：\n"}
                  {selectedItem.raw_output}
                  {"\n\n框架记录：\n"}
                  {JSON.stringify(selectedItem.framework_result, null, 2)}
                </pre>
              </details>
            </div>
          )}
        </>
      )}
      {!loading && headers.length === 0 && (
        <p className="review-reminder">
          暂无自动评测实验。可以先筛选少量记录验证协议，再评审完整批次。
        </p>
      )}
    </section>
  );
}
