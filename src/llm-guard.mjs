// 模型网关调用保护：分类错误 → 有限重试 → 熔断 → 预算 → 明确的 BLOCKED。
//
// 事故（DSH-INCIDENT-001）：上游返回 503 `no eligible upstream account is currently available`，
// 客户端把它当成"瞬时错误"连续重试 5 次后放弃，整个任务没有任何交付，也没有说明原因。
// 这条错误的含义是"账号池里现在没有可用账号"——这是容量/配额状态，不是网络抖动：
// 立刻再试同一个请求，只会再得到同样的 503，并且每次都可能被计费或占用配额。
// 所以：账号池类 503 不做密集重试；只做一次间隔较长的探测，仍失败就进入 BLOCKED，
// 保留已有成果，等待池恢复（半开探测）或人工处理。

import { setTimeout as sleepMs } from "node:timers/promises";

export const Kind = Object.freeze({
  BAD_REQUEST: "BAD_REQUEST", // 400/422：请求本身有问题，重试没有意义
  AUTH: "AUTH", // 401/403：凭据/权限问题，重试没有意义，需要人检查
  TIMEOUT: "TIMEOUT", // 408/超时/连接重置：有限重试
  RATE_LIMIT: "RATE_LIMIT", // 429：按 Retry-After
  SERVER: "SERVER", // 500/502/504：有限指数退避
  NO_ACCOUNT: "NO_ACCOUNT", // 503 且文案是账号池耗尽：不密集重试
  OVERLOADED: "OVERLOADED", // 其它 503/529：有限退避
  UNKNOWN: "UNKNOWN",
});

const NO_ACCOUNT_RE = /no eligible upstream account|no available (upstream )?account|account pool (is )?(empty|exhausted)/i;

/** @returns {{kind:string, retryable:boolean, retryAfterMs:number|null, summary:string}} 不含任何请求头/密钥 */
export function classify({ status, headers = {}, body = "", code } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  const retryAfterMs = parseRetryAfter(headers["retry-after"] ?? headers["Retry-After"]);
  const short = text.replace(/\s+/g, " ").slice(0, 200);
  if (!status) {
    const net = ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "ABORT_TIMEOUT"];
    return { kind: net.includes(code) ? Kind.TIMEOUT : Kind.UNKNOWN, retryable: net.includes(code), retryAfterMs: null, summary: `network:${code ?? "unknown"}` };
  }
  if (status === 400 || status === 404 || status === 413 || status === 422) return { kind: Kind.BAD_REQUEST, retryable: false, retryAfterMs: null, summary: `${status} ${short}` };
  if (status === 401 || status === 403) return { kind: Kind.AUTH, retryable: false, retryAfterMs: null, summary: `${status} ${short}` };
  if (status === 408) return { kind: Kind.TIMEOUT, retryable: true, retryAfterMs, summary: `408 ${short}` };
  if (status === 429) return { kind: Kind.RATE_LIMIT, retryable: true, retryAfterMs, summary: `429 ${short}` };
  if (status === 503 && NO_ACCOUNT_RE.test(text)) return { kind: Kind.NO_ACCOUNT, retryable: false, retryAfterMs, summary: `503 ${short}` };
  if (status === 503 || status === 529) return { kind: Kind.OVERLOADED, retryable: true, retryAfterMs, summary: `${status} ${short}` };
  if (status >= 500) return { kind: Kind.SERVER, retryable: true, retryAfterMs, summary: `${status} ${short}` };
  return { kind: Kind.UNKNOWN, retryable: false, retryAfterMs: null, summary: `${status} ${short}` };
}

export function parseRetryAfter(v, now = Date.now()) {
  if (v == null || v === "") return null;
  if (/^\d+$/.test(String(v).trim())) return Number(v) * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}

