/**
 * GitHub Release 的正文 = `CHANGELOG.md` 里这一节，不是 workflow 里手写的模板。
 *
 *   node scripts/release-notes.mjs v0.4.0     # 正文写 stdout
 *   npm run release:notes -- v0.4.0
 *
 * # 为什么真源在这里
 *
 * `release.yml` 的 `releaseBody` 原本写死一段模板（"这个版本包含什么，看仓库的提交记录"），
 * 而同一个提交里 CHANGELOG 已经逐条写了新增 / 修复 / 破坏性变化 / 已知问题 / 升级注意。
 * 用户能看到的正文指向"提交记录"，仓库里已经有一份人写的版本说明 —— 这就是正文在骗人。
 * 两边各改各的还都不会红：模板改了没人知道，CHANGELOG 改了 CI 也不知道。
 *
 * # 四条定下来的事
 *
 * 1. **找不到那一节就红，不出空正文。** 草稿阶段的 release 是给人点 Publish 的，
 *    正文空着等于让下一次发版的人以为 CI 正常 —— 少写一节是发版漏的一步，不是可以绕过的分支。
 * 2. **`##` 那一行标题不进正文。** 标题带的是本文件的内部状态（`## v0.4.0 — 待发布`），
 *    发出去之后"待发布"还挂在用户看到的正文里就是假话；而 release 本身已经有名字。
 * 3. **相对链接改成 tag 上的绝对链接。** CHANGELOG 在仓库里 `./docs/x.md` 能点，
 *    同一段贴到 release 页面上点的是 `github.com/docs/x.md` —— 404，而没人会去点第二次。
 * 4. **正文里不许出现单独一行的 `### SHA-256`。** `release.yml` 追加哈希那一步用这一行
 *    切旧正文（重跑同一个 tag 时先切掉上一版留下的那一段），撞上了会被切掉半截。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 本机 dry-run 时没有 GITHUB_REPOSITORY，用 origin 那一个；CI 上以实际仓库为准。
const FALLBACK_REPO = "unraveltao/Lattice";

const fail = (message) => {
  console.error(`release-notes: ${message}`);
  process.exit(1);
};

const arg = process.argv[2];
if (!arg) fail("用法：node scripts/release-notes.mjs <tag>（例 v0.4.0）");

const tag = arg.startsWith("v") ? arg : `v${arg}`;
const version = tag.slice(1);
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`\`${arg}\` 里解析不出三段版本号 —— 别猜着往下走`);

const file = join(ROOT, "CHANGELOG.md");
if (!existsSync(file)) fail("CHANGELOG.md 不见了");

const lines = readFileSync(file, "utf8").split(/\r?\n/);
const heading = new RegExp(`^## v?${version.replace(/\./g, "\\.")}(\\s|$)`);
const start = lines.findIndex((line) => heading.test(line));
if (start < 0) {
  fail(
    `CHANGELOG.md 里没有 \`## ${tag}\` 那一节。发版前先把这一版写了什么补进去` +
      "（标题形如 `## v0.4.0`，后面可以跟状态），别改 workflow 里的正文来绕开这里",
  );
}

let end = lines.length;
for (let i = start + 1; i < lines.length; i += 1) {
  if (/^## /.test(lines[i])) {
    end = i;
    break;
  }
}

const body = lines.slice(start + 1, end).join("\n").trim();
if (!body) fail(`CHANGELOG.md 的 ${tag} 那一节是空的`);
if (/^### SHA-256$/m.test(body)) {
  fail(`${tag} 那一节里有 \`### SHA-256\` 标题 —— 换个名字，那一行归 CI 追加用`);
}

const repo = process.env.GITHUB_REPOSITORY ?? FALLBACK_REPO;
const withLinks = body.replace(/\]\((\.\/[^)]+)\)/g, (_match, rel) => {
  const repoPath = rel.replace(/^\.\//, "");
  return `](https://github.com/${repo}/blob/${tag}/${repoPath})`;
});

process.stdout.write(`${withLinks}\n`);
