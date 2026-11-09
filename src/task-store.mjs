// 交付可靠性：任务状态、检查点、产物哈希、幂等副作用、发件箱。
//
// 事故里"77 次调用、¥17.95、没有任何交付"的结构性原因：成果只存在于一次进行中的对话里，
// 模型一断，没有任何东西记得"做完了什么"；更没有"交付"这一步与"做事"解耦。
// 这里把它们拆开：
//   - 每个阶段完成就落一个检查点（含产物文件的 SHA-256），重来时已完成阶段直接跳过，不重做、不再花钱；
//   - 任务被上游挡住（BLOCKED）时，已有成果是 PARTIAL，本地确定性地生成一份报告——不需要模型；
//   - 交付走发件箱：发送失败只重试"发送"，绝不重跑任务；同一内容用 dedupe_key 保证只发一次；
//   - 同一个任务同一时刻只允许一个运行者（租约 + 原子 UPDATE），跨进程有效。
// 存储用 Node 内置的 node:sqlite（WAL）。

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

export const State = Object.freeze({
  QUEUED: "QUEUED",
  RUNNING: "RUNNING",
  PARTIAL: "PARTIAL", // 有成果，但被挡住/暂停
  BLOCKED: "BLOCKED", // 没有可交付成果就被挡住
  COMPLETED: "COMPLETED",
  DELIVERY_PENDING: "DELIVERY_PENDING",
  DELIVERED: "DELIVERED",
});
const NEXT = {
  QUEUED: ["RUNNING", "BLOCKED"],
  RUNNING: ["PARTIAL", "BLOCKED", "COMPLETED", "QUEUED"],
  PARTIAL: ["RUNNING", "DELIVERY_PENDING", "BLOCKED"],
  BLOCKED: ["RUNNING", "QUEUED", "DELIVERY_PENDING"],
  COMPLETED: ["DELIVERY_PENDING"],
  DELIVERY_PENDING: ["DELIVERED", "RUNNING"],
  DELIVERED: [],
};

