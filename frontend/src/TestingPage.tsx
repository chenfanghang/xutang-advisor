import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { generationApi, testingApi } from "./api";
import type { BatchRun, Catalog, RunRecord, TestCase } from "./api";
import { CandidateList } from "./CandidateList";
import { Workbench } from "./Workbench";
import { Icon } from "./Icon";
import { ScenarioSimulation } from "./ScenarioSimulation";

const batchStatus = {
  running: "运行中",
  completed: "已完成",
  interrupted: "已中断",
  failed: "异常结束",
};
const resultStatus = {
  generated: "已生成",
  stopped: "停止生成",
  failed: "失败",
};

export function TestingPage({
  active,
  catalog,
  catalogError,
  onRetryCatalog,
  onCreated,
}: {
  active: boolean;
  catalog: Catalog | null;
  catalogError: string;
  onRetryCatalog: () => void;
  onCreated: () => void;
}) {
  const [mode, setMode] = useState<"single" | "simulation" | "batch">("single");
  const [cases, setCases] = useState<TestCase[]>([]);
  const [version, setVersion] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [batches, setBatches] = useState<BatchRun[]>([]);
  const [batch, setBatch] = useState<BatchRun | null>(null);
  const [resultCaseId, setResultCaseId] = useState("");
  const [result, setResult] = useState<RunRecord | null>(null);
  const [detailError, setDetailError] = useState("");
  const [detailAttempt, setDetailAttempt] = useState(0);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const singleTab = useRef<HTMLButtonElement>(null);
  const simulationTab = useRef<HTMLButtonElement>(null);
  const batchTab = useRef<HTMLButtonElement>(null);

  function moveTab(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const modes = ["single", "simulation", "batch"] as const;
    const index = modes.indexOf(mode);
    const next =
      event.key === "Home"
        ? "single"
        : event.key === "End"
          ? "batch"
          : modes[(index + (event.key === "ArrowRight" ? 1 : 2)) % 3];
    setMode(next);
    (next === "single"
      ? singleTab
      : next === "simulation"
        ? simulationTab
        : batchTab
    ).current?.focus();
  }

  useEffect(() => {
    if (!active) return;
    let mounted = true;
    Promise.all([testingApi.cases(), testingApi.batches()])
      .then(([dataset, items]) => {
        if (!mounted) return;
        setCases(dataset.cases);
        setVersion(dataset.version);
        setBatches(items);
        setError("");
        setBatch(
          (previous) =>
            items.find((item) => item.id === previous?.id) ?? items[0] ?? null,
        );
      })
      .catch((reason: unknown) => {
        if (mounted)
          setError(
            reason instanceof Error ? reason.message : "测试资料读取失败。",
          );
      });
    return () => {
      mounted = false;
    };
  }, [active, attempt]);

  const runningBatchId = batches.find((item) => item.status === "running")?.id;
  useEffect(() => {
    if (!active || !runningBatchId) return;
    let stopped = false;
    let timer: number | undefined;
    async function poll() {
      try {
        const data = await testingApi.batch(runningBatchId!);
        if (!stopped) {
          setBatch((selected) => (selected?.id === data.id ? data : selected));
          setBatches((items) =>
            items.map((item) => (item.id === data.id ? data : item)),
          );
          setError("");
        }
      } catch (reason) {
        if (!stopped)
          setError(
            reason instanceof Error
              ? reason.message
              : "进度读取失败，可重新读取。",
          );
      } finally {
        if (!stopped) timer = window.setTimeout(() => void poll(), 700);
      }
    }
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [active, runningBatchId]);

  const selectedCase = cases.find((item) => item.id === selectedId) ?? cases[0];
  const selectedItem =
    batch?.items.find((item) => item.case_id === resultCaseId) ??
    (!resultCaseId ? batch?.items[0] : undefined);
  const runId = selectedItem?.run_id;
  useEffect(() => {
    if (!runId) return;
    let mounted = true;
    generationApi
      .record(runId)
      .then((record) => {
        if (mounted) {
          setResult(record);
          setDetailError("");
        }
      })
      .catch((reason: unknown) => {
        if (mounted)
          setDetailError(
            reason instanceof Error ? reason.message : "结果读取失败。",
          );
      });
    return () => {
      mounted = false;
    };
  }, [runId, detailAttempt]);

  async function start() {
    setStarting(true);
    setError("");
    try {
      const data = await testingApi.start();
      setBatch(data);
      setBatches((items) => [data, ...items]);
      setResultCaseId("");
      setResult(null);
      setDetailError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "批次启动失败。");
    } finally {
      setStarting(false);
    }
  }

  const completed = batch?.items.length ?? 0;
  const failed =
    batch?.items.filter((item) => item.status === "failed").length ?? 0;
  const running = batches.some((item) => item.status === "running");

  return (
    <main id="testing" tabIndex={-1}>
      <div className="page-heading">
        <div>
          <h1>在线测试</h1>
          <p className="page-description">
            手动模拟客户对话、编辑单个案例，或运行固定的 50 例。
          </p>
        </div>
        <span className="page-label">固定输入 · {version || "正在读取"}</span>
      </div>
      <div
        className="section-tabs testing-tabs"
        role="tablist"
        aria-label="测试方式"
        onKeyDown={moveTab}
      >
        <button
          role="tab"
          id="single-tab"
          ref={singleTab}
          tabIndex={mode === "single" ? 0 : -1}
          aria-selected={mode === "single"}
          aria-controls="single-panel"
          onClick={() => setMode("single")}
        >
          单例测试
        </button>
        <button
          role="tab"
          id="simulation-tab"
          ref={simulationTab}
          tabIndex={mode === "simulation" ? 0 : -1}
          aria-selected={mode === "simulation"}
          aria-controls="simulation-panel"
          onClick={() => setMode("simulation")}
        >
          场景模拟
        </button>
        <button
          role="tab"
          id="batch-tab"
          ref={batchTab}
          tabIndex={mode === "batch" ? 0 : -1}
          aria-selected={mode === "batch"}
          aria-controls="batch-panel"
          onClick={() => setMode("batch")}
        >
          批量测试
        </button>
      </div>
      {error && (
        <div className="load-error" role="alert">
          <p>{error}</p>
          <button
            className="button secondary"
            onClick={() => setAttempt((value) => value + 1)}
          >
            重新读取
          </button>
        </div>
      )}
      <div
        id="single-panel"
        role="tabpanel"
        aria-labelledby="single-tab"
        hidden={mode !== "single"}
      >
        {selectedCase ? (
          <>
            <div className="case-selector">
              <div className="field">
                <label htmlFor="test-case">选择固定案例</label>
                <select
                  id="test-case"
                  value={selectedCase.id}
                  onChange={(event) => setSelectedId(event.currentTarget.value)}
                >
                  {cases.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.id} · {item.title}
                    </option>
                  ))}
                </select>
              </div>
              <p>
                <strong>本例关注：</strong>
                {selectedCase.focus}
              </p>
              <p>下面编辑的是本次运行副本，不会覆盖固定测试集。</p>
            </div>
            <Workbench
              key={selectedCase.id}
              initialInput={selectedCase.input}
              embedded
              catalog={catalog}
              catalogError={catalogError}
              onRetry={onRetryCatalog}
              onCreated={onCreated}
            />
          </>
        ) : (
          !error && (
            <div className="result-empty" role="status">
              正在读取固定案例…
            </div>
          )
        )}
      </div>
      <div
        id="simulation-panel"
        role="tabpanel"
        aria-labelledby="simulation-tab"
        hidden={mode !== "simulation"}
      >
        <ScenarioSimulation
          cases={cases}
          onCreated={onCreated}
          catalog={catalog}
        />
      </div>
      <div
        id="batch-panel"
        role="tabpanel"
        aria-labelledby="batch-tab"
        hidden={mode !== "batch"}
      >
        <section className="batch-overview">
          <div>
            <h2>固定 50 例 · 六个场景</h2>
            <p>产品推荐、价格异议各 9 例，其余场景各 8 例。每例完成即保存。</p>
            <p>使用启动时已保存的模型配置；会调用模型 API，可能产生费用。</p>
          </div>
          <button
            className="button primary"
            disabled={starting || running || cases.length !== 50}
            onClick={() => void start()}
          >
            {starting ? "正在启动…" : running ? "批次运行中" : "运行固定 50 例"}
            <Icon name="arrow" />
          </button>
        </section>
        {batches.length > 0 && (
          <div className="field batch-selector">
            <label htmlFor="batch-select">查看批次</label>
            <select
              id="batch-select"
              value={batch?.id ?? ""}
              onChange={(event) => {
                setBatch(
                  batches.find(
                    (item) => item.id === event.currentTarget.value,
                  ) ?? null,
                );
                setResultCaseId("");
                setResult(null);
                setDetailError("");
              }}
            >
              {batches.map((item) => (
                <option key={item.id} value={item.id}>
                  {new Date(item.created_at).toLocaleString("zh-CN")} ·{" "}
                  {item.model} · {batchStatus[item.status]}
                </option>
              ))}
            </select>
          </div>
        )}
        {batch ? (
          <>
            <div className="batch-progress">
              <div>
                <strong>{batchStatus[batch.status]}</strong>
                <span role="status">
                  已完成 {completed} / {batch.cases.length} · 失败 {failed} 例
                </span>
              </div>
              <progress
                max={batch.cases.length}
                value={completed}
                aria-label="批量测试进度"
              />
              <p>
                {batch.cases_version} · 提示词 {batch.prompt_version} · 模型{" "}
                {batch.model}
              </p>
              {batch.error && <p className="error-text">{batch.error}</p>}
            </div>
            <div className="batch-results-grid">
              <div className="batch-table-box">
                <table className="batch-table">
                  <thead>
                    <tr>
                      <th>案例</th>
                      <th>情境</th>
                      <th>结果</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batch.cases.map((item, index) => {
                      const outcome = batch.items.find(
                        (entry) => entry.case_id === item.id,
                      );
                      return (
                        <tr
                          className={
                            selectedItem?.case_id === item.id
                              ? "selected-row"
                              : ""
                          }
                          key={item.id}
                        >
                          <td>
                            <button
                              className="text-button"
                              onClick={() => {
                                setResultCaseId(item.id);
                                setResult(null);
                                setDetailError("");
                                setDetailAttempt((value) => value + 1);
                              }}
                            >
                              {item.id}
                            </button>
                          </td>
                          <td>{item.title}</td>
                          <td>
                            <span
                              className={`run-status ${outcome?.status ?? ""}`}
                            >
                              {outcome
                                ? resultStatus[outcome.status]
                                : batch.status === "running" &&
                                    index === completed
                                  ? "等待结果"
                                  : "未运行"}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <section className="batch-detail" aria-label="案例运行结果">
                <div className="result-title">
                  <h2>
                    {selectedItem?.case_id ?? (resultCaseId || "案例结果")}
                  </h2>
                  <span>点击案例编号查看</span>
                </div>
                {detailError ? (
                  <p className="error-text" role="alert">
                    {detailError}
                  </p>
                ) : selectedItem && result && result.id === runId ? (
                  <>
                    <div className="generation-meta">
                      <span>{result.model ?? "规则处理，未调用模型"}</span>
                      <span>提示词 {result.prompt_version}</span>
                    </div>
                    <details className="snapshot-details">
                      <summary>查看当次测试输入</summary>
                      <dl>
                        <dt>客户信息</dt>
                        <dd>{result.input.client_information}</dd>
                        <dt>对话历史</dt>
                        <dd>{result.input.conversation_history || "未提供"}</dd>
                        <dt>场景补充</dt>
                        <dd>{result.input.scenario_information || "未提供"}</dd>
                      </dl>
                    </details>
                    {result.result.status === "failed" ? (
                      <div className="load-error">
                        <p>{result.result.error}</p>
                        <details>
                          <summary>查看原始输出</summary>
                          <pre>
                            {result.raw_output || "模型服务未返回文本。"}
                          </pre>
                        </details>
                      </div>
                    ) : result.result.status === "stopped" ? (
                      <div className="result-notice">
                        建议不联系，未生成话术。
                      </div>
                    ) : (
                      <CandidateList key={result.id} record={result} />
                    )}
                  </>
                ) : (
                  <div className="result-empty">
                    <Icon name="test" />
                    <h3>{selectedItem ? "正在读取结果" : "尚无已完成结果"}</h3>
                    <p>已完成的案例可查看三条输出或具体失败原因。</p>
                  </div>
                )}
              </section>
            </div>
          </>
        ) : (
          <div className="result-empty">
            <Icon name="test" />
            <h3>还没有批量运行记录</h3>
            <p>点击“运行固定 50 例”开始。结果会保存到本机数据库。</p>
          </div>
        )}
      </div>
      <footer className="page-footer">
        <span>序棠顾问工作室</span>
        <span>生成成功不等于质量合格，仍需后续评估</span>
      </footer>
    </main>
  );
}
