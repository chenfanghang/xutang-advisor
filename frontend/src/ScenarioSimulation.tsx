import { useState } from "react";
import type { FormEvent } from "react";
import { generationApi } from "./api";
import type { Catalog, ContactStatus, RunRecord, TestCase } from "./api";

type Turn = { role: "客户" | "顾问"; text: string };

export function ScenarioSimulation({
  cases,
  onCreated,
  catalog,
}: {
  cases: TestCase[];
  onCreated: () => void;
  catalog: Catalog | null;
}) {
  const [selectedId, setSelectedId] = useState("");
  const selected = cases.find((item) => item.id === selectedId) ?? cases[0];
  if (!selected)
    return (
      <div className="result-empty" role="status">
        正在读取固定案例…
      </div>
    );
  return (
    <>
      <div className="case-selector">
        <div className="field">
          <label htmlFor="simulation-case">模拟场景</label>
          <select
            id="simulation-case"
            value={selected.id}
            onChange={(event) => setSelectedId(event.currentTarget.value)}
          >
            {cases.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id} · {item.title}
              </option>
            ))}
          </select>
          <p>切换场景会开始新的模拟；案例资料均为虚构。</p>
        </div>
      </div>
      <Conversation
        key={selected.id}
        scenario={selected}
        onCreated={onCreated}
        catalog={catalog}
      />
    </>
  );
}