export const sha256File = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS tasks(
  id TEXT PRIMARY KEY, title TEXT NOT NULL, state TEXT NOT NULL,
  run_id TEXT, lease_until INTEGER NOT NULL DEFAULT 0, lease_ms INTEGER NOT NULL DEFAULT 30000,
  blocked_reason TEXT, blocked_detail TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS checkpoints(
  task_id TEXT NOT NULL, stage TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(task_id, stage));
CREATE TABLE IF NOT EXISTS artifacts(
  task_id TEXT NOT NULL, stage TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL,
  PRIMARY KEY(task_id, stage, path));
CREATE TABLE IF NOT EXISTS effects(
  key TEXT PRIMARY KEY, task_id TEXT, result TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'DONE',
  lease_until INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS outbox(
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, claim_until INTEGER NOT NULL DEFAULT 0,
  last_error TEXT);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT);
`;

export class TaskStore {
  constructor(file, { now = () => Date.now() } = {}) {
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    // Upgrade databases created by the pre-integration toolkit without replacing data.
    const addColumn = (table, column, definition) => {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all().map((x) => x.name);
      if (!columns.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    };
    addColumn("effects", "status", "TEXT NOT NULL DEFAULT 'DONE'");
    addColumn("effects", "lease_until", "INTEGER NOT NULL DEFAULT 0");
    addColumn("effects", "updated_at", "INTEGER NOT NULL DEFAULT 0");
    addColumn("outbox", "claim_until", "INTEGER NOT NULL DEFAULT 0");
    this.now = now;
  }
  close() {
    this.db.close();
  }
  #event(taskId, kind, detail) {
    this.db.prepare("INSERT INTO events(task_id,at,kind,detail) VALUES(?,?,?,?)").run(taskId, this.now(), kind, detail == null ? null : JSON.stringify(detail));
  }
  #tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ── 任务 ──
  createTask(id, title) {
    const t = this.now();
    this.db.prepare("INSERT OR IGNORE INTO tasks(id,title,state,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, title, State.QUEUED, t, t);
    return this.get(id);
  }
  get(id) {
    return this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) ?? null;
  }
  transition(id, to, extra = {}) {
    return this.#tx(() => {
      const cur = this.get(id);
      if (!cur) throw new Error(`no such task ${id}`);
      if (cur.state === to) return cur;
      if (!NEXT[cur.state].includes(to)) throw new Error(`illegal transition ${cur.state} -> ${to}`);
      this.db.prepare("UPDATE tasks SET state=?, updated_at=?, blocked_reason=?, blocked_detail=? WHERE id=?").run(to, this.now(), extra.reason ?? null, extra.detail ? JSON.stringify(extra.detail) : null, id);
      this.#event(id, `state:${to}`, extra);
      return this.get(id);
    });
  }

  // ── 运行租约：同一任务同一时刻只有一个运行者 ──
  /** 原子抢占。成功返回 true。租约过期的"死运行者"会被顶掉。 */
  claim(id, runId, leaseMs = 30_000) {
    const t = this.now();
    const r = this.db.prepare("UPDATE tasks SET run_id=?, lease_until=?, lease_ms=?, updated_at=? WHERE id=? AND (run_id IS NULL OR run_id=? OR lease_until<?)").run(runId, t + leaseMs, leaseMs, t, id, runId, t);
    if (Number(r.changes) !== 1) return false;
    const cur = this.get(id);
    if (cur.state !== State.RUNNING && cur.state !== State.DELIVERED) {
      if (NEXT[cur.state].includes(State.RUNNING)) this.transition(id, State.RUNNING);
    }
    this.#event(id, "claim", { runId });
    return true;
  }
  /** 续租：不传 leaseMs 就沿用认领时的租期（否则心跳会悄悄把短租约改成长租约，崩溃后迟迟无法接手）。 */
  heartbeat(id, runId, leaseMs) {
    const r = this.db.prepare("UPDATE tasks SET lease_until=? + COALESCE(?, lease_ms) WHERE id=? AND run_id=?").run(this.now(), leaseMs ?? null, id, runId);
    return Number(r.changes) === 1;
  }
  release(id, runId) {
    this.db.prepare("UPDATE tasks SET run_id=NULL, lease_until=0 WHERE id=? AND run_id=?").run(id, runId);
  }

  // ── 检查点与产物 ──
  checkpoint(id, stage) {
    const r = this.db.prepare("SELECT data, seq FROM checkpoints WHERE task_id=? AND stage=?").get(id, stage);
    return r ? { seq: r.seq, data: JSON.parse(r.data), artifacts: this.artifacts(id, stage) } : null;
  }
  artifacts(id, stage) {
    const q = stage ? this.db.prepare("SELECT stage,path,sha256,size FROM artifacts WHERE task_id=? AND stage=? ORDER BY path") : this.db.prepare("SELECT stage,path,sha256,size FROM artifacts WHERE task_id=? ORDER BY stage,path");
    return stage ? q.all(id, stage) : q.all(id);
  }
  stages(id) {
    return this.db.prepare("SELECT stage, seq FROM checkpoints WHERE task_id=? ORDER BY seq").all(id).map((r) => r.stage);
  }
  /** 阶段完成：检查点与产物哈希在同一个事务里落库。已存在则原样返回（幂等，不覆盖）。 */
  commitStage(id, runId, stage, data, files = []) {
    const hashes = files.map((p) => ({ path: p, sha256: sha256File(p), size: statSync(p).size })); // 先算哈希，文件缺失会在这里抛
    return this.#tx(() => {
      const t = this.get(id);
      if (t.run_id !== runId) throw new Error(`run ${runId} does not hold the lease for ${id}`);
      const ex = this.checkpoint(id, stage);
      if (ex) return ex;
      const seq = Number(this.db.prepare("SELECT COUNT(*) c FROM checkpoints WHERE task_id=?").get(id).c) + 1;
      this.db.prepare("INSERT INTO checkpoints(task_id,stage,seq,data,created_at) VALUES(?,?,?,?,?)").run(id, stage, seq, JSON.stringify(data), this.now());
      for (const h of hashes) this.db.prepare("INSERT INTO artifacts(task_id,stage,path,sha256,size) VALUES(?,?,?,?,?)").run(id, stage, h.path, h.sha256, h.size);
      this.#event(id, "stage", { stage, files: hashes.length });
      return this.checkpoint(id, stage);
    });
  }
  /** 重来时的主入口：阶段已完成就直接返回已存的结果，fn 不会被调用。 */
  async runStage(id, runId, stage, fn) {
    const done = this.checkpoint(id, stage);
    if (done) return { skipped: true, ...done };
    const { data, files } = await fn();
    this.heartbeat(id, runId);
    return { skipped: false, ...this.commitStage(id, runId, stage, data, files ?? []) };
  }
  /** 重新计算产物哈希，报告被改动/丢失的文件。 */
  verifyArtifacts(id) {
    const bad = [];
    for (const a of this.artifacts(id)) {
      try {
        if (sha256File(a.path) !== a.sha256) bad.push({ ...a, problem: "modified" });
      } catch {
        bad.push({ ...a, problem: "missing" });
      }
    }
    return bad;
  }

  // ── 被挡住 ──
  /** 有成果 → PARTIAL，没有 → BLOCKED。成果不会被丢弃。 */
  block(id, runId, reason, detail = {}) {
    const to = this.stages(id).length > 0 ? State.PARTIAL : State.BLOCKED;
    if (runId) this.release(id, runId);
    return this.transition(id, to, { reason, detail });
  }

  // ── 幂等副作用 ──
  async once(key, taskId, fn, { leaseMs = 30_000, waitMs = 50, maxWaitMs = 5_000 } = {}) {
    const started = this.now();
    for (;;) {
      const now = this.now();
      const claim = this.#tx(() => {
        const ex = this.db.prepare("SELECT result,status,lease_until FROM effects WHERE key=?").get(key);
        if (ex?.status === "DONE") return { kind: "done", value: JSON.parse(ex.result) };
        if (ex?.status === "RUNNING" && ex.lease_until > now) return { kind: "wait" };
        if (ex) {
          const r = this.db.prepare("UPDATE effects SET task_id=?,status='RUNNING',lease_until=?,updated_at=? WHERE key=? AND (status!='RUNNING' OR lease_until<=?)").run(taskId, now + leaseMs, now, key, now);
          return Number(r.changes) === 1 ? { kind: "owner" } : { kind: "wait" };
        }
        this.db.prepare("INSERT INTO effects(key,task_id,result,status,lease_until,created_at,updated_at) VALUES(?,?,?,'RUNNING',?,?,?)").run(key, taskId, "null", now + leaseMs, now, now);
        return { kind: "owner" };
      });
      if (claim.kind === "done") return { ran: false, value: claim.value };
      if (claim.kind === "owner") {
        try {
          const value = await fn();
          this.#tx(() => this.db.prepare("UPDATE effects SET result=?,status='DONE',lease_until=0,updated_at=? WHERE key=? AND task_id=? AND status='RUNNING'").run(JSON.stringify(value ?? null), this.now(), key, taskId));
          return { ran: true, value };
        } catch (error) {
          this.db.prepare("DELETE FROM effects WHERE key=? AND task_id=? AND status='RUNNING'").run(key, taskId);
          throw error;
        }
      }
      if (now - started >= maxWaitMs) throw new Error(`effect ${key} is already running`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, maxWaitMs - (now - started))));
    }
  }

  // ── 本地确定性报告：不依赖模型，同样的库内容 → 逐字节相同的输出 ──
  buildReport(id) {
    const t = this.get(id);
    const lines = [`# ${t.title}`, "", `Task: ${t.id}`, `State: ${t.state}`];
    if (t.blocked_reason) lines.push(`Blocked: ${t.blocked_reason}`, ...(t.blocked_detail ? [`Detail: ${t.blocked_detail}`] : []));
    lines.push("", "## Completed stages");
    const st = this.db.prepare("SELECT stage, seq, data FROM checkpoints WHERE task_id=? ORDER BY seq").all(id);
    if (!st.length) lines.push("(none)");
    for (const s of st) {
      lines.push(`${s.seq}. ${s.stage}`, `   result: ${s.data}`);
      for (const a of this.artifacts(id, s.stage)) lines.push(`   - ${a.path}  sha256=${a.sha256}  size=${a.size}`);
    }
    return lines.join("\n") + "\n";
  }

  // ── 发件箱 ──
  /** 同一 dedupe_key 只入一次。成果齐了/部分成果齐了，都可以排交付。 */
  enqueueDelivery(id, channel, payload, dedupeKey = `${id}:${channel}:${sha256(payload)}`) {
    const ins = this.db.prepare("INSERT OR IGNORE INTO outbox(task_id,dedupe_key,channel,payload) VALUES(?,?,?,?)").run(id, dedupeKey, channel, payload);
    const cur = this.get(id);
    if (cur.state !== State.DELIVERY_PENDING && cur.state !== State.DELIVERED && NEXT[cur.state].includes(State.DELIVERY_PENDING)) this.transition(id, State.DELIVERY_PENDING);
    return { queued: Number(ins.changes) === 1, dedupeKey };
  }
  /**
   * 只负责"发"：对到期的 PENDING 逐条调用 sender。失败 → 指数退避；超过 maxAttempts → DEAD（任务仍是 DELIVERY_PENDING，等人处理）。
   * 绝不会重跑任务阶段。成功且该任务没有别的待发项 → DELIVERED。
   */
  async deliver(sender, { maxAttempts = 5, baseMs = 1000, limit = 20 } = {}) {
    const due = this.db.prepare("SELECT * FROM outbox WHERE ((status='PENDING' AND next_at<=?) OR (status='SENDING' AND claim_until<=?)) ORDER BY id LIMIT ?").all(this.now(), this.now(), limit);
    const out = { sent: 0, failed: 0, dead: 0 };
    for (const m of due) {
      // 认领这一条：避免两个投递进程同时发同一封
      const claim = this.db.prepare("UPDATE outbox SET status='SENDING', claim_until=? WHERE id=? AND (status='PENDING' OR (status='SENDING' AND claim_until<=?))").run(this.now() + 60_000, m.id, this.now());
      if (Number(claim.changes) !== 1) continue;
      try {
        await sender({ channel: m.channel, payload: m.payload, dedupeKey: m.dedupe_key, taskId: m.task_id });
        this.db.prepare("UPDATE outbox SET status='SENT', attempts=attempts+1, claim_until=0, last_error=NULL WHERE id=?").run(m.id);
        out.sent++;
      } catch (e) {
        const attempts = m.attempts + 1;
        const dead = attempts >= maxAttempts;
        this.db.prepare("UPDATE outbox SET status=?, attempts=?, next_at=?, claim_until=0, last_error=? WHERE id=?").run(dead ? "DEAD" : "PENDING", attempts, this.now() + baseMs * 2 ** (attempts - 1), String(e.message ?? e).slice(0, 300), m.id);
        dead ? out.dead++ : out.failed++;
      }
      const left = Number(this.db.prepare("SELECT COUNT(*) c FROM outbox WHERE task_id=? AND status!='SENT'").get(m.task_id).c);
      if (left === 0 && this.get(m.task_id).state === State.DELIVERY_PENDING) this.transition(m.task_id, State.DELIVERED);
    }
    return out;
  }
  outbox(id) {
    return this.db.prepare("SELECT id,channel,status,attempts,next_at,last_error,dedupe_key FROM outbox WHERE task_id=? ORDER BY id").all(id);
  }
  events(id) {
    return this.db.prepare("SELECT kind FROM events WHERE task_id=? ORDER BY id").all(id).map((r) => r.kind);
  }
}
