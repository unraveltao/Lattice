import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { classify, Kind, Blocked, Budget, CircuitBreaker, guardedCall, parseRetryAfter } from "../src/llm-guard.mjs";

// 真实 HTTP 服务器扮演网关：按脚本依次返回状态，记录收到的请求数。
let server, base;
let script = [];
let hits = 0;
before(async () => {
  server = http.createServer((req, res) => {
    hits++;
    const step = script.shift() ?? { status: 200, body: { ok: true } };
    res.writeHead(step.status, { "content-type": "application/json", ...(step.headers ?? {}) });
    res.end(typeof step.body === "string" ? step.body : JSON.stringify(step.body ?? {}));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const reset = (s) => ((script = [...s]), (hits = 0));

/** 对真实服务器发请求；返回 guardedCall 需要的 {status, headers, body} */
const doFetch = async () => {
  const r = await fetch(`${base}/v1/messages`, { method: "POST", body: "{}" });
  return { status: r.status, headers: Object.fromEntries(r.headers), body: await r.text(), cost: 0.01 };
};
const NO_ACCT = { status: 503, body: { error: { message: "no eligible upstream account is currently available" } } };
const noSleep = async () => {};

test("M1. 503 账号池耗尽：不密集重试——只发 1 次请求，抛 Blocked(NO_ACCOUNT)，与事故里的 5 连发相反", async () => {
  reset([NO_ACCT, NO_ACCT, NO_ACCT, NO_ACCT, NO_ACCT]);
  const events = [];
  await assert.rejects(
    guardedCall({ call: doFetch, budget: new Budget({ maxCalls: 10 }), sleep: noSleep, onEvent: (e) => events.push(e) }),
    (e) => e instanceof Blocked && e.reason === "NO_ACCOUNT" && /no eligible upstream account/.test(e.message),
  );
  assert.equal(hits, 1, "不应对账号池耗尽反复敲门");
  assert.ok(!events.some((e) => e.type === "wait"), "没有退避重试");
});

test("M2. 429 遵守 Retry-After：等待时长取自响应头，之后成功", async () => {
  reset([{ status: 429, headers: { "retry-after": "2" }, body: "slow down" }, { status: 200, body: { ok: 1 } }]);
  const waits = [];
  const res = await guardedCall({ call: doFetch, budget: new Budget(), sleep: async (ms) => waits.push(ms) });
  assert.equal(res.status, 200);
  assert.deepEqual(waits, [2000]);
  assert.equal(hits, 2);
  assert.equal(parseRetryAfter("0"), 0);
  assert.ok(parseRetryAfter(new Date(Date.now() + 5000).toUTCString()) > 3000);
});

test("M3. 500/502 有限指数退避：最多 maxAttempts 次，退避间隔递增，最终 Blocked(RETRIES_EXHAUSTED)", async () => {
  reset([{ status: 500, body: "e" }, { status: 502, body: "e" }, { status: 500, body: "e" }, { status: 200 }]);
  const waits = [];
  await assert.rejects(guardedCall({ call: doFetch, budget: new Budget(), retry: { maxAttempts: 3, base: 1000 }, sleep: async (m) => waits.push(m), random: () => 0.5 }), (e) => e.reason === "RETRIES_EXHAUSTED");
  assert.equal(hits, 3, "第 4 个脚本响应（200）没被用到：不会无限重试");
  assert.deepEqual(waits, [1000, 2000]);
});

test("M4. 400 / 401 / 403 不重试，原因分别是 BAD_REQUEST / AUTH", async () => {
  for (const [status, reason] of [[400, "BAD_REQUEST"], [401, "AUTH"], [403, "AUTH"]]) {
    reset([{ status, body: "nope" }, { status: 200 }]);
    await assert.rejects(guardedCall({ call: doFetch, budget: new Budget(), sleep: noSleep }), (e) => e.reason === reason);
    assert.equal(hits, 1, `${status} 只发一次`);
  }
});

test("M5. 网络超时/连接重置按瞬时错误有限重试；错误信息里不含请求头与密钥", async () => {
  let n = 0;
  const secret = "sk-SECRET-123";
  const call = async () => {
    n++;
    if (n < 3) {
      const e = new Error(`connect ECONNRESET (Authorization: Bearer ${secret})`);
      e.code = "ECONNRESET";
      throw e;
    }
    return { status: 200, body: "ok" };
  };
  const res = await guardedCall({ call, budget: new Budget(), sleep: noSleep });
  assert.equal(res.status, 200);
  assert.equal(n, 3);
  const c = classify({ status: 0, code: "ECONNRESET", body: `Authorization: Bearer ${secret}` });
  assert.equal(c.kind, Kind.TIMEOUT);
  assert.ok(!JSON.stringify(c).includes(secret), "分类结果不回显密钥");
});

test("M6. 熔断：连续失败后 open，冷却期内不发请求；冷却后半开只放 1 个探测，成功则关闭", async () => {
  let t = 0;
  const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 10_000, now: () => t });
  const budget = new Budget({ maxCalls: 50 });
  reset([{ status: 500 }, { status: 500 }, { status: 500 }]);
  await assert.rejects(guardedCall({ call: doFetch, budget, breaker, retry: { maxAttempts: 3 }, sleep: noSleep }), Blocked);
  assert.equal(breaker.state, "open");
  const hitsAfterOpen = hits;
  await assert.rejects(guardedCall({ call: doFetch, budget, breaker, sleep: noSleep }), (e) => e.reason === "CIRCUIT_OPEN");
  assert.equal(hits, hitsAfterOpen, "熔断期间不向上游发请求");
  t = 10_001;
  reset([{ status: 200 }]);
  const res = await guardedCall({ call: doFetch, budget, breaker, sleep: noSleep });
  assert.equal(res.status, 200);
  assert.equal(breaker.state, "closed");
  // 半开探测失败 → 立刻重新 open
  breaker.failure({ summary: "x" }, { hard: true });
  t += 10_001;
  assert.equal(breaker.allow(), true);
  assert.equal(breaker.allow(), false, "半开状态同一时刻只放行一个探测");
});

test("M7. 预算硬封顶：调用次数/单阶段/花费任一超限，请求不再发出，Blocked(BUDGET)；备用路径只有在 allowed 时才用", async () => {
  // 总次数
  reset([]);
  const b1 = new Budget({ maxCalls: 2 });
  await guardedCall({ call: doFetch, budget: b1, sleep: noSleep });
  await guardedCall({ call: doFetch, budget: b1, sleep: noSleep });
  const before = hits;
  await assert.rejects(guardedCall({ call: doFetch, budget: b1, sleep: noSleep }), (e) => e.reason === "BUDGET");
  assert.equal(hits, before, "超限后没有发请求");
  // 单阶段
  const b2 = new Budget({ maxCalls: 99, maxCallsPerStage: 1 });
  await guardedCall({ call: doFetch, budget: b2, stage: "plan", sleep: noSleep });
  await assert.rejects(guardedCall({ call: doFetch, budget: b2, stage: "plan", sleep: noSleep }), /stage "plan"/);
  await guardedCall({ call: doFetch, budget: b2, stage: "build", sleep: noSleep });
  // 花费
  const b3 = new Budget({ maxCalls: 99, maxCostCny: 0.015 });
  await guardedCall({ call: doFetch, budget: b3, sleep: noSleep });
  await guardedCall({ call: doFetch, budget: b3, sleep: noSleep });
  await assert.rejects(guardedCall({ call: doFetch, budget: b3, sleep: noSleep }), /cost limit/);

  // 备用路径：未允许 → 跳过并记录；允许 → 使用
  for (const allowed of [false, true]) {
    reset([NO_ACCT]);
    const events = [];
    const fb = { id: "gemini", allowed, reason: "paid provider not approved", call: async () => ({ status: 200, body: "from-fallback" }) };
    const p = guardedCall({ call: doFetch, budget: new Budget(), fallbacks: [fb], sleep: noSleep, onEvent: (e) => events.push(e) });
    if (allowed) {
      const r = await p;
      assert.equal(r.body, "from-fallback");
      assert.ok(events.some((e) => e.type === "fallback" && e.id === "gemini"));
    } else {
      await assert.rejects(p, (e) => e.reason === "NO_ACCOUNT");
      assert.ok(events.some((e) => e.type === "fallback-skipped"));
    }
  }
});
