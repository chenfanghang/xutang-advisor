import { useState } from "react";
import type { RunRecord } from "./api";
import { Icon } from "./Icon";

export function CandidateList({ record }: { record: RunRecord }) {
  const [selected, setSelected] = useState<number | null>(null);
  const [feedback, setFeedback] = useState("");

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setFeedback("已复制到剪贴板。");
    } catch {
      setFeedback("复制失败，请手动选择消息文本复制。");
    }
  }

  return (
    <div className="candidate-list">
      {record.result.messages.map((text, index) => (
        <article
          className={`candidate-card ${selected === index ? "selected" : ""}`}
          key={index}
        >
          <div className="candidate-heading">
            <span>候选 {index + 1}</span>
            <div>
              <button
                type="button"
                className="text-button"
                aria-pressed={selected === index}
                onClick={() => setSelected(index)}
              >
                {selected === index ? "已选择" : `选择第 ${index + 1} 条`}
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => void copy(text)}
                aria-label={`复制第 ${index + 1} 条`}
              >
                <Icon name="copy" />
                复制
              </button>
            </div>
          </div>
          <p className="message-text">{text}</p>
        </article>
      ))}
      <p className="copy-feedback" aria-live="polite">
        {feedback}
      </p>
    </div>
  );
}
