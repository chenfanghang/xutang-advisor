import { useState } from "react";
import type { FormEvent } from "react";
import { evaluationApi } from "./api";
import type {
  Evaluation,
  EvaluationInput,
  ReviewSource,
  RunRecord,
} from "./api";

export const reviewLabels = { human: "人工复核", ai: "AI 初评" };
const judgmentValue = (value: boolean | null) =>
  value === null ? "" : value ? "pass" : "fail";
const parseJudgment = (value: string) =>
  value === "" ? null : value === "pass";

export function EvaluationPanel({
  record,
  evaluations,
  onSaved,
}: {
  record: RunRecord;
  evaluations: Evaluation[];
  onSaved: (value: Evaluation) => void;
}) {
  const [source, setSource] = useState<ReviewSource>("human");
  const saved = evaluations.find(
    (item) => item.run_id === record.id && item.source === source,
  );
  return (
    <section className="evaluation-panel" aria-label="话术质量评估">
      <h3>话术质量评估</h3>
      <div className="field">
        <label htmlFor="review-source">评价来源</label>
        <select
          id="review-source"
          value={source}
          onChange={(event) =>
            setSource(event.currentTarget.value as ReviewSource)
          }
        >
          <option value="human">人工复核</option>
          <option value="ai">AI 初评（手动录入）</option>
        </select>
        <p>
          两类评价分别保存。AI 初评请录入已有评价，本页不会自动调用模型评分。
        </p>
      </div>
      <EvaluationForm
        key={`${record.id}-${source}`}
        record={record}
        source={source}
        saved={saved}
        onSaved={onSaved}
      />
    </section>
  );
}

function EvaluationForm({
  record,
  source,
  saved,
  onSaved,
}: {
  record: RunRecord;
  source: ReviewSource;
  saved?: Evaluation;
  onSaved: (value: Evaluation) => void;
}) {
  const [draft, setDraft] = useState<EvaluationInput>(
    () =>
      saved ?? {
        source,
        candidates: record.result.messages.map(() => ({
          passed: null,
          reason: "",
        })),
        distinct: null,
        distinct_reason: "",
        notes: "",
      },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  function edit(update: Partial<EvaluationInput>) {
    setDraft((current) => ({ ...current, ...update }));
    setMessage("");
    setError("");
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const value = await evaluationApi.save(record.id, draft);
      onSaved(value);
      setMessage(`${reviewLabels[source]}已保存。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "评价保存失败。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={save}>
      <p className="review-reminder">
        按事实、权限、客户意愿、场景回应及品牌表达判断。未评估不算合格。
      </p>
      <fieldset disabled={busy}>
        {draft.candidates.map((candidate, index) => (
          <div className="review-candidate" key={index}>
            <div className="field">
              <label htmlFor={`review-${index}`}>候选 {index + 1} 判断</label>
              <select
                id={`review-${index}`}
                value={judgmentValue(candidate.passed)}
                onChange={(event) =>
                  edit({
                    candidates: draft.candidates.map((item, i) =>
                      i === index
                        ? {
                            ...item,
                            passed: parseJudgment(event.currentTarget.value),
                          }
                        : item,
                    ),
                  })
                }
              >
                <option value="">未评估</option>
                <option value="pass">合格</option>
                <option value="fail">不合格</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor={`reason-${index}`}>候选 {index + 1} 原因</label>
              <textarea
                id={`reason-${index}`}
                rows={2}
                required={candidate.passed === false}
                value={candidate.reason}
                placeholder="不合格时必填；请说明具体问题"
                onChange={(event) =>
                  edit({
                    candidates: draft.candidates.map((item, i) =>
                      i === index
                        ? { ...item, reason: event.currentTarget.value }
                        : item,
                    ),
                  })
                }
              />
            </div>
          </div>
        ))}
        <div className="field">
          <label htmlFor="review-distinct">候选切入点差异</label>
          <select
            id="review-distinct"
            value={judgmentValue(draft.distinct)}
            onChange={(event) =>
              edit({ distinct: parseJudgment(event.currentTarget.value) })
            }
          >
            <option value="">未评估</option>
            <option value="pass">有实际差异</option>
            <option value="fail">缺乏差异</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="review-distinct-reason">差异原因</label>
          <textarea
            id="review-distinct-reason"
            rows={2}
            value={draft.distinct_reason}
            required={draft.distinct === false}
            onChange={(event) =>
              edit({ distinct_reason: event.currentTarget.value })
            }
          />
        </div>
        <div className="field">
          <label htmlFor="review-notes">评价备注</label>
          <textarea
            id="review-notes"
            rows={2}
            value={draft.notes}
            onChange={(event) => edit({ notes: event.currentTarget.value })}
          />
        </div>
        <button className="button primary" type="submit">
          {busy ? "保存中…" : `保存${reviewLabels[source]}`}
        </button>
      </fieldset>
      {saved && (
        <p className="review-reminder">
          最近保存：{new Date(saved.updated_at).toLocaleString("zh-CN")}
        </p>
      )}
      {error && (
        <p className="load-error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="copy-feedback" role="status">
          {message}
        </p>
      )}
    </form>
  );
}