/** 限流/预算用尽、熔断打开、需要人处理——都用这个错误，带结构化原因，调用方据此落 BLOCKED，而不是当成普通失败。 */
export class Blocked extends Error {
  constructor(reason, detail = {}) {
    super(`BLOCKED(${reason}): ${detail.summary ?? ""}`.trim());
    this.name = "Blocked";
    this.reason = reason; // NO_ACCOUNT | AUTH | BAD_REQUEST | BUDGET | CIRCUIT_OPEN | RETRIES_EXHAUSTED
    this.detail = detail;
  }
}

/** 每个任务一个：硬性封顶调用次数与花费，防止"重试吃光预算"。 */
export class Budget {
  constructor({ maxCalls = 40, maxCostCny = Infinity, maxCallsPerStage = Infinity } = {}) {
    Object.assign(this, { maxCalls, maxCostCny, maxCallsPerStage });
    this.calls = 0;
    this.cost = 0;
    this.byStage = new Map();
  }
  /** 发请求前调用；超限直接抛 Blocked，不发出请求 */
  charge(stage = "default") {
    const n = (this.byStage.get(stage) ?? 0) + 1;
    if (this.calls + 1 > this.maxCalls) throw new Blocked("BUDGET", { summary: `call limit ${this.maxCalls} reached` });
    if (n > this.maxCallsPerStage) throw new Blocked("BUDGET", { summary: `stage "${stage}" call limit ${this.maxCallsPerStage} reached` });
    if (this.cost >= this.maxCostCny) throw new Blocked("BUDGET", { summary: `cost limit ¥${this.maxCostCny} reached (spent ¥${this.cost.toFixed(4)})` });
    this.calls++;
    this.byStage.set(stage, n);
  }
  addCost(c) {
    this.cost += c || 0;
  }
  snapshot() {
    return { calls: this.calls, cost: this.cost, byStage: Object.fromEntries(this.byStage) };
  }
}

/** 熔断器：closed → (连续 N 次失败) → open → (cooldown 后) → half-open（放行 1 个探测）→ closed/open。按 provider+model 一个。 */
export class CircuitBreaker {
  constructor({ failureThreshold = 2, cooldownMs = 5 * 60_000, now = () => Date.now() } = {}) {
    Object.assign(this, { failureThreshold, cooldownMs, now });
    this.state = "closed";
    this.failures = 0;
    this.openedAt = 0;
    this.probing = false;
    this.lastError = null;
  }
  /** 返回 true 才允许发请求 */
  allow() {
    if (this.state === "closed") return true;
    if (this.state === "open" && this.now() - this.openedAt >= this.cooldownMs) {
      this.state = "half-open";
      this.probing = false;
    }
    if (this.state === "half-open" && !this.probing) {
      this.probing = true; // 只放一个探测
      return true;
    }
    return false;
  }
  retryInMs() {
    return this.state === "open" ? Math.max(0, this.cooldownMs - (this.now() - this.openedAt)) : 0;
  }
  success() {
    this.state = "closed";
    this.failures = 0;
    this.probing = false;
    this.lastError = null;
  }
  failure(info, { hard = false } = {}) {
    this.lastError = info;
    this.failures++;
    if (this.state === "half-open" || hard || this.failures >= this.failureThreshold) {
      this.state = "open";
      this.openedAt = this.now();
      this.probing = false;
    }
  }
}

const jitter = (ms, rnd) => Math.round(ms * (0.8 + 0.4 * rnd()));

/**
 * 在保护下执行一次"逻辑调用"。
 * @param {object} o
 * @param {(attempt:number)=>Promise<{status:number, headers?:object, body?:any, cost?:number}>} o.call  真正发请求；网络层错误抛出带 .code 的 Error
 * @param {Budget} o.budget
 * @param {CircuitBreaker} [o.breaker]
 * @param {string} [o.stage]
 * @param {{base?:number,max?:number,maxAttempts?:number,maxWaitMs?:number}} [o.retry]
 * @param {Array<{id:string, call:Function, allowed:boolean, reason?:string}>} [o.fallbacks]  仅当 allowed 为真才会被使用
 * @param {(ev:object)=>void} [o.onEvent]   每次尝试/等待/切换都会回调，供落库审计
 * @param {(ms:number)=>Promise<void>} [o.sleep]
 * @param {()=>number} [o.random]
 */