function Conversation({
  scenario,
  onCreated,
  catalog,
}: {
  scenario: TestCase;
  onCreated: () => void;
  catalog: Catalog | null;
}) {
  const [clientInformation, setClientInformation] = useState(
    scenario.input.client_information,
  );
  const [scenarioInformation, setScenarioInformation] = useState(
    scenario.input.scenario_information,
  );
  const [productIds, setProductIds] = useState(scenario.input.product_ids);
  const [history, setHistory] = useState(scenario.input.conversation_history);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [message, setMessage] = useState("");
  const [contact, setContact] = useState<ContactStatus>(
    scenario.input.contact_status,
  );
  const [record, setRecord] = useState<RunRecord | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [needsRetry, setNeedsRetry] = useState(false);
  const [ended, setEnded] = useState(false);

  async function generate(nextTurns: Turn[], nextContact: ContactStatus) {
    setPending(true);
    setError("");
    setRecord(null);
    const transcript = [
      history.trim(),
      ...nextTurns.map((turn) => `${turn.role}：${turn.text}`),
    ]
      .filter(Boolean)
      .join("\n");
    try {
      const result = await generationApi.generate({
        ...scenario.input,
        client_information: clientInformation,
        scenario_information: scenarioInformation,
        product_ids: productIds,
        conversation_history: transcript,
        contact_status: nextContact,
      });
      setRecord(result);
      setNeedsRetry(false);
      if (result.result.status === "stopped") setEnded(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "生成失败，请重试。");
      setNeedsRetry(true);
    } finally {
      setPending(false);
      onCreated();
    }
  }

  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = message.trim();
    if (
      !text ||
      !clientInformation.trim() ||
      pending ||
      record ||
      ended ||
      needsRetry
    )
      return;
    const next: Turn[] = [...turns, { role: "客户", text }];
    setTurns(next);
    setMessage("");
    void generate(next, contact);
  }

  function choose(text: string) {
    if (!record || pending) return;
    setTurns((current) => [...current, { role: "顾问", text }]);
    if (record.input.contact_status === "just_refused") setEnded(true);
    setRecord(null);
  }

  return (
    <div className="simulation-grid">
      <section
        className="settings-card simulation-context"
        aria-label="模拟场景资料"
      >
        <h2>场景资料</h2>
        <p className="review-reminder">{scenario.focus}</p>
        <div className="field">
          <label htmlFor="simulation-client">模拟对象资料</label>
          <textarea
            id="simulation-client"
            rows={4}
            value={clientInformation}
            disabled={turns.length > 0 || pending}
            onChange={(event) =>
              setClientInformation(event.currentTarget.value)
            }
          />
        </div>
        <div className="field">
          <label htmlFor="simulation-scenario">模拟场景补充</label>
          <textarea
            id="simulation-scenario"
            rows={3}
            value={scenarioInformation}
            disabled={turns.length > 0 || pending}
            onChange={(event) =>
              setScenarioInformation(event.currentTarget.value)
            }
          />
        </div>
        <fieldset
          className="simulation-products"
          disabled={turns.length > 0 || pending}
        >
          <legend>相关产品</legend>
          {catalog?.products.map((product) => (
            <label key={product.id}>
              <input
                type="checkbox"
                checked={productIds.includes(product.id)}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  setProductIds((current) =>
                    checked
                      ? [...current, product.id]
                      : current.filter((id) => id !== product.id),
                  );
                }}
              />{" "}
              {product.name} · ¥{product.price.toLocaleString("zh-CN")}
            </label>
          ))}
        </fieldset>
        <div className="field">
          <label htmlFor="simulation-history">初始对话历史</label>
          <textarea
            id="simulation-history"
            rows={5}
            value={history}
            disabled={turns.length > 0 || pending}
            onChange={(event) => setHistory(event.currentTarget.value)}
          />
          <p>开始后固定初始历史；模拟消息会按顺序追加。</p>
        </div>
      </section>
      <section className="simulation-chat" aria-label="客户对话模拟">
        <div className="result-title">
          <h2>模拟对话</h2>
          <span>你扮演客户</span>
        </div>
        <div
          className="simulation-log"
          role="log"
          aria-label="模拟对话记录"
          aria-live="polite"
        >
          {history && (
            <div className="simulation-initial">
              <strong>初始对话</strong>
              <p>{history}</p>
            </div>
          )}
          {turns.map((turn, index) => (
            <div
              key={index}
              className={`simulation-turn ${turn.role === "客户" ? "client" : "advisor"}`}
            >
              <strong>{turn.role}</strong>
              <p>{turn.text}</p>
            </div>
          ))}
          {turns.length === 0 && !history && (
            <p className="review-reminder">输入一条客户消息，开始模拟。</p>
          )}
        </div>
        {ended && (
          <div className="result-notice" role="status">
            {contact === "just_refused"
              ? "客户已拒绝联系，模拟会话已结束。"
              : "建议不联系，模拟会话已结束。"}
          </div>
        )}
        {error && (
          <div className="load-error" role="alert">
            {error}
          </div>
        )}
        {needsRetry && !ended && (
          <button
            className="button secondary"
            disabled={pending}
            onClick={() => void generate(turns, contact)}
          >
            重试生成候选
          </button>
        )}
        <form className="simulation-compose" onSubmit={send}>
          <div className="field">
            <label htmlFor="simulation-contact">模拟联系意愿</label>
            <select
              id="simulation-contact"
              value={contact}
              disabled={pending || ended || !!record || needsRetry}
              onChange={(event) =>
                setContact(event.currentTarget.value as ContactStatus)
              }
            >
              <option value="active">可以继续沟通</option>
              <option value="just_refused">客户刚提出拒联</option>
              <option value="do_not_contact">此前已拒联，且对话已结束</option>
            </select>
            <p>客户要求停止联系时，请选择对应状态。</p>
          </div>
          <div className="field">
            <label htmlFor="simulation-message">模拟客户消息</label>
            <textarea
              id="simulation-message"
              rows={3}
              value={message}
              disabled={pending || ended || !!record || needsRetry}
              onChange={(event) => setMessage(event.currentTarget.value)}
              placeholder="由你扮演客户，输入下一句话"
            />
          </div>
          <button
            className="button primary"
            type="submit"
            disabled={
              !message.trim() ||
              !clientInformation.trim() ||
              pending ||
              ended ||
              !!record ||
              needsRetry
            }
          >
            {pending ? "正在生成…" : "发送客户消息并生成"}
          </button>
        </form>
        <section className="simulation-candidates" aria-label="模拟候选话术">
          <div className="result-title">
            <h2>顾问候选话术</h2>
            <span>选择一条加入模拟对话</span>
          </div>
          {record?.result.source === "rule" && (
            <p className="review-reminder">规则生成 · 未调用模型</p>
          )}
          {record?.result.warnings.map((warning) => (
            <p className="review-reminder" key={warning}>
              {warning}
            </p>
          ))}
          {record?.result.messages.map((text, index) => (
            <article className="candidate-card" key={index}>
              <div className="candidate-heading">
                <span>候选 {index + 1}</span>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => choose(text)}
                >
                  采用第 {index + 1} 条
                </button>
              </div>
              <p className="message-text">{text}</p>
            </article>
          ))}
          {!record && !pending && !ended && (
            <p className="review-reminder">
              客户消息发出后，在这里选择顾问的回复。
            </p>
          )}
        </section>
        <p className="review-reminder">
          模拟仅在当前页面会话中保留；刷新后重新开始。每次生成的输入和输出保存在历史记录中，不会发送微信。
        </p>
      </section>
    </div>
  );
}
