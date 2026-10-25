#!/usr/bin/env node
/**
 * lattice-agent —— 命令行客户端。
 *
 * 存在的理由：**MCP 不是所有 agent 都能用的，但 shell 是。** 任何能跑命令的
 * 东西（Claude Code、自己写的脚本、`curl`）都能用这个脚本操作 Lattice，
 * 不需要先接一套协议。
 *
 * 零依赖：只用 `node:fs` 和全局 `fetch`（Node 18+）。
 *
 *   node scripts/lattice-agent.mjs ping
 *   node scripts/lattice-agent.mjs state
 *   node scripts/lattice-agent.mjs say "Moved the clock to the top right"
 *   node scripts/lattice-agent.mjs act theme.set --args '{"theme":"dark"}'
 *   node scripts/lattice-agent.mjs act placement.add --args '{"widgetId":"lattice.clock"}'
 *
 * 端点默认关。先在 Lattice 的设置菜单里打开 Agent access，这个脚本才连得上。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const CONFIG_DIR = process.env.APPDATA
  ? join(process.env.APPDATA, "com.iron-tom.lattice", "agent")
  : null;

function endpointPath() {
  if (!CONFIG_DIR) {
    // 只有 Windows 有 APPDATA；这个平台本来也只有 Windows 版
    fail("could not find %APPDATA% — this endpoint only exists on Windows");
  }
  return join(CONFIG_DIR, "endpoint.json");
}

function fail(message) {
  process.stderr.write(`lattice-agent: ${message}\n`);
  process.exit(1);
}

function readEndpoint() {
  const path = endpointPath();
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // 三种情况长得一样，但处理方式完全不同，所以逐条说清楚
    fail(
      `no endpoint at ${path}\n` +
        `  · Lattice is not running, or\n` +
        `  · Agent access is off (Settings → Agent access), or\n` +
        `  · Lattice has never been started on this account`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${path} is not valid JSON (${error.message}) — turn Agent access off and on again`);
  }
}

async function rpc(endpoint, payload) {
  const response = await fetch(endpoint.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${endpoint.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  }).catch((error) => {
    // 端口还开着但连不上：多半是 Lattice 刚退出，endpoint.json 还没来得及擦
    fail(
      `could not reach ${endpoint.url} (${error.message})\n` +
        `  the port in endpoint.json is stale — Lattice is probably not running`,
    );
  });

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    fail(`the endpoint answered ${response.status} with something that is not JSON:\n${text}`);
  }
  if (response.status === 401) {
    fail("the token in endpoint.json was rejected — Lattice regenerated it; re-read the file");
  }
  return { status: response.status, body };
}

function parseArgs(argv) {
  const args = { command: null, action: null, json: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--args") {
      args.json = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (args.command === null) args.command = token;
    else if (args.action === null) args.action = token;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (!args.command || args.command === "help" || args.command === "--help") {
  process.stdout.write(
    [
      "用法：",
      "  lattice-agent ping                      端点还活着吗",
      "  lattice-agent state                     桌面现在长什么样",
      "  lattice-agent say \"<一句话>\"             在审计日志里留一行（必须加引号）",
      "  lattice-agent act <动作> [--args JSON]   改点什么",
      "",
      "动作（只有这些，别的会被拒）：",
      "  placement.add     {\"widgetId\":\"lattice.clock\"}",
      "  placement.move    {\"instanceId\":\"…\",\"x\":40,\"y\":40}",
      "  placement.resize  {\"instanceId\":\"…\",\"w\":300,\"h\":200}",
      "  placement.remove  {\"instanceId\":\"…\"}",
      "  placement.pin     {\"instanceId\":\"…\",\"pinned\":true}",
      "  placement.front   {\"instanceId\":\"…\"}",
      "  theme.set         {\"theme\":\"dark\"|\"light\"|\"system\"}",
      "  widgets.pause     {\"paused\":true}",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const endpoint = readEndpoint();

if (args.command === "ping") {
  const health = endpoint.health ?? endpoint.url.replace(/\/rpc$/, "/health");
  const response = await fetch(health, {
    headers: { authorization: `Bearer ${endpoint.token}` },
  }).catch(() => null);
  if (!response || !response.ok) fail(`no answer from ${health}`);
  process.stdout.write(`${JSON.stringify(await response.json())}\n`);
  process.exit(0);
}

if (args.command === "state") {
  const { body } = await rpc(endpoint, { op: "state" });
  if (!body.ok) {
    fail(`${body.code}: ${body.error}`);
  }
  process.stdout.write(`${JSON.stringify(body.result, null, 2)}\n`);
  process.exit(0);
}

if (args.command === "say") {
  // 正文就是第二个位置参数（**必须加引号**，否则 shell 会把它拆成几个词）。
  // 不走 `--args`：说一句话不该要求调用方先拼一段 JSON。
  const text = args.action;
  if (!text) fail('say needs some text, e.g. `say "Moved the clock to the top right"`');
  const { status, body } = await rpc(endpoint, { op: "say", text });
  if (!body.ok) {
    process.stderr.write(`${JSON.stringify({ status, ...body }, null, 2)}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(body.result ?? body, null, 2)}\n`);
  process.exit(0);
}

if (args.command === "act") {
  if (!args.action) fail("act needs an action name, e.g. `act theme.set --args '{\"theme\":\"dark\"}'`");
  let parsed = null;
  if (args.json) {
    try {
      parsed = JSON.parse(args.json);
    } catch (error) {
      fail(`--args is not valid JSON (${error.message})`);
    }
  }
  const { status, body } = await rpc(endpoint, { op: "act", action: args.action, args: parsed });
  // 失败打到 stderr、成功打到 stdout：这样 `| jq` 不会被错误信息污染
  if (!body.ok) {
    process.stderr.write(`${JSON.stringify({ status, ...body }, null, 2)}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(body.result ?? body, null, 2)}\n`);
  process.exit(0);
}

fail(`unknown command "${args.command}" — try \`lattice-agent help\``);
