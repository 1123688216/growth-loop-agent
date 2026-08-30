// 诊断题源探针：跨主题检查 Examiner 首题是真实 LLM 产出还是本地回退，并回读 agent_runs 定位回退原因。
//   npm.cmd run learning:probe -- --base=http://127.0.0.1:3000
import { DatabaseSync } from "node:sqlite";

const arg = (name, fallback) => process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const baseUrl = arg("base", "http://127.0.0.1:3000").replace(/\/$/, "");
const dbPath = arg("db", "data/growth-loop.sqlite");

const TOPICS = [
  { title: "人像摄影布光", description: "能独立完成一组棚拍人像，并说清每盏灯的作用。" },
  { title: "乐理与和声基础", description: "能分析一首流行歌的和弦进行，并自己写出一段八小节旋律。" },
  { title: "法语 A2 口语", description: "能就日常话题进行三分钟连贯对话，语法错误可被理解。" },
  { title: "中式家常菜火候控制", description: "能稳定复现五道家常菜，并解释火候对成品的影响。" },
  { title: "市场营销中的定价策略", description: "能为一个真实产品给出定价方案并说明依据。" },
  { title: "Rust 所有权与生命周期", description: "能读懂并修复借用检查报错，写出零拷贝的字符串处理函数。" },
];

// 本地回退题的固定骨架，用来识别「mode=llm 但正文其实是模板」的隐性回退。
const TEMPLATE_MARKERS = [
  "已知验收要求是",
  "请列出 3 个执行步骤和每一步的检查结果",
  "请写出具体数据、步骤或代码，并说明怎样判断结果正确",
];

let cookie = "";

async function call(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
  const session = (response.headers.getSetCookie?.() || []).find((v) => v.startsWith("growth_loop_session="));
  if (session) cookie = session.split(";")[0];
  const text = await response.text();
  if (!text) throw new Error(`${path} 返回空响应 HTTP ${response.status}`);
  const data = JSON.parse(text);
  if (!response.ok) throw new Error(data.error || `${path} HTTP ${response.status}`);
  return data;
}

const post = (path, payload) => call(path, { method: "POST", body: JSON.stringify(payload) });
const targetDate = new Date(Date.now() + 120 * 864e5).toISOString().slice(0, 10);
const username = `probe_${Date.now().toString(36)}`;

await post("/api/auth/register", { username, password: "topic-probe-1" });

const rows = [];
for (const topic of TOPICS) {
  try {
    const { goal } = await post("/api/goals", {
      title: topic.title,
      description: topic.description,
      targetDate,
      background: "有一点零散接触，但没有系统学过。",
      weeklyHours: 5,
      selfLevel: "familiar",
    });
    const { preparation } = await post("/api/learning-program", { action: "prepare", goalId: goal.id });
    const question = preparation?.diagnostic?.questions?.[0];
    const prompt = question?.prompt || "";
    const hint = question?.hint || "";
    rows.push({
      topic: topic.title,
      source: preparation?.diagnostic?.source ?? "?",
      templatePrompt: TEMPLATE_MARKERS.some((m) => prompt.includes(m)),
      templateHint: TEMPLATE_MARKERS.some((m) => hint.includes(m)),
      leaked: Boolean(question && ("referenceAnswer" in question || "rubric" in question)),
      prompt,
    });
  } catch (error) {
    rows.push({ topic: topic.title, source: "ERROR", error: error.message });
  }
}

console.log("\n主题级结果");
console.log("-".repeat(96));
for (const row of rows) {
  if (row.error) {
    console.log(`${row.topic.padEnd(22)} 失败：${row.error}`);
    continue;
  }
  const flags = [
    row.templatePrompt ? "题干=模板" : "题干=生成",
    row.templateHint ? "提示=模板" : "提示=生成",
    row.leaked ? "!!泄露参考答案" : "",
  ].filter(Boolean).join("  ");
  console.log(`${row.topic.padEnd(22)} source=${String(row.source).padEnd(6)} ${flags}`);
  console.log(`${" ".repeat(24)}${row.prompt.slice(0, 88)}`);
}

// agent_runs 记录了每次模型调用的 status 与耗时；耗时接近 60s 说明超时，很快失败通常是 HTTP 错误或 JSON 解析失败。
try {
  const database = new DatabaseSync(dbPath, { readOnly: true });
  const runs = database.prepare(`
    SELECT node_name, status, provider, latency_ms, total_tokens, error_message
    FROM agent_runs ORDER BY created_at DESC LIMIT ?
  `).all(TOPICS.length * 3);
  database.close();

  console.log("\n最近的模型调用（来自 agent_runs）");
  console.log("-".repeat(96));
  for (const run of runs) {
    console.log(
      `${String(run.status).padEnd(10)} ${String(run.latency_ms).padStart(6)}ms ` +
      `${String(run.total_tokens).padStart(5)}tok ${String(run.provider).padEnd(14)} ${run.node_name}` +
      (run.error_message ? `  <= ${run.error_message}` : ""),
    );
  }
  const fallbacks = runs.filter((r) => r.status === "fallback");
  const byReason = new Map();
  for (const run of fallbacks) byReason.set(run.error_message || "(未记录)", (byReason.get(run.error_message || "(未记录)") || 0) + 1);
  console.log(`\n回退 ${fallbacks.length}/${runs.length}`);
  for (const [reason, count] of byReason) console.log(`  ${count} 次  ${reason}`);

  const questionRuns = runs.filter((r) => r.node_name === "build_adaptive_initial_question" && r.status === "completed");
  if (questionRuns.length) {
    const latencies = questionRuns.map((r) => r.latency_ms).sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length / 2)];
    console.log(`\n出题成功调用耗时：中位 ${p50}ms，最慢 ${latencies[latencies.length - 1]}ms（超时闸门 60000ms）`);
  }
} catch (error) {
  console.log(`\n读取 ${dbPath} 失败（服务可能用了别的库）：${error.message}`);
}

console.log(`\n本次测试账号：${username}`);
