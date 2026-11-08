import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { settingsApi } from "./api";
import type { ConnectionResult, Settings } from "./api";
import { Icon } from "./Icon";

const presets = {
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-flash",
  },
  opencodeGo: {
    label: "OpenCode Go",
    baseUrl: "https://opencode.ai/inference/go/openai/v1",
    model: "glm-5.3-flash",
  },
};
type Preset = keyof typeof presets | "custom";
function presetFor(url: string): Preset {
  const normalized = url.trim().replace(/\/+$/, "");
  if (normalized === presets.deepseek.baseUrl) return "deepseek";
  if (normalized === presets.opencodeGo.baseUrl) return "opencodeGo";
  return "custom";
}

type TestState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "success"; result: ConnectionResult }
  | { status: "error"; message: string };

export function SettingsPage() {
  const [preset, setPreset] = useState<Preset>("custom");
  const [saved, setSaved] = useState<Settings | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [saveError, setSaveError] = useState("");
  const [test, setTest] = useState<TestState>({ status: "idle" });

  function retryLoad() {
    setLoading(true);
    setLoadError("");
    setLoadAttempt((attempt) => attempt + 1);
  }

  useEffect(() => {
    let active = true;
    settingsApi
      .get()
      .then((settings) => {
        if (!active) return;
        setSaved(settings);
        setBaseUrl(settings.base_url);
        setPreset(presetFor(settings.base_url));
        setModel(settings.model);
      })
      .catch((error: unknown) => {
        if (active)
          setLoadError(
            error instanceof Error ? error.message : "配置读取失败，请重试。",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loadAttempt]);

  const canReuseKey = Boolean(
    saved?.api_key_configured &&
    baseUrl.trim().replace(/\/+$/, "") === saved.base_url,
  );
  const busy = saving || test.status === "running";
  const dirty =
    saved !== null &&
    (baseUrl !== saved.base_url || model !== saved.model || apiKey.length > 0);

  function edited() {
    setTest({ status: "idle" });
    setSaveMessage("");
    setSaveError("");
  }

  function selectPreset(value: Preset) {
    setPreset(value);
    if (value !== "custom") {
      const next = presets[value];
      if (baseUrl.trim().replace(/\/+$/, "") !== next.baseUrl) {
        setApiKey("");
        setShowKey(false);
      }
      setBaseUrl(next.baseUrl);
      setModel(next.model);
    }
    edited();
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setSaveMessage("");
    setSaveError("");
    try {
      const result = await settingsApi.save({
        base_url: baseUrl,
        model,
        api_key: apiKey,
      });
      setSaved(result);
      setBaseUrl(result.base_url);
      setModel(result.model);
      setApiKey("");
      setShowKey(false);
      setSaveMessage("配置已保存，重启后仍可使用。");
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : "保存失败，请重试。",
      );
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    setTest({ status: "running" });
    try {
      const result = await settingsApi.test({
        base_url: baseUrl,
        model,
        api_key: apiKey,
      });
      setTest({ status: "success", result });
    } catch (error) {
      setTest({
        status: "error",
        message: error instanceof Error ? error.message : "测试失败，请重试。",
      });
    }
  }

  const statusText =
    test.status === "success"
      ? "连接已验证"
      : test.status === "running"
        ? "正在测试连接"
        : test.status === "error"
          ? "连接测试失败"
          : canReuseKey
            ? "待验证连接"
            : "等待配置密钥";

  return (
    <main id="settings" tabIndex={-1}>
      <div className="page-heading">
        <div>
          <h1>模型设置</h1>
          <p className="page-description">
            配置模型服务，供话术生成与在线测试使用。
          </p>
        </div>
        <span className="page-label">
          <Icon name="lock" />
          仅本机保存
        </span>
      </div>
      <div className="section-tabs">
        <span>模型服务</span>
      </div>
      {loadError ? (
        <div className="load-error" role="alert">
          <p>{loadError}</p>
          <button className="button secondary" onClick={retryLoad}>
            重新读取
          </button>
        </div>
      ) : (
        <div className="settings-grid">
          <section
            className="settings-card"
            aria-labelledby="settings-title"
            aria-busy={loading || saving}
          >
            <div className="card-heading">
              <div className="heading-icon">
                <Icon name="settings" />
              </div>
              <div>
                <h2 id="settings-title">服务配置</h2>
                <p>支持兼容 OpenAI 格式的模型服务。</p>
              </div>
              <span className="provider-tag">
                {preset === "custom" ? "自定义服务" : presets[preset].label}
              </span>
            </div>
            <form onSubmit={(event) => void save(event)}>
              <fieldset disabled={loading || busy}>
                <div className="field">
                  <label htmlFor="service-preset">服务预设</label>
                  <select
                    id="service-preset"
                    value={preset}
                    onChange={(event) =>
                      selectPreset(event.currentTarget.value as Preset)
                    }
                  >
                    <option value="deepseek">DeepSeek</option>
                    <option value="opencodeGo">OpenCode Go</option>
                    <option value="custom">自定义兼容服务</option>
                  </select>
                  <p>预设会填入服务地址和模型示例，API Key 请手动填写。</p>
                </div>
                {preset === "opencodeGo" && (
                  <div className="result-notice">
                    <Icon name="alert" />
                    <p>
                      Go 官方面向编码 Agent
                      流量，本工具是话术应用，请先确认套餐适用范围。
                      <a
                        href="https://opencode.ai/docs/console/go"
                        target="_blank"
                        rel="noreferrer"
                      >
                        查看官方说明
                      </a>
                    </p>
                  </div>
                )}
                <div className="field">
                  <label htmlFor="base-url">
                    服务地址 <span>必填</span>
                  </label>
                  <input
                    id="base-url"
                    type="url"
                    required
                    value={baseUrl}
                    placeholder={
                      loading ? "正在读取配置…" : "https://api.deepseek.com"
                    }
                    onChange={(event) => {
                      setBaseUrl(event.currentTarget.value);
                      setPreset(presetFor(event.currentTarget.value));
                      setApiKey("");
                      setShowKey(false);
                      edited();
                    }}
                    autoComplete="off"
                    spellCheck={false}
                    aria-describedby="base-url-help"
                  />
                  <p id="base-url-help">填写服务提供方的 API 基础地址。</p>
                </div>
                <div className="field">
                  <label htmlFor="model">
                    模型名称 <span>必填</span>
                  </label>
                  <input
                    id="model"
                    required
                    value={model}
                    placeholder="例如 deepseek-flash"
                    onChange={(event) => {
                      setModel(event.currentTarget.value);
                      edited();
                    }}
                    autoComplete="off"
                    spellCheck={false}
                    aria-describedby="model-help"
                  />
                  <p id="model-help">使用服务提供方支持的完整模型名称。</p>
                </div>
                <div className="field key-field">
                  <div className="label-row">
                    <label htmlFor="api-key">API Key</label>
                    {canReuseKey && (
                      <span className="key-badge">
                        <Icon name="check" />
                        已填写
                      </span>
                    )}
                  </div>
                  <div className="password-input">
                    <input
                      id="api-key"
                      type={showKey ? "text" : "password"}
                      value={apiKey}
                      placeholder={
                        canReuseKey
                          ? "已填写，留空即可继续使用；输入新密钥可替换"
                          : "输入你的 API Key"
                      }
                      onChange={(event) => {
                        setApiKey(event.currentTarget.value);
                        edited();
                      }}
                      autoComplete="off"
                      spellCheck={false}
                      aria-describedby="key-help"
                    />
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => setShowKey((value) => !value)}
                      aria-label={showKey ? "隐藏密钥" : "显示密钥"}
                      aria-pressed={showKey}
                    >
                      <Icon name="eye" />
                    </button>
                  </div>
                  <p id="key-help">
                    同一服务地址下留空沿用已有密钥；更换服务地址须填写对应密钥。
                  </p>
                </div>
                <div className="privacy-note">
                  <Icon name="lock" />
                  <p>密钥仅保存在本机，不包含在案例导出或报告中。</p>
                </div>
                <div className="form-footer">
                  <span className={`save-state ${dirty ? "unsaved" : ""}`}>
                    <span />
                    {loading
                      ? "正在读取配置"
                      : dirty
                        ? "有尚未保存的更改"
                        : "配置已同步"}
                  </span>
                  <button className="button primary" type="submit">
                    {saving ? "正在保存…" : "保存配置"}
                    <Icon name="check" />
                  </button>
                </div>
              </fieldset>
              <div className="save-feedback" aria-live="polite">
                {saveMessage && <p className="success-text">{saveMessage}</p>}
                {saveError && (
                  <p className="error-text" role="alert">
                    {saveError}
                  </p>
                )}
              </div>
            </form>
          </section>
          <div className="side-column">
            <section
              className="connection-card"
              aria-labelledby="connection-title"
              aria-busy={test.status === "running"}
            >
              <div className="connection-heading">
                <Icon name="connection" />
                <h2 id="connection-title">连接测试</h2>
              </div>
              <p className="connection-intro">
                验证当前配置是否能正常调用模型。
              </p>
              <div className={`connection-status ${test.status}`} role="status">
                <span className="status-ring">
                  <Icon
                    name={
                      test.status === "success"
                        ? "check"
                        : test.status === "error"
                          ? "alert"
                          : "connection"
                    }
                  />
                </span>
                <strong>{statusText}</strong>
                <p>
                  {test.status === "success"
                    ? `响应耗时 ${(test.result.latency_ms / 1000).toFixed(2)} 秒`
                    : test.status === "running"
                      ? "正在等待模型回复，最长约 60 秒"
                      : test.status === "error"
                        ? test.message
                        : canReuseKey
                          ? "密钥已保存，可以开始测试。"
                          : "填写 API Key 后即可测试连接。"}
                </p>
              </div>
              <dl className="connection-details">
                <div>
                  <dt>当前模型</dt>
                  <dd>{model || "尚未填写"}</dd>
                </div>
                <div>
                  <dt>配置状态</dt>
                  <dd>{dirty ? "尚未保存" : loading ? "读取中" : "已同步"}</dd>
                </div>
              </dl>
              <button
                className="button test-button"
                type="button"
                disabled={
                  loading ||
                  busy ||
                  !baseUrl.trim() ||
                  !model.trim() ||
                  (!apiKey.trim() && !canReuseKey)
                }
                onClick={() => void testConnection()}
              >
                {test.status === "running"
                  ? "正在测试…"
                  : test.status === "error"
                    ? "重新测试连接"
                    : "测试连接"}
                <Icon name="arrow" />
              </button>
              <p className="test-footnote">
                测试会调用 API，可能产生费用。
                <br />
                测试不会自动保存配置。
              </p>
            </section>
            <section className="usage-note" aria-labelledby="usage-title">
              <h2 id="usage-title">配置说明</h2>
              <ul>
                <li>单次生成与批量测试共用此配置。</li>
                <li>更换服务或模型后，请重新测试连接。</li>
                <li>测试通过后，点击“保存配置”保留设置。</li>
              </ul>
            </section>
          </div>
        </div>
      )}
      <footer className="page-footer">
        <span>序棠顾问工作室</span>
        <span>所有品牌与客户资料均为虚构</span>
      </footer>
    </main>
  );
}
