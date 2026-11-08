import { useState } from "react";
import type { FormEvent } from "react";
import { generationApi } from "./api";
import type {
  Catalog,
  ContactStatus,
  GenerationInput,
  RunRecord,
  ScenarioId,
} from "./api";
import { examples } from "./examples";
import { CandidateList } from "./CandidateList";
import { Icon } from "./Icon";

const initialInput: GenerationInput = {
  scenario: "recommendation",
  client_information: "",
  conversation_history: "",
  scenario_information: "",
  product_ids: [],
  contact_status: "active",
};

export function Workbench({
  catalog,
  catalogError,
  onRetry,
  onCreated,
  initialInput: draft,
  embedded = false,
}: {
  catalog: Catalog | null;
  catalogError: string;
  onRetry: () => void;
  onCreated: () => void;
  initialInput?: GenerationInput;
  embedded?: boolean;
}) {
  const [input, setInput] = useState<GenerationInput>(draft ?? initialInput);
  const [record, setRecord] = useState<RunRecord | null>(null);
  const [error, setError] = useState("");
  const [generating, setGenerating] = useState(false);

  function update(patch: Partial<GenerationInput>) {
    setInput((value) => ({ ...value, ...patch }));
    setRecord(null);
    setError("");
  }

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setGenerating(true);
    setError("");
    setRecord(null);
    try {
      setRecord(await generationApi.generate(input));
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "生成未完成，请重试。",
      );
    } finally {
      setGenerating(false);
      onCreated();
    }
  }

  const Container = embedded ? "section" : "main";
  const prefix = embedded ? "test-" : "";
  const scenario = catalog?.scenarios.find(
    (item) => item.id === input.scenario,
  );
  return (
    <Container id={embedded ? "case-editor" : "workbench"} tabIndex={-1}>
      {!embedded && (
        <>
          <div className="page-heading">
            <div>
              <h1>话术工作台</h1>
              <p className="page-description">
                从真实沟通目的出发，准备三条可选的中文微信消息。
              </p>
            </div>
            <span className="page-label">序棠 · 六种沟通场景</span>
          </div>
          <div className="section-tabs">
            <span>撰写消息</span>
          </div>
        </>
      )}
      {catalogError ? (
        <div className="load-error" role="alert">
          <p>{catalogError}</p>
          <button className="button secondary" onClick={onRetry}>
            重新读取资料
          </button>
        </div>
      ) : (
        <div className="workbench-grid">
          <section
            className="settings-card input-card"
            aria-labelledby="input-title"
            aria-busy={generating}
          >
            <div className="card-heading">
              <div className="heading-icon">
                <Icon name="message" />
              </div>
              <div>
                <h2 id="input-title">沟通资料</h2>
                <p>仅使用虚构客户资料，不填写真实个人信息。</p>
              </div>
              <button
                className="text-button sample-button"
                type="button"
                disabled={generating || !catalog}
                onClick={() => {
                  setInput({ ...examples[input.scenario] });
                  setRecord(null);
                  setError("");
                }}
              >
                填入虚构示例
              </button>
            </div>
            <form onSubmit={(event) => void generate(event)}>
              <fieldset disabled={generating || !catalog}>
                <div className="field">
                  <label htmlFor={`${prefix}scenario`}>业务场景</label>
                  <select
                    id={`${prefix}scenario`}
                    value={input.scenario}
                    onChange={(event) =>
                      update({
                        scenario: event.currentTarget.value as ScenarioId,
                      })
                    }
                  >
                    {catalog?.scenarios.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                  <p>{scenario?.instruction ?? "正在读取场景资料…"}</p>
                </div>
                <div className="field">
                  <label htmlFor={`${prefix}client-information`}>
                    客户信息 <span>必填</span>
                  </label>
                  <textarea
                    id={`${prefix}client-information`}
                    required
                    rows={3}
                    value={input.client_information}
                    onChange={(event) =>
                      update({ client_information: event.currentTarget.value })
                    }
                    placeholder="填写明确的需求、偏好及购买经历；资料均应为虚构。"
                  />
                </div>
                <div className="field">
                  <label htmlFor={`${prefix}conversation-history`}>
                    对话历史
                  </label>
                  <textarea
                    id={`${prefix}conversation-history`}
                    rows={4}
                    value={input.conversation_history}
                    onChange={(event) =>
                      update({
                        conversation_history: event.currentTarget.value,
                      })
                    }
                    placeholder="按时间顺序填写顾问与客户的对话，最新消息放在最后。"
                  />
                </div>
                <div className="field">
                  <label htmlFor={`${prefix}contact-status`}>联系意愿</label>
                  <select
                    id={`${prefix}contact-status`}
                    value={input.contact_status}
                    onChange={(event) =>
                      update({
                        contact_status: event.currentTarget
                          .value as ContactStatus,
                      })
                    }
                  >
                    <option value="active">可以联系或继续回复</option>
                    <option value="just_refused">
                      客户刚在当前对话中提出拒联
                    </option>
                    <option value="do_not_contact">
                      此前已拒联，且对话已经结束
                    </option>
                  </select>
                  <p>
                    请根据最新对话选择；刚拒联只确认意愿，已结束则停止生成。
                  </p>
                </div>
                <div className="field">
                  <label htmlFor={`${prefix}scenario-information`}>
                    场景补充
                  </label>
                  <textarea
                    id={`${prefix}scenario-information`}
                    rows={3}
                    value={input.scenario_information}
                    onChange={(event) =>
                      update({
                        scenario_information: event.currentTarget.value,
                      })
                    }
                    placeholder="例如节日、活动时间地点、预算、库存或已明确的服务政策。"
                  />
                </div>
                <details className="product-picker">
                  <summary>
                    相关产品 <span>已选 {input.product_ids.length} 款</span>
                  </summary>
                  <div className="product-options">
                    {catalog?.products.map((product) => (
                      <label
                        className={`product-option ${input.product_ids.includes(product.id) ? "checked" : ""}`}
                        key={product.id}
                      >
                        <input
                          type="checkbox"
                          checked={input.product_ids.includes(product.id)}
                          onChange={(event) =>
                            update({
                              product_ids: event.currentTarget.checked
                                ? [...input.product_ids, product.id]
                                : input.product_ids.filter(
                                    (id) => id !== product.id,
                                  ),
                            })
                          }
                        />
                        <span>
                          <strong>
                            {product.name}
                            <em>¥{product.price.toLocaleString("zh-CN")}</em>
                          </strong>
                          <small>
                            {product.material} · {product.weight}
                          </small>
                          <small>
                            {product.dimensions} · {product.colors.join(" / ")}
                          </small>
                          <small>{product.usage}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                </details>
                <div className="form-footer">
                  <span className="save-state">生成后自动保存历史</span>
                  <button className="button primary" type="submit">
                    {generating
                      ? "正在处理…"
                      : input.contact_status === "do_not_contact"
                        ? "确认停止联系"
                        : input.contact_status === "just_refused"
                          ? "生成确认回复"
                          : "生成三条话术"}
                    <Icon name="arrow" />
                  </button>
                </div>
              </fieldset>
              <div className="save-feedback" aria-live="polite">
                {error && (
                  <p className="error-text" role="alert">
                    {error} 输入已保留，可修改后重试。
                  </p>
                )}
              </div>
            </form>
          </section>
          <section
            className="results-column"
            aria-labelledby="results-title"
            aria-busy={generating}
          >
            <div className="result-title">
              <h2 id="results-title">候选话术</h2>
              <span>
                {record?.result.status === "generated"
                  ? "3 条候选"
                  : "由顾问审核后发送"}
              </span>
            </div>
            {generating ? (
              <div className="result-empty" role="status">
                <span className="generation-spinner" />
                <h3>正在准备候选话术</h3>
                <p>正在处理当前资料，请稍候。</p>
              </div>
            ) : record ? (
              <>
                {record.result.warnings.length > 0 && (
                  <div className="result-notice">
                    <Icon name="alert" />
                    <div>
                      {record.result.warnings.map((warning) => (
                        <p key={warning}>{warning}</p>
                      ))}
                    </div>
                  </div>
                )}
                {record.result.status === "stopped" ? (
                  <div className="result-empty stopped">
                    <Icon name="lock" />
                    <h3>建议不联系</h3>
                    <p>尊重客户意愿，不再拟定主动触达消息。</p>
                  </div>
                ) : (
                  <>
                    <div className="generation-meta">
                      <span>
                        {record.result.source === "rule"
                          ? "规则生成 · 未调用模型"
                          : `模型生成 · ${record.model}`}
                      </span>
                      <span>提示词 {record.prompt_version}</span>
                    </div>
                    <CandidateList key={record.id} record={record} />
                    <p className="review-reminder">
                      候选内容尚未经过人工审核。请确认事实、语气及客户意愿后使用。
                    </p>
                  </>
                )}
              </>
            ) : (
              <div className="result-empty">
                <Icon name="message" />
                <h3>从一次有依据的沟通开始</h3>
                <p>填写左侧资料并生成，或先载入虚构示例。</p>
                <p>内容将结合场景与产品事实，供你选择和调整。</p>
              </div>
            )}
          </section>
        </div>
      )}
      {!embedded && (
        <footer className="page-footer">
          <span>序棠顾问工作室</span>
          <span>所有品牌与客户资料均为虚构</span>
        </footer>
      )}
    </Container>
  );
}
