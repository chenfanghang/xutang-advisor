import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { Workbench } from "./Workbench";
import { HistoryPage } from "./HistoryPage";
import { TestingPage } from "./TestingPage";
import { SettingsPage } from "./SettingsPage";
import { generationApi } from "./api";
import type { Catalog } from "./api";

type Page = "workbench" | "history" | "settings" | "testing";
const pages = {
  testing: "在线测试",
  workbench: "话术工作台",
  history: "历史与评估",
  settings: "模型设置",
};
function currentPage(): Page {
  const hash = window.location.hash.slice(1);
  return hash === "settings" || hash === "history" || hash === "testing"
    ? hash
    : "workbench";
}

export function App() {
  const [page, setPage] = useState<Page>(currentPage);
  const [revision, setRevision] = useState(0);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    generationApi
      .catalog()
      .then((data) => {
        if (active) {
          setCatalog(data);
          setCatalogError("");
        }
      })
      .catch((reason: unknown) => {
        if (active)
          setCatalogError(
            reason instanceof Error ? reason.message : "产品资料读取失败。",
          );
      });
    return () => {
      active = false;
    };
  }, [catalogAttempt]);
  useEffect(() => {
    function navigate() {
      if (window.location.hash === "#main-content") return;
      setPage(currentPage());
      window.scrollTo(0, 0);
    }
    window.addEventListener("hashchange", navigate);
    return () => window.removeEventListener("hashchange", navigate);
  }, []);
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳转主要内容
      </a>
      <aside className="sidebar">
        <a className="brand" href="#workbench" aria-label="序棠顾问工作室首页">
          <span className="brand-mark" aria-hidden="true">
            <Icon name="message" />
          </span>
          <span>
            <strong>序棠</strong>
            <small>顾问工作室</small>
          </span>
        </a>
        <p className="nav-caption">工作空间</p>
        <nav aria-label="主导航">
          <a
            className={`nav-item ${page === "workbench" ? "active" : ""}`}
            href="#workbench"
            aria-current={page === "workbench" ? "page" : undefined}
          >
            <Icon name="message" />
            <span>话术工作台</span>
          </a>
          <a
            className={`nav-item ${page === "testing" ? "active" : ""}`}
            href="#testing"
            aria-current={page === "testing" ? "page" : undefined}
          >
            <Icon name="test" />
            <span>在线测试</span>
          </a>
          <a
            className={`nav-item ${page === "history" ? "active" : ""}`}
            href="#history"
            aria-current={page === "history" ? "page" : undefined}
          >
            <Icon name="history" />
            <span>历史与评估</span>
          </a>
          <a
            className={`nav-item ${page === "settings" ? "active" : ""}`}
            href="#settings"
            aria-current={page === "settings" ? "page" : undefined}
          >
            <Icon name="settings" />
            <span>模型设置</span>
          </a>
        </nav>
        <div className="sidebar-footer">
          <div className="workspace-avatar" aria-hidden="true">
            序
          </div>
          <div>
            <strong>本机工作空间</strong>
            <span>
              <i />
              本地模式
            </span>
          </div>
          <Icon name="lock" />
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <span className="breadcrumb">
            工作空间 <span>/</span>
            <strong>{pages[page]}</strong>
          </span>
          <span className="environment-badge">
            <span />
            虚构品牌演示
          </span>
        </header>
        <div id="main-content" tabIndex={-1}>
          <div hidden={page !== "workbench"}>
            <Workbench
              catalog={catalog}
              catalogError={catalogError}
              onRetry={() => setCatalogAttempt((value) => value + 1)}
              onCreated={() => setRevision((value) => value + 1)}
            />
          </div>
          <div hidden={page !== "history"}>
            <HistoryPage
              active={page === "history"}
              revision={revision}
              scenarios={catalog?.scenarios ?? []}
            />
          </div>
          <div hidden={page !== "testing"}>
            <TestingPage
              active={page === "testing"}
              catalog={catalog}
              catalogError={catalogError}
              onRetryCatalog={() => setCatalogAttempt((value) => value + 1)}
              onCreated={() => setRevision((value) => value + 1)}
            />
          </div>
          <div hidden={page !== "settings"}>
            <SettingsPage />
          </div>
        </div>
      </div>
    </div>
  );
}