export async function guardedCall(o) {
  const { call, budget, breaker, stage = "default", onEvent = () => {}, sleep = (ms) => sleepMs(ms), random = Math.random } = o;
  const retry = { base: 1000, max: 30_000, maxAttempts: 3, maxWaitMs: 60_000, ...(o.retry ?? {}) };
  const tried = [];

  async function runOne(id, fn) {
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
      if (breaker && id === "primary" && !breaker.allow()) {
        onEvent({ type: "circuit-open", id, retryInMs: breaker.retryInMs() });
        throw new Blocked("CIRCUIT_OPEN", { summary: `circuit open for ${breaker.retryInMs()}ms after: ${breaker.lastError?.summary ?? "?"}`, last: breaker.lastError });
      }
      budget.charge(stage); // 超限在这里抛 Blocked，请求不会发出
      let res;
      try {
        res = await fn(attempt);
      } catch (e) {
        res = { status: 0, code: e.code ?? (e.name === "TimeoutError" ? "ABORT_TIMEOUT" : undefined), body: String(e.message ?? e) };
      }
      budget.addCost(res.cost);
      if (res.status >= 200 && res.status < 300) {
        if (breaker && id === "primary") breaker.success();
        onEvent({ type: "ok", id, attempt });
        return res;
      }
      const c = classify(res);
      tried.push({ id, attempt, kind: c.kind, summary: c.summary });
      onEvent({ type: "error", id, attempt, kind: c.kind, summary: c.summary });
      const hard = c.kind === Kind.NO_ACCOUNT || c.kind === Kind.AUTH;
      if (breaker && id === "primary") breaker.failure(c, { hard });
      if (c.kind === Kind.AUTH) throw new Blocked("AUTH", { summary: c.summary, tried });
      if (c.kind === Kind.BAD_REQUEST) throw new Blocked("BAD_REQUEST", { summary: c.summary, tried });
      if (c.kind === Kind.NO_ACCOUNT) throw new Blocked("NO_ACCOUNT", { summary: c.summary, tried, retryAfterMs: c.retryAfterMs });
      if (!c.retryable) throw new Blocked("BAD_REQUEST", { summary: c.summary, tried });
      if (attempt === retry.maxAttempts) throw new Blocked("RETRIES_EXHAUSTED", { summary: c.summary, tried });
      let wait = c.retryAfterMs ?? jitter(Math.min(retry.max, retry.base * 2 ** (attempt - 1)), random);
      if (wait > retry.maxWaitMs) throw new Blocked(c.kind === Kind.RATE_LIMIT ? "RATE_LIMIT" : "RETRIES_EXHAUSTED", { summary: `${c.summary}; server asked to wait ${wait}ms (> ${retry.maxWaitMs}ms cap)`, tried, retryAfterMs: wait });
      onEvent({ type: "wait", id, attempt, waitMs: wait });
      await sleep(wait);
    }
  }

  try {
    return await runOne("primary", call);
  } catch (e) {
    if (!(e instanceof Blocked)) throw e;
    // 只有"配置过且明确允许"的备用路径才会被尝试；预算用尽/认证/请求本身有问题不换路（换了也一样，或者会多花钱）
    if (["BUDGET", "AUTH", "BAD_REQUEST"].includes(e.reason)) throw e;
    for (const fb of o.fallbacks ?? []) {
      if (!fb.allowed) {
        onEvent({ type: "fallback-skipped", id: fb.id, reason: fb.reason ?? "not allowed" });
        continue;
      }
      onEvent({ type: "fallback", id: fb.id, from: e.reason });
      try {
        return await runOne(fb.id, fb.call);
      } catch (e2) {
        if (!(e2 instanceof Blocked)) throw e2;
      }
    }
    throw e;
  }
}
