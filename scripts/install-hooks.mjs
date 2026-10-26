#!/usr/bin/env node
/**
 * 把 `core.hooksPath` 指到 `scripts/git-hooks/` —— 让钩子跟着仓库走。
 *
 * 为什么不用 `.git/hooks/`：那份不入库。clone 下来永远是十几个 `.sample`，
 * 谁也不会去手动拷一遍、再 chmod +x。规矩写在 CONTRIBUTING 里，钩子却只装在
 * 作者那台机器上，等于没有。
 *
 *   npm install / npm ci     由 package.json 的 prepare 自动跑
 *   npm run hooks:install    手动跑一次（换了机器、或者克隆时跳过了脚本）
 *
 * **失败不算错（退出码永远是 0）**：这不是构建的一部分。在 CI 的 checkout 里、
 * 在没装 git 的环境里、在打包好的 tarball 里（没有 `.git`），它跑不了，
 * 而那种"跑不了"不该让 `npm ci` 红。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const HOOKS_DIR = "scripts/git-hooks";

const say = (line) => console.log(`hooks: ${line}`);

// 没有 .git = 不是一份工作副本（tarball、打包产物、某些 CI 缓存）。
// 判断用 `git rev-parse` 而不是 `fs.existsSync(".git")`：worktree 和
// submodule 里 `.git` 是一个文件，不是目录。
function git(args) {
  return spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

if (!fs.existsSync(path.join(ROOT, HOOKS_DIR))) {
  say(`没有 ${HOOKS_DIR}/，跳过`);
  process.exit(0);
}

const probe = git(["rev-parse", "--git-dir"]);
if (probe.status !== 0) {
  say("这里不是 git 工作副本，跳过");
  process.exit(0);
}

const current = git(["config", "--local", "--get", "core.hooksPath"]);
if (current.status === 0 && current.stdout.trim() === HOOKS_DIR) {
  // 已经装好了。这里刻意不说话 —— 每次 npm install 都喊一遍会变成噪音
  process.exit(0);
}

const set = git(["config", "--local", "core.hooksPath", HOOKS_DIR]);
if (set.status !== 0) {
  say(`设不上 core.hooksPath（${(set.stderr || "").trim() || "未知原因"}），钩子这次没装`);
  process.exit(0);
}

// 在 Windows 上 git 会把钩子当 shell 脚本交给它自带的 sh，所以这两个文件
// 必须是 LF。`.gitattributes` 里已经钉了 `scripts/git-hooks/* text eol=lf`；
// 这里再查一次，是因为那条规则是后加的 —— 早先 checkout 出来的副本可能还是 CRLF。
for (const name of ["commit-msg", "pre-push"]) {
  const file = path.join(ROOT, HOOKS_DIR, name);
  if (!fs.existsSync(file)) continue;
  if (fs.readFileSync(file, "utf8").includes("\r\n")) {
    say(`警告：${HOOKS_DIR}/${name} 是 CRLF，Git Bash 会报 "bad interpreter"。`);
    say(`      git rm --cached ${HOOKS_DIR}/${name} && git add ${HOOKS_DIR}/${name} 重新检出即可`);
  }
}

say(`core.hooksPath = ${HOOKS_DIR}（commit-msg 校验提交信息，pre-push 跑 typecheck + check:docs）`);
