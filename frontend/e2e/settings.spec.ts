import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

let server: Server;
let modelUrl: string;

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    if (input.model === "batch-ui-slow" && input.response_format) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    let generated = input.response_format
      ? JSON.stringify({
          messages:
            input.model === "bad-output" ||
            (input.model === "batch-ui-mixed" &&
              JSON.stringify(input.messages).includes("首次到店后留下生日信息"))
              ? ["只有一条候选"]
              : [
                  "您好，您偏爱轻便款式，轻舟斜挎包可供您参考。",
                  "您好，结合日常出行需求，想请您看看轻舟斜挎包。",
                  "您好，若您方便，我们可以先聊聊您对随身包容量的期待。",
                ],
        })
      : "连接正常";
    if (input.model === "judge-pass") {
      generated = JSON.stringify({
        candidates: [1, 2, 3].map((index) => ({
          index,
          scores: { personalization: 5, brand: 5, scenario: 5, naturalness: 5 },
          independent: true,
          needs_review: false,
          reason: "模拟评审用于界面验证，不作为质量结论。",
          violations: [],
        })),
        diversity: 5,
        diversity_needs_review: false,
        diversity_reason: "模拟差异判断。",
      });
    }
    const authenticated =
      request.headers.authorization === "Bearer fictional-e2e-key";
    response.setHeader("Content-Type", "application/json");
    response.statusCode = authenticated ? 200 : 401;
    response.end(
      JSON.stringify(
        authenticated
          ? {
              id: "e2e",
              object: "chat.completion",
              created: 1,
              model: "fixture-model",
              choices: [
                {
                  index: 0,
                  finish_reason: "stop",
                  message: { role: "assistant", content: generated },
                },
              ],
            }
          : { error: { message: "invalid key", type: "authentication_error" } },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  modelUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test("顾问可测试当前配置、保存并重载，且错误后可继续修改", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/#settings");
  await expect(page.getByLabel("服务地址")).toHaveValue(
    "https://api.deepseek.com",
  );
  await expect(
    page.getByRole("button", { name: "测试连接", exact: true }),
  ).toBeDisabled();

  await page.screenshot({
    path: testInfo.outputPath("settings-desktop.png"),
    fullPage: true,
  });
  await page.getByLabel("服务地址").fill(modelUrl);
  await page.getByLabel("模型名称").fill("fixture-model");
  await page.getByLabel("API Key", { exact: true }).fill("fictional-e2e-key");
  await expect(page.getByLabel("API Key", { exact: true })).toHaveAttribute(
    "type",
    "password",
  );
  await page.getByRole("button", { name: "显示密钥", exact: true }).click();
  await expect(page.getByLabel("API Key", { exact: true })).toHaveAttribute(
    "type",
    "text",
  );
  await page.getByRole("button", { name: "隐藏密钥", exact: true }).click();
  await page.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("连接已验证");
  await expect(page.getByText("有尚未保存的更改")).toBeVisible();

  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(page.getByText("配置已保存，重启后仍可使用。")).toBeVisible();
  await expect(page.getByLabel("API Key", { exact: true })).toHaveValue("");
  await expect(page.getByText("已填写", { exact: true })).toBeVisible();
  await expect(page.getByLabel("API Key", { exact: true })).toHaveAttribute(
    "placeholder",
    "已填写，留空即可继续使用；输入新密钥可替换",
  );
  await page.reload();
  await expect(page.getByLabel("服务地址")).toHaveValue(modelUrl);
  await expect(page.getByText("已填写", { exact: true })).toBeVisible();
  await expect(page.getByLabel("API Key", { exact: true })).toHaveAttribute(
    "placeholder",
    "已填写，留空即可继续使用；输入新密钥可替换",
  );
  await page.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("连接已验证");

  await page.getByLabel("API Key", { exact: true }).fill("wrong-fictional-key");
  await expect(page.getByRole("status")).not.toContainText("连接已验证");
  await page.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("认证失败");
  await expect(page.getByLabel("API Key", { exact: true })).toHaveValue(
    "wrong-fictional-key",
  );
  await page.getByLabel("API Key", { exact: true }).fill("");

  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload();
  await expect(page.getByLabel("服务地址")).toHaveValue(modelUrl);
  const activeNavigation = page.getByRole("link", {
    name: "模型设置",
    exact: true,
  });
  const navigationBox = await activeNavigation.boundingBox();
  expect(navigationBox).not.toBeNull();
  expect(navigationBox!.x + navigationBox!.width).toBeLessThanOrEqual(375);
  await expect(
    page.getByRole("button", { name: "保存配置", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("settings-mobile.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("在线测试可编辑副本、运行50例并查看失败，刷新后结果保留", async ({
  page,
  request,
}, testInfo) => {
  await request.put("/api/settings", {
    data: {
      base_url: modelUrl,
      model: "fixture-model",
      api_key: "fictional-e2e-key",
    },
  });
  const original = (await (await request.get("/api/test-cases")).json())
    .cases[0].input.client_information;
  await page.goto("/#testing");
  const main = page.getByRole("main");
  await expect(main.getByLabel("选择固定案例")).toHaveValue("CASE-001");
  await main
    .getByLabel("客户信息")
    .fill("单例编辑内容（虚构），希望简短祝福。");
  await main.getByRole("button", { name: "生成三条话术", exact: true }).click();
  await expect(main.getByRole("article")).toHaveCount(3);
  const singleRecord = (
    await (await request.get("/api/history?limit=1")).json()
  )[0];
  expect(singleRecord.input.client_information).toBe(
    "单例编辑内容（虚构），希望简短祝福。",
  );
  const unchanged = (await (await request.get("/api/test-cases")).json())
    .cases[0].input.client_information;
  expect(unchanged).toBe(original);
  await request.put("/api/settings", {
    data: {
      base_url: modelUrl,
      model: "batch-ui-mixed",
      api_key: "fictional-e2e-key",
    },
  });
  await page.getByRole("tab", { name: "单例测试", exact: true }).focus();
  await page.keyboard.press("End");
  await expect(
    page.getByRole("tab", { name: "批量测试", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("button", { name: "运行固定 50 例", exact: true })
    .click();
  await expect(main.getByRole("status")).toContainText(
    "已完成 50 / 50 · 失败 1 例",
    { timeout: 15000 },
  );
  await main.getByRole("button", { name: "CASE-002", exact: true }).click();
  await expect(
    main.getByText("模型未返回三条独立的中文候选，请重试或调整模型。", {
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("batch-failure.png"),
    fullPage: true,
  });
  await main.getByRole("button", { name: "CASE-001", exact: true }).click();
  await expect(main.getByRole("article")).toHaveCount(3);
  await main.getByRole("button", { name: "CASE-001", exact: true }).click();
  await expect(main.getByRole("article")).toHaveCount(3);
  await page.reload();
  await page.getByRole("tab", { name: "批量测试", exact: true }).click();
  await expect(page.getByRole("main").getByRole("status")).toContainText(
    "已完成 50 / 50 · 失败 1 例",
  );
  await page.screenshot({
    path: testInfo.outputPath("batch-completed.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("batch-mobile.png"),
    fullPage: true,
  });
  const oldBatchId = (await (await request.get("/api/batches")).json())[0].id;
  await request.put("/api/settings", {
    data: {
      base_url: modelUrl,
      model: "batch-ui-slow",
      api_key: "fictional-e2e-key",
    },
  });
  await page
    .getByRole("button", { name: "运行固定 50 例", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "批次运行中", exact: true }),
  ).toBeVisible();
  await page.getByLabel("查看批次").selectOption(oldBatchId);
  await expect(
    page.getByRole("button", { name: "运行固定 50 例", exact: true }),
  ).toBeEnabled({ timeout: 15000 });
});

test("顾问可生成、选择复制并从历史追溯，失败后输入仍保留", async ({
  page,
  request,
  context,
}, testInfo) => {
  await request.put("/api/settings", {
    data: {
      base_url: modelUrl,
      model: "fixture-model",
      api_key: "fictional-e2e-key",
    },
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "填入虚构示例" }).click();
  const original = await page.getByLabel("客户信息").inputValue();
  await page.getByRole("link", { name: "模型设置", exact: true }).click();
  await page.getByRole("link", { name: "话术工作台", exact: true }).click();
  await expect(page.getByLabel("客户信息")).toHaveValue(original);
  await page.getByRole("button", { name: "生成三条话术", exact: true }).click();
  await expect(page.getByRole("article")).toHaveCount(3);
  await page.getByRole("button", { name: "选择第 1 条", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "已选择", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "复制第 1 条", exact: true }).click();
  await expect(
    page.getByText("已复制到剪贴板。", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "轻舟斜挎包",
  );
  await page.getByRole("heading", { name: "话术工作台", exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath("workbench-generated.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: "历史与评估", exact: true }).click();
  await page.getByText("查看当次输入与产品快照", { exact: true }).click();
  await expect(
    page.getByRole("definition").filter({ hasText: "林女士" }),
  ).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(3);
  await page.screenshot({
    path: testInfo.outputPath("history-snapshot.png"),
    fullPage: true,
  });
  await request.put("/api/settings", {
    data: {
      base_url: modelUrl,
      model: "bad-output",
      api_key: "fictional-e2e-key",
    },
  });
  await page.getByRole("link", { name: "话术工作台", exact: true }).click();
  await page.getByRole("button", { name: "生成三条话术", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("三条独立的中文候选");
  await expect(page.getByLabel("客户信息")).toHaveValue(original);
  await page.getByLabel("联系意愿").selectOption("do_not_contact");
  await page.getByRole("button", { name: "确认停止联系", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "建议不联系", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(0);
  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("workbench-mobile.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("可选择OpenCode Go预设，切换服务不会沿用原密钥", async ({
  page,
}, testInfo) => {
  await page.goto("/#settings");
  await expect(page.getByLabel("服务预设")).toBeEnabled();
  await page
    .getByLabel("API Key", { exact: true })
    .fill("fictional-unsaved-key");
  await page.getByLabel("服务预设").selectOption("opencodeGo");
  await expect(page.getByLabel("服务地址")).toHaveValue(
    "https://opencode.ai/inference/go/openai/v1",
  );
  await expect(page.getByLabel("模型名称")).toHaveValue("glm-5.3-flash");
  await expect(page.getByLabel("API Key", { exact: true })).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "测试连接", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText("查看官方说明", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(page.getByText("配置已保存，重启后仍可使用。")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("服务预设")).toHaveValue("opencodeGo");
  await expect(
    page.getByRole("button", { name: "测试连接", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath("opencode-go-preset.png"),
    fullPage: true,
  });
});

test("评估分别保存来源，支持筛选、同输入对比和Excel下载", async ({
  page,
  request,
}, testInfo) => {
  await request.put("/api/settings", {
    data: {
      base_url: modelUrl,
      model: "fixture-model",
      api_key: "fictional-e2e-key",
    },
  });
  const input = {
    scenario: "event_invitation",
    client_information: "评估用虚构客户，偏好小型活动。",
    scenario_information: "仅询问参与意向，不提供未确认的活动安排。",
  };
  const firstResponse = await request.post("/api/generate", { data: input });
  expect(firstResponse.ok()).toBeTruthy();
  const first = await firstResponse.json();
  const secondResponse = await request.post("/api/generate", { data: input });
  expect(secondResponse.ok()).toBeTruthy();
  await page.goto("/#history");
  await page.getByLabel("筛选场景").selectOption("event_invitation");
  await expect(
    page.getByRole("region", { name: "话术质量评估" }),
  ).toBeVisible();
  await page.getByLabel("候选 1 判断").selectOption("pass");
  await page.getByLabel("候选 2 判断").selectOption("fail");
  await page.getByLabel("候选 2 原因").fill("未回应参与意向，表达过于笼统。");
  await page
    .getByLabel("评价备注")
    .fill("端到端测试录入，不作为正式人工质量结论。");
  await page.getByRole("button", { name: "保存人工复核", exact: true }).click();
  await expect(
    page.getByText("人工复核已保存。", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "人工复核统计", exact: true }),
  ).toContainText("已评 2 条");
  await expect(
    page.getByRole("region", { name: "AI 初评统计", exact: true }),
  ).toContainText("已评 0 条");
  await page.reload();
  await page.getByLabel("筛选场景").selectOption("event_invitation");
  await expect(page.getByLabel("候选 2 原因")).toHaveValue(
    "未回应参与意向，表达过于笼统。",
  );
  await expect(page.getByLabel("候选 3 判断")).toHaveValue("");
  await page.getByLabel("评价来源").selectOption("ai");
  await expect(page.getByLabel("候选 1 判断")).toHaveValue("");
  for (let i = 1; i <= 3; i++)
    await page.getByLabel(`候选 ${i} 判断`).selectOption("pass");
  await page.getByLabel("候选切入点差异").selectOption("pass");
  await page.getByRole("button", { name: "保存AI 初评", exact: true }).click();
  await expect(
    page.getByText("AI 初评已保存。", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "AI 初评统计", exact: true }),
  ).toContainText("已评 3 条");
  await page.getByLabel("评价来源").selectOption("human");
  await expect(page.getByLabel("候选 2 判断")).toHaveValue("fail");
  await page.getByText("同输入结果对比", { exact: true }).click();
  await page.getByLabel("对比记录").selectOption(first.id);
  await expect(
    page.getByRole("region", { name: "当前结果", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "对照结果", exact: true }),
  ).toContainText(first.result.messages[0]);
  await page.getByLabel("筛选版本").selectOption(first.prompt_version);
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "导出筛选结果 Excel", exact: true })
    .click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("xutang-cases.xlsx");
  expect(await download.failure()).toBeNull();
  await download.saveAs(testInfo.outputPath("evaluation-export.xlsx"));
  await page.screenshot({
    path: testInfo.outputPath("evaluation-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("evaluation-mobile.png"),
    fullPage: true,
  });
});

test("DeepEval可评审筛选记录、查看独立证据并导出，刷新保留实验", async ({
  page,
  request,
}, testInfo) => {
  await request.put("/api/settings", {
    data: {
      base_url: modelUrl,
      model: "fixture-model",
      api_key: "fictional-e2e-key",
    },
  });
  const generated = await request.post("/api/generate", {
    data: {
      scenario: "greeting",
      client_information: "虚构自动评审测试客户，刚拒联。",
      contact_status: "just_refused",
    },
  });
  expect(generated.ok()).toBeTruthy();
  await page.goto("/#history");
  await page.getByLabel("筛选场景").selectOption("greeting");
  const panel = page.getByRole("region", {
    name: "DeepEval 自动评测",
    exact: true,
  });
  await panel.getByLabel("评审模型").fill("judge-pass");
  await page.route("**/api/judge-experiments", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({ detail: "模拟评审配置错误" }),
      });
    } else {
      await route.continue();
    }
  });
  await panel.getByRole("button", { name: /运行 DeepEval/ }).click();
  await expect(panel.getByRole("alert")).toContainText("模拟评审配置错误");
  await page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/judge-experiments") &&
      response.request().method() === "GET",
  );
  await expect(panel.getByRole("alert")).toContainText("模拟评审配置错误");
  await page.unroute("**/api/judge-experiments");
  await panel.getByRole("button", { name: /运行 DeepEval/ }).click();
  await expect(panel.locator(".program-summary")).toContainText("已完成", {
    timeout: 20000,
  });
  await expect(panel.getByLabel("自动评测统计")).toContainText("评审失败 0 次");
  await expect(panel.getByText("候选 1 · 合格", { exact: true })).toBeVisible();
  await expect(
    panel.getByText("未完成人工校准", { exact: true }),
  ).toBeVisible();
  const experimentId = await panel.getByLabel("自动评测实验").inputValue();
  await page.reload();
  await expect(panel.getByLabel("自动评测实验")).toHaveValue(experimentId);
  await panel.getByText("查看评测准则与请求原文", { exact: true }).click();
  await expect(panel.locator("pre")).toContainText('"test_results"');
  const downloadPromise = page.waitForEvent("download");
  await panel
    .getByRole("button", { name: "导出 DeepEval 实验", exact: true })
    .click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("xutang-deepeval.xlsx");
  expect(await download.failure()).toBeNull();
  await panel.getByText("查看评测准则与请求原文", { exact: true }).click();
  await panel.screenshot({ path: testInfo.outputPath("deepeval-desktop.png") });
  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await panel.screenshot({ path: testInfo.outputPath("deepeval-mobile.png") });
});

test("场景模拟由用户扮演客户，选择候选后连续对话并保留上下文", async ({
  page,
  request,
}) => {
  await request.put("/api/settings", {
    data: {
      base_url: modelUrl,
      model: "fixture-model",
      api_key: "fictional-e2e-key",
    },
  });
  await page.goto("/#testing");
  await page.getByRole("tab", { name: "场景模拟" }).click();
  await page.getByLabel("模拟对象资料").fill("虚构客户，预算七千元。");
  await page
    .getByRole("region", { name: "模拟场景资料" })
    .getByLabel("轻舟斜挎包", { exact: false })
    .check();
  await page.getByLabel("模拟客户消息").fill("我想找一只通勤包，预算七千元。");
  await request.put("/api/settings", {
    data: {
      base_url: modelUrl,
      model: "bad-output",
      api_key: "fictional-e2e-key",
    },
  });
  await page.getByRole("button", { name: "发送客户消息并生成" }).click();
  await expect(page.getByRole("alert")).toContainText("三条独立的中文候选");
  await expect(page.getByRole("log", { name: "模拟对话记录" })).toContainText(
    "我想找一只通勤包，预算七千元。",
  );
  await request.put("/api/settings", {
    data: {
      base_url: modelUrl,
      model: "fixture-model",
      api_key: "fictional-e2e-key",
    },
  });
  await page.getByRole("button", { name: "重试生成候选" }).click();
  await expect(
    page.getByRole("region", { name: "模拟候选话术" }).getByRole("article"),
  ).toHaveCount(3);
  await page.getByRole("button", { name: "采用第 2 条" }).click();
  await expect(page.getByRole("log", { name: "模拟对话记录" })).toContainText(
    "我想找一只通勤包，预算七千元。",
  );
  await expect(page.getByRole("log", { name: "模拟对话记录" })).toContainText(
    "结合日常出行需求",
  );
  await page.getByLabel("模拟客户消息").fill("还有别的颜色吗？");
  await page.getByRole("button", { name: "发送客户消息并生成" }).click();
  await expect(
    page.getByRole("region", { name: "模拟候选话术" }).getByRole("article"),
  ).toHaveCount(3);
  const history = await request.get("/api/history");
  const record = (await history.json())[0];
  expect(record.input.conversation_history).toContain(
    "顾问：您好，结合日常出行需求",
  );
  expect(record.input.conversation_history).toContain("客户：还有别的颜色吗？");
  expect(record.input.client_information).toBe("虚构客户，预算七千元。");
  expect(record.input.product_ids).toContain("light-crossbody");
  await page.getByRole("link", { name: "模型设置", exact: true }).click();
  await page.getByRole("link", { name: "在线测试", exact: true }).click();
  await expect(page.getByRole("log", { name: "模拟对话记录" })).toContainText(
    "还有别的颜色吗？",
  );
  await page.getByRole("button", { name: "采用第 1 条" }).click();
  await page.getByLabel("模拟联系意愿").selectOption("just_refused");
  await page.getByLabel("模拟客户消息").fill("请不要再联系我。");
  await page.getByRole("button", { name: "发送客户消息并生成" }).click();
  await expect(
    page.getByText("规则生成 · 未调用模型", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "采用第 1 条" }).click();
  await expect(
    page.getByText("客户已拒绝联系，模拟会话已结束。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("模拟客户消息")).toBeDisabled();
});
