import { useEffect, useState } from "react";
import { downloadExcel, evaluationApi, historyQuery, testingApi } from "./api";
import type {
  BatchRun,
  EvaluationView,
  HistoryFilters,
  RunRecord,
  Scenario,
} from "./api";
import { CandidateList } from "./CandidateList";
import { EvaluationPanel, reviewLabels } from "./EvaluationPanel";
import { Icon } from "./Icon";
import { RunComparison } from "./RunComparison";
import { JudgePanel } from "./JudgePanel";

const statuses = {
  generated: "已生成",
  stopped: "停止生成",
  failed: "生成失败",
};

export function HistoryPage({
  active,
  revision,
  scenarios,
}: {
  active: boolean;
  revision: number;
  scenarios: Scenario[];
}) {
  const labels = Object.fromEntries(
    scenarios.map((item) => [item.id, item.label]),
  );
  const [records, setRecords] = useState<RunRecord[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [filters, setFilters] = useState<HistoryFilters>({
    scenario: "",
    version: "",
    batch_id: "",
  });
  const [view, setView] = useState<EvaluationView | null>(null);
  const [batches, setBatches] = useState<BatchRun[]>([]);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  useEffect(() => {
    if (!active) return;
    let mounted = true;
    Promise.all([evaluationApi.list(filters), testingApi.batches()])
      .then(([data, batchData]) => {
        if (mounted) {
          setRecords(data.records);
          setView(data);
          setBatches(batchData);
          setError("");
        }
      })
      .catch((reason: unknown) => {
        if (mounted)
          setError(reason instanceof Error ? reason.message : "历史读取失败。");
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [active, revision, attempt, filters]);
  const selected = records.find((item) => item.id === selectedId) ?? records[0];
  function changeFilter(key: keyof HistoryFilters, value: string) {
    setLoading(true);
    setExportError("");
    setFilters((current) => ({ ...current, [key]: value }));
  }
  async function download() {
    setExporting(true);
    setExportError("");
    try {
      await downloadExcel(
        `/api/export.xlsx?${historyQuery(filters)}`,
        "xutang-cases.xlsx",
      );
    } catch (reason) {
      setExportError(reason instanceof Error ? reason.message : "导出失败。");
    } finally {
      setExporting(false);
    }
  }
  return (
    <main id="history" tabIndex={-1}>
      <div className="page-heading">
        <div>
          <h1>历史与评估</h1>
          <p className="page-description">
            查看生成快照、记录质量判断，按相同输入比较不同版本。
          </p>
        </div>
        <button
          className="button secondary"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            setAttempt((value) => value + 1);
          }}
        >
          <Icon name="history" />
          {loading ? "读取中…" : "刷新记录"}
        </button>
      </div>
      <div className="section-tabs">
        <span>运行记录与质量评估</span>
      </div>
      <div className="history-filters">
        <div className="field">
          <label htmlFor="history-scenario">筛选场景</label>
          <select
            id="history-scenario"
            value={filters.scenario}
            onChange={(event) =>
              changeFilter("scenario", event.currentTarget.value)
            }
          >
            <option value="">全部场景</option>
            {scenarios.map((item) => (
              <option value={item.id} key={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="history-version">筛选版本</label>
          <select
            id="history-version"
            value={filters.version}
            onChange={(event) =>
              changeFilter("version", event.currentTarget.value)
            }
          >
            <option value="">全部提示词版本</option>
            {view?.versions.map((value) => (
              <option value={value} key={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="history-batch">筛选批次</label>
          <select
            id="history-batch"
            value={filters.batch_id}
            onChange={(event) =>
              changeFilter("batch_id", event.currentTarget.value)
            }
          >
            <option value="">全部记录（含单次生成）</option>
            {batches.map((batch) => (
              <option value={batch.id} key={batch.id}>
                {new Date(batch.created_at).toLocaleString("zh-CN")} ·{" "}
                {batch.prompt_version} · {batch.items.length}/
                {batch.cases.length} · {batch.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </div>
        <button
          className="button secondary"
          disabled={loading || exporting || Boolean(error)}
          onClick={download}
        >
          {exporting ? "导出中…" : "导出筛选结果 Excel"}
        </button>
      </div>
      {exportError && (
        <p className="load-error" role="alert">
          {exportError}
        </p>
      )}
      <JudgePanel
        active={active}
        runIds={loading || error ? [] : records.map((item) => item.id)}
        selectedRunId={selected?.id}
      />
      {!loading && !error && view && (
        <section className="evaluation-summary" aria-label="评估统计">
          <p className="program-summary">
            程序检查：共 {view.summary.total} 条记录 · 已生成{" "}
            {view.summary.generated} · 失败 {view.summary.failed} · 停止{" "}
            {view.summary.stopped}。结构通过不代表话术质量合格。
          </p>
          <div className="quality-grid">
            {(["human", "ai"] as const).map((source) => {
              const data = view.summary[source];
              const ratio = (count: number, total: number) =>
                `${count}/${total}（${total ? `${Math.round((count / total) * 100)}%` : "暂无数据"}）`;
              return (
                <section
                  key={source}
                  aria-label={`${reviewLabels[source]}统计`}
                >
                  <h3>{reviewLabels[source]}</h3>
                  <dl>
                    <dt>单条合格</dt>
                    <dd>{ratio(data.passed_messages, data.total_messages)}</dd>
                    <dt>案例可用</dt>
                    <dd>{ratio(data.usable_cases, view.summary.generated)}</dd>
                    <dt>整组达标</dt>
                    <dd>
                      {ratio(data.qualified_groups, view.summary.generated)}
                    </dd>
                  </dl>
                  <p>
                    已评 {data.reviewed_messages} 条 · 未评{" "}
                    {data.unreviewed_messages} 条 · 完整评价{" "}
                    {data.fully_reviewed_cases} 例
                  </p>
                </section>
              );
            })}
          </div>
          <p className="review-reminder">
            分母为筛选范围内全部已生成话术或案例，未评估不算合格。案例可用：至少一条合格；整组达标：三条均合格且切入点有差异。两类评价独立统计。
          </p>
        </section>
      )}
      {error && (
        <div className="load-error" role="alert">
          {error}
        </div>
      )}
      {!error && loading ? (
        <div className="result-empty" role="status">
          正在读取历史记录…
        </div>
      ) : !error && records.length === 0 ? (
        <div className="result-empty">
          <Icon name="history" />
          <h3>当前范围没有生成记录</h3>
          <p>调整筛选条件，或在话术工作台生成消息。</p>
          <a href="#workbench" className="button secondary">
            前往话术工作台
          </a>
        </div>
      ) : (
        !error && (
          <div className="history-grid">
            <div className="history-list" aria-label="生成记录">
              {records.map((item) => (
                <button
                  className={`history-item ${selected?.id === item.id ? "active" : ""}`}
                  key={item.id}
                  onClick={() => setSelectedId(item.id)}
                  aria-pressed={selected?.id === item.id}
                >
                  <div>
                    <strong>{labels[item.input.scenario] ?? "沟通记录"}</strong>
                    <span className={`run-status ${item.result.status}`}>
                      {statuses[item.result.status]}
                    </span>
                  </div>
                  <p>{item.input.client_information}</p>
                  <small>
                    {new Date(item.created_at).toLocaleString("zh-CN")} ·{" "}
                    {item.prompt_version}
                  </small>
                </button>
              ))}
            </div>
            {selected && (
              <section className="history-detail" aria-label="运行详情">
                <div className="result-title">
                  <h2>{labels[selected.input.scenario] ?? "沟通记录"}</h2>
                  <span>{statuses[selected.result.status]}</span>
                </div>
                <div className="generation-meta">
                  <span>{selected.model ?? "未调用模型"}</span>
                  <span>提示词 {selected.prompt_version}</span>
                </div>
                <details className="snapshot-details">
                  <summary>查看当次输入与产品快照</summary>
                  <dl>
                    <dt>客户信息</dt>
                    <dd>{selected.input.client_information}</dd>
                    <dt>对话历史</dt>
                    <dd>{selected.input.conversation_history || "未提供"}</dd>
                    <dt>场景补充</dt>
                    <dd>{selected.input.scenario_information || "未提供"}</dd>
                    <dt>联系意愿</dt>
                    <dd>
                      {
                        {
                          active: "可以联系或继续回复",
                          just_refused: "客户刚在当前对话中提出拒联",
                          do_not_contact: "此前已拒联，且对话已经结束",
                        }[selected.input.contact_status]
                      }
                    </dd>
                    <dt>产品资料</dt>
                    <dd>
                      {selected.products.length
                        ? selected.products.map((product) => (
                            <div key={product.id}>
                              <strong>
                                {product.name} · ¥
                                {product.price.toLocaleString("zh-CN")}
                              </strong>
                              <p>
                                {product.material} · {product.dimensions} ·{" "}
                                {product.weight}
                              </p>
                              <p>{product.usage}</p>
                              <p>保养：{product.care}</p>
                            </div>
                          ))
                        : "未选择产品"}
                    </dd>
                  </dl>
                </details>
                {selected.result.warnings.length > 0 && (
                  <div className="result-notice">
                    <Icon name="alert" />
                    <div>
                      {selected.result.warnings.map((warning) => (
                        <p key={warning}>{warning}</p>
                      ))}
                    </div>
                  </div>
                )}
                {selected.result.status === "stopped" ? (
                  <div className="result-empty stopped">
                    <Icon name="lock" />
                    <h3>建议不联系</h3>
                    <p>未生成主动触达消息。</p>
                  </div>
                ) : selected.result.status === "failed" ? (
                  <div className="load-error">
                    <p>{selected.result.error}</p>
                    {selected.raw_output && (
                      <details>
                        <summary>查看原始模型输出</summary>
                        <pre>{selected.raw_output}</pre>
                      </details>
                    )}
                  </div>
                ) : (
                  <CandidateList key={selected.id} record={selected} />
                )}
                {selected.result.status === "generated" && (
                  <EvaluationPanel
                    key={selected.id}
                    record={selected}
                    evaluations={view?.evaluations ?? []}
                    onSaved={() => setAttempt((value) => value + 1)}
                  />
                )}
                <RunComparison
                  key={`compare-${selected.id}-${attempt}`}
                  record={selected}
                />
              </section>
            )}
          </div>
        )
      )}
      <footer className="page-footer">
        <span>序棠顾问工作室</span>
        <span>记录包含当次快照，供后续评估使用</span>
      </footer>
    </main>
  );
}
