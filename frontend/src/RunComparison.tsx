import { useEffect, useState } from "react";
import { evaluationApi } from "./api";
import type { RunRecord } from "./api";

export function RunComparison({ record }: { record: RunRecord }) {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    evaluationApi
      .comparisons(record.id)
      .then((values) => {
        if (active) setRuns(values);
      })
      .catch((reason: unknown) => {
        if (active)
          setError(
            reason instanceof Error ? reason.message : "对比记录读取失败。",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [record.id]);
  const compared = runs.find((run) => run.id === selectedId);
  return (
    <details className="snapshot-details comparison-panel">
      <summary>同输入结果对比</summary>
      <div className="comparison-body">
        <p className="review-reminder">
          完整业务输入与产品快照一致；提示词、品牌规则及模型版本可以不同。这里只展示结果，不自动判断质量提升。
        </p>
        {error ? (
          <p role="alert">{error}</p>
        ) : loading ? (
          <p>读取中…</p>
        ) : runs.length === 0 ? (
          <p>
            暂无其他同输入记录。修改提示词版本后，使用相同输入重新生成即可对比。
          </p>
        ) : (
          <>
            <div className="field">
              <label htmlFor="comparison-run">对比记录</label>
              <select
                id="comparison-run"
                value={selectedId}
                onChange={(event) => setSelectedId(event.currentTarget.value)}
              >
                <option value="">请选择记录</option>
                {runs.map((run) => (
                  <option value={run.id} key={run.id}>
                    {run.prompt_version} · {run.model ?? "规则回复"} ·{" "}
                    {new Date(run.created_at).toLocaleString("zh-CN")} ·{" "}
                    {run.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            </div>
            {compared && (
              <div className="comparison-grid">
                {[record, compared].map((run, index) => (
                  <section
                    key={run.id}
                    aria-label={index === 0 ? "当前结果" : "对照结果"}
                  >
                    <h4>
                      {index === 0 ? "当前结果" : "对照结果"} ·{" "}
                      {run.prompt_version}
                    </h4>
                    <p className="review-reminder">
                      {run.model ?? "未调用模型"} · {run.id}
                    </p>
                    {run.result.messages.map((message, i) => (
                      <p key={i}>
                        {i + 1}. {message}
                      </p>
                    ))}
                    {run.result.error && <p>{run.result.error}</p>}
                    {run.result.status === "stopped" && (
                      <p>停止生成，未触达。</p>
                    )}
                    <details>
                      <summary>查看提示词快照</summary>
                      <pre>
                        {run.brand_rules}
                        {"\n"}
                        {run.scenario_instruction}
                      </pre>
                    </details>
                  </section>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </details>
  );
}
