export type Settings = {
  base_url: string;
  model: string;
  api_key_configured: boolean;
};

export type SettingsInput = {
  base_url: string;
  model: string;
  api_key: string;
};

export type ConnectionResult = {
  ok: boolean;
  message: string;
  latency_ms: number;
};

export async function request<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, options);
  } catch {
    throw new Error("无法连接本机服务，请确认后端正在运行后重试。");
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      typeof body?.detail === "string"
        ? body.detail
        : `请求未完成（${response.status}），请稍后重试。`,
    );
  }
  if (body === null) {
    throw new Error("服务未返回有效数据，请确认后端地址后重试。");
  }
  return body as T;
}

function jsonBody(method: string, input: object): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  };
}

export const settingsApi = {
  get: () => request<Settings>("/api/settings"),
  save: (input: SettingsInput) =>
    request<Settings>("/api/settings", jsonBody("PUT", input)),
  test: (input: SettingsInput) =>
    request<ConnectionResult>("/api/settings/test", jsonBody("POST", input)),
};

export type ScenarioId =
  | "greeting"
  | "recommendation"
  | "post_purchase"
  | "reactivation"
  | "event_invitation"
  | "price_objection";
export type ContactStatus = "active" | "just_refused" | "do_not_contact";
export type Product = {
  id: string;
  name: string;
  price: number;
  material: string;
  dimensions: string;
  colors: string[];
  weight: string;
  usage: string;
  care: string;
};
export type Scenario = { id: ScenarioId; label: string; instruction: string };
export type Catalog = { products: Product[]; scenarios: Scenario[] };
export type GenerationInput = {
  scenario: ScenarioId;
  client_information: string;
  conversation_history: string;
  scenario_information: string;
  product_ids: string[];
  contact_status: ContactStatus;
};
export type RunRecord = {
  id: string;
  created_at: string;
  input: GenerationInput;
  products: Product[];
  brand_rules: string;
  scenario_instruction: string;
  prompt_version: string;
  model: string | null;
  base_url: string | null;
  raw_output: string;
  result: {
    status: "generated" | "stopped" | "failed";
    messages: string[];
    warnings: string[];
    source: "model" | "rule" | "none";
    error: string | null;
  };
};
export const generationApi = {
  catalog: () => request<Catalog>("/api/catalog"),
  generate: (input: GenerationInput) =>
    request<RunRecord>("/api/generate", jsonBody("POST", input)),
  history: () => request<RunRecord[]>("/api/history"),
  record: (id: string) =>
    request<RunRecord>(`/api/history/${encodeURIComponent(id)}`),
};

export type TestCase = {
  id: string;
  title: string;
  focus: string;
  input: GenerationInput;
};
export type BatchItem = {
  case_id: string;
  run_id: string;
  status: RunRecord["result"]["status"];
  error: string | null;
};
export type BatchRun = {
  id: string;
  created_at: string;
  status: "running" | "completed" | "interrupted" | "failed";
  cases_version: string;
  cases: TestCase[];
  model: string;
  base_url: string;
  prompt_version: string;
  items: BatchItem[];
  brand_rules: string;
  error: string | null;
};
export const testingApi = {
  cases: () =>
    request<{ version: string; cases: TestCase[] }>("/api/test-cases"),
  batches: () => request<BatchRun[]>("/api/batches"),
  start: () => request<BatchRun>("/api/batches", { method: "POST" }),
  batch: (id: string) =>
    request<BatchRun>(`/api/batches/${encodeURIComponent(id)}`),
};

