const endpoint = process.env.ANDROID_CDP_ENDPOINT || "http://127.0.0.1:9222";

if (typeof WebSocket === "undefined") {
  console.error(JSON.stringify({ ok: false, error: "当前 Node.js 没有 WebSocket 全局对象，请使用 Node.js 22+。" }, null, 2));
  process.exit(2);
}

const targets = await (await fetch(`${endpoint}/json`)).json();
const target = targets.find((item) => item.type === "page");
if (!target?.webSocketDebuggerUrl) {
  console.error(JSON.stringify({ ok: false, error: "没有找到可调试的 Android WebView page target。" }, null, 2));
  process.exit(3);
}

const socket = new WebSocket(target.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  const resolve = pending.get(message.id);
  if (resolve) {
    pending.delete(message.id);
    resolve(message);
  }
};
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});

function call(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.text || "Runtime.evaluate failed");
  return result.result?.result?.value;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await evaluate(`document.querySelectorAll('.app-mobile-v3-tabbar button')[0]?.click()`);
await wait(180);
const home = await evaluate(`(() => ({
  root: Boolean(document.querySelector('.app-mobile-v3')),
  viewport: [innerWidth, innerHeight],
  bodyWidth: document.body.scrollWidth,
  documentWidth: document.documentElement.scrollWidth,
  title: document.querySelector('.app-mobile-v4-presence strong')?.textContent || '',
  hasHomeV4: Boolean(document.querySelector('[data-mobile-home="v4"]')),
  hasNextMove: Boolean(document.querySelector('.app-mobile-v4-next')),
  hasAiComposer: Boolean(document.querySelector('.app-mobile-v4-composer textarea')),
  hasNightReport: Boolean(document.querySelector('.app-mobile-v4-review-link')),
  homeScrollFits: (() => { const node = document.querySelector('.app-mobile-v3-scroll.is-home'); return Boolean(node && node.scrollHeight <= node.clientHeight + 1); })(),
  tabs: [...document.querySelectorAll('.app-mobile-v3-tabbar button')].map((node) => node.textContent.trim())
}))()`);

await evaluate(`document.querySelectorAll('.app-mobile-v3-tabbar button')[1]?.click()`);
await wait(180);
const plan = await evaluate(`(() => ({
  active: [...document.querySelectorAll('.app-mobile-v3-tabbar button.is-active')].map((node) => node.textContent.trim()),
  hasGoal: Boolean(document.querySelector('.app-mobile-v3-goal-card')),
  routeSteps: document.querySelectorAll('.app-mobile-v3-route-step').length
}))()`);

await evaluate(`document.querySelectorAll('.app-mobile-v3-tabbar button')[2]?.click()`);
await wait(180);
const records = await evaluate(`(() => ({
  active: [...document.querySelectorAll('.app-mobile-v3-tabbar button.is-active')].map((node) => node.textContent.trim()),
  hasCapture: Boolean(document.querySelector('.app-mobile-v3-capture-cta')),
  timelineItems: document.querySelectorAll('.app-mobile-v3-timeline-item').length
}))()`);

await evaluate(`document.querySelector('.app-mobile-v3-fab')?.click()`);
await wait(180);
const composer = await evaluate(`(() => ({
  open: Boolean(document.querySelector('.app-mobile-v3-sheet')),
  textareas: document.querySelectorAll('.app-mobile-v3-sheet textarea').length
}))()`);
await evaluate(`document.querySelector('.app-mobile-v3-sheet-backdrop')?.click()`);

await evaluate(`document.querySelectorAll('.app-mobile-v3-tabbar button')[3]?.click()`);
await wait(180);
const growth = await evaluate(`(() => ({
  active: [...document.querySelectorAll('.app-mobile-v3-tabbar button.is-active')].map((node) => node.textContent.trim()),
  hasRhythm: Boolean(document.querySelector('.app-mobile-v3-rhythm-card')),
  statCards: document.querySelectorAll('.app-mobile-v3-stat-grid > div').length,
  weekBars: document.querySelectorAll('.app-mobile-v3-week-bar').length
}))()`);

const result = { ok: home.root && home.hasHomeV4 && home.hasNextMove && home.hasAiComposer && home.hasNightReport && home.homeScrollFits && home.tabs.length === 4 && home.bodyWidth === home.viewport[0] && home.documentWidth === home.viewport[0] && composer.open && composer.textareas === 1 && plan.hasGoal && plan.routeSteps === 3 && records.hasCapture && growth.hasRhythm, target: target.url, home, plan, records, composer, growth };
console.log(JSON.stringify(result, null, 2));
socket.close();
if (!result.ok) process.exit(4);