export type ReviewSource = "human" | "ai";
export type CandidateReview = { passed: boolean | null; reason: string };
export type EvaluationInput = {
  source: ReviewSource;
  candidates: CandidateReview[];
  distinct: boolean | null;
  distinct_reason: string;
  notes: string;
};
export type Evaluation = EvaluationInput & {
  run_id: string;
  updated_at: string;
};
export type QualitySummary = {
  total_messages: number;
  reviewed_messages: number;
  unreviewed_messages: number;
  passed_messages: number;
  usable_cases: number;
  qualified_groups: number;
  fully_reviewed_cases: number;
};
export type EvaluationView = {
  records: RunRecord[];
  evaluations: Evaluation[];
  versions: string[];
  summary: {
    total: number;
    generated: number;
    stopped: number;
    failed: number;
    human: QualitySummary;
    ai: QualitySummary;
  };
};
export type HistoryFilters = {
  scenario: string;
  version: string;
  batch_id: string;
};
export function historyQuery(filters: HistoryFilters): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters))
    if (value) query.set(key, value);
  return query.toString();
}
export const evaluationApi = {
  list: (filters: HistoryFilters) =>
    request<EvaluationView>(`/api/evaluation?${historyQuery(filters)}`),
  save: (id: string, input: EvaluationInput) =>
    request<Evaluation>(
      `/api/history/${encodeURIComponent(id)}/evaluation`,
      jsonBody("PUT", input),
    ),
  comparisons: (id: string) =>
    request<RunRecord[]>(`/api/history/${encodeURIComponent(id)}/comparisons`),
};

export type JudgeCandidate = {
  passed: boolean | null;
  index: number;
  scores: {
    personalization: number | null;
    brand: number;
    scenario: number;
    naturalness: number;
  };
  independent: boolean;
  needs_review: boolean;
  reason: string;
  violations: { kind: string; quote: string; reason: string; basis: string }[];
};
export type JudgeItem = {
  run_id: string;
  trial: number;
  status: "reviewed" | "error" | "skipped" | "rule_failed";
  rules: { name: string; passed: boolean; detail: string }[];
  verdict: {
    candidates: JudgeCandidate[];
    diversity: number;
    diversity_needs_review: boolean;
    diversity_reason: string;
  } | null;
  raw_output: string;
  judge_input: string;
  framework_result: object;
  error: string | null;
};
export type JudgeHeader = {
  id: string;
  created_at: string;
  status: "running" | "completed" | "interrupted" | "failed";
  judge_model: string;
  total: number;
  completed: number;
};
export type JudgeExperiment = {
  id: string;
  created_at: string;
  finished_at: string | null;
  status: JudgeHeader["status"];
  run_ids: string[];
  judge_model: string;
  base_url: string;
  repetitions: number;
  rubric_version: string;
  rubric: string;
  framework_version: string;
  request_timeout_seconds: number;
  calibrated: boolean;
  items: JudgeItem[];
  error: string | null;
};
export type JudgeSummary = {
  by_version: Record<
    string,
    {
      total_cases: number;
      total_messages: number;
      passed_messages: number;
      usable_cases: number;
      qualified_groups: number;
    }
  >;
  human_compared_messages: number;
  human_agreements: number;
  false_acceptances: number;
  false_rejections: number;
  total_cases: number;
  total_messages: number;
  reviewed_cases: number;
  reviewed_messages: number;
  passed_messages: number;
  failed_messages: number;
  pending_messages: number;
  unreviewed_messages: number;
  usable_cases: number;
  qualified_groups: number;
  evaluation_errors: number;
  rule_failures: number;
  skipped: number;
  repeated_cases: number;
  consistent_cases: number;
  calibrated: boolean;
};
export const judgeApi = {
  list: () => request<JudgeHeader[]>("/api/judge-experiments"),
  get: (id: string) =>
    request<JudgeExperiment>(
      `/api/judge-experiments/${encodeURIComponent(id)}`,
    ),
  summary: (id: string) =>
    request<JudgeSummary>(
      `/api/judge-experiments/${encodeURIComponent(id)}/summary`,
    ),
  start: (input: {
    run_ids: string[];
    judge_model: string;
    repetitions: number;
  }) =>
    request<JudgeExperiment>("/api/judge-experiments", jsonBody("POST", input)),
};

export async function downloadExcel(
  url: string,
  filename: string,
): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("导出失败，请重试或检查本机服务。");
  const objectUrl = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(objectUrl);
}
