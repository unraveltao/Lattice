/**
 * winget manifest：一个出好的 NSIS 安装包 → 三份 YAML（version / installer / locale）。
 *
 *   node scripts/winget-manifest.mjs
 *   node scripts/winget-manifest.mjs --exe src-tauri/target/release/bundle/nsis/Lattice_0.1.1_x64-setup.exe
 *   node scripts/winget-manifest.mjs --out .scratch/winget --url https://example.com/Lattice_0.1.1_x64-setup.exe
 *
 * # 为什么要有这条命令
 *
 * winget 是目前 Windows 上**唯一一条"免费且真的不弹 SmartScreen"**的分发路：它下载的
 * 安装包不带 Mark-of-the-Web，用户压根不走"浏览器下载 → 未知发布者 → 仍要运行"这条路。
 * 所以「买不买证书」和「上不上 winget」是两件事，后者不管签名成不成都要做 ——
 * 论证在 docs/CODE_SIGNING.md 第三节，不在这里重复。
 *
 * 代价是每发一版都要交一份清单，里面有版本号、安装包直链和 **SHA-256**。这三样东西
 * 手抄就会错（抄错版本的哈希是最常见的一种），而且错了不会在本地红 —— 要等
 * microsoft/winget-pkgs 的校验器告诉你。既然安装包已经在这台机器/这台 runner 上，
 * 哈希就从它身上现算。
 *
 * # 四条定下来的事
 *
 * 1. **清单不进仓库，发布时现生成。** 它描述的是"某个版本的某个字节"，
 *    和 `.lattice` 包一样是发布产物（`dist-winget/` 在 .gitignore 里）。真进仓库的话，
 *    下次发版要么忘了改、要么改了但和真正的 exe 不是一份 —— 两种都比没有更糟。
 * 2. **`InstallerType: nullsoft`、`Scope: user`。** Tauri 的 Windows 产物是 NSIS，
 *    默认 per-user 装进 `%LOCALAPPDATA%`，升级就是再跑一遍安装器（`UpgradeBehavior: install`）。
 *    别写成 `msi` / `machine`：那会让 winget 用系统级参数去跑一个用户级安装器。
 * 3. **不写 `MinimumOSVersion`。** 少一个手写的断言，就少一个没人核对的事实 ——
 *    真要写，得先确认 WebView2 与 Tauri 各自支持到哪个 Windows 版本。
 * 4. **`Publisher` 不是猜的，也没为此改配置。** Tauri 的规则是"取 identifier 的第二段"
 *    （`tauri-utils` 的 `BundleConfig::publisher` 注释写着这句），这台机器的
 *    identifier 是 `com.iron-tom.lattice`，所以 ARP 里显示的就是 `iron-tom`。
 *    清单必须和它一字不差，否则 PR 的校验会说 PublisherMismatch；把 `bundle.publisher`
 *    改成别的名字会连带换掉卸载信息所在的注册表路径，已装的用户会多出一条残留 ——
 *    为一个显示名付这个代价不值。真要用别的名字，先想清楚升级路径。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Hex } from "./sign-widget.mjs";

export const MANIFEST_VERSION = "1.6.0";
export const PACKAGE_IDENTIFIER = "unraveltao.Lattice";
export const REPO_URL = "https://github.com/unraveltao/Lattice";
export const LICENSE = "MIT";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// 纯函数（`npm run test:winget` 直接 import 这些）
// ---------------------------------------------------------------------------

/** `v0.1.1` 和 `0.1.1` 都收，出来的永远是清单要的那种 */
export function normalizeVersion(raw) {
  const value = String(raw ?? "").trim().replace(/^v/i, "");
  return /^\d+\.\d+\.\d+$/.test(value) ? value : null;
}

/** Tauri 的 NSIS 产物名就是这个形状（见 ROADMAP v0.7 第一条） */
export function installerName(version) {
  return `Lattice_${version}_x64-setup.exe`;
}

/** 默认直链：release 的 tag 是 `v<版本>`，附件名和本地产物同名 */
export function installerUrl(version) {
  return `${REPO_URL}/releases/download/v${version}/${installerName(version)}`;
}

/** Tauri 的默认发布者：identifier 的第二段（`com.iron-tom.lattice` → `iron-tom`） */
export function defaultPublisher(identifier) {
  const parts = String(identifier ?? "").split(".");
  return parts.length >= 2 && parts[1] ? parts[1] : null;
}

export function defaultInstallerPath(base, version) {
  return join(base, "src-tauri", "target", "release", "bundle", "nsis", installerName(version));
}

/**
 * 只给"需要引号"的值加引号。够用的判据：形状像 `0.1.1` / `en-US` / 一句没有标点的
 * 英文就原样写，其余（带逗号、冒号、井号、结尾空格）一律双引号包起来 + 转义。
 * 不引 YAML 库：这三份文件的字段全是自己写死的，多一个依赖只为转义几个字符不划算。
 */
export function yamlValue(value) {
  const text = String(value);
  const plain = /^[A-Za-z0-9][A-Za-z0-9 ._/@+:-]*$/.test(text) && !/: | #| $/.test(text);
  if (plain) return text;
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function yamlLines(fields) {
  const lines = [];
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${yamlValue(item)}`);
    } else {
      lines.push(`${key}: ${yamlValue(value)}`);
    }
  }
  return lines;
}

/**
 * 三份清单。顺序固定（version → installer → locale 是 winget 文档里的顺序），
 * 内容只依赖入参 —— 同一份安装包跑两次必须逐字节相同，否则每次发版都会多出一堆
 * 无意义的 diff。
 */
export function buildManifests({ version, sha256, url, publisher, shortDescription, description }) {
  const sha = String(sha256).toUpperCase();
  const installers = [
    "PackageIdentifier: " + PACKAGE_IDENTIFIER,
    `PackageVersion: ${version}`,
    "InstallerLocale: en-US",
    "Platform:",
    "  - Windows.Desktop",
    "InstallerType: nullsoft",
    "Scope: user",
    "InstallModes:",
    "  - interactive",
    "  - silent",
    "  - silentWithProgress",
    "UpgradeBehavior: install",
    "Installers:",
    "  - Architecture: x64",
    `    InstallerUrl: ${yamlValue(url)}`,
    `    InstallerSha256: ${sha}`,
    "ManifestType: installer",
    `ManifestVersion: ${MANIFEST_VERSION}`,
  ];

  return [
    {
      name: `${PACKAGE_IDENTIFIER}.yaml`,
      body: [
        `# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.${MANIFEST_VERSION}.schema.json`,
        ...yamlLines({
          PackageIdentifier: PACKAGE_IDENTIFIER,
          PackageVersion: version,
          DefaultLocale: "en-US",
          ManifestType: "version",
          ManifestVersion: MANIFEST_VERSION,
        }),
      ],
    },
    {
      name: `${PACKAGE_IDENTIFIER}.installer.yaml`,
      body: [
        `# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.${MANIFEST_VERSION}.schema.json`,
        ...installers,
      ],
    },
    {
      name: `${PACKAGE_IDENTIFIER}.locale.en-US.yaml`,
      body: [
        `# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.${MANIFEST_VERSION}.schema.json`,
        ...yamlLines({
          PackageIdentifier: PACKAGE_IDENTIFIER,
          PackageVersion: version,
          PackageLocale: "en-US",
          Publisher: publisher,
          PublisherUrl: "https://github.com/unraveltao",
          PublisherSupportUrl: `${REPO_URL}/issues`,
          PackageName: "Lattice",
          PackageUrl: REPO_URL,
          License: LICENSE,
          LicenseUrl: `${REPO_URL}/blob/main/LICENSE`,
          ShortDescription: shortDescription,
          Description: description,
          Moniker: "lattice",
          Tags: ["widgets", "desktop", "tauri"],
          // 三件套里的 locale 那一份是 `defaultLocale`，**不是** `singleton`。
          // 写错的症状不在本地：`winget validate` 会说"multi file manifest 里不该
          // 出现这种 ManifestType"，而提 PR 之后校验器才红。`singleton` 是"一个
          // 文件写完整份清单"的那种投法，三件套里一份都不该有。
          ManifestType: "defaultLocale",
          ManifestVersion: MANIFEST_VERSION,
        }),
      ],
    },
  ].map((file) => ({ ...file, body: `${file.body.join("\n")}\n` }));
}

/** 清单被 winget 拒的第一大原因是"版本号/哈希/直链三者有一对不上"，本地先自己核一遍 */
export function checkInstallUrl(url, version) {
  const name = installerName(version);
  if (!url.startsWith("https://")) return `直链必须是 https（winget 不收明文 http）：${url}`;
  if (!url.endsWith(`/${name}`)) return `直链的附件名要是 ${name}，收到 ${url}`;
  return null;
}

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Set(["--exe", "--url", "--out"]);
const USAGE = [
  "  用法：npm run winget:manifest -- [选项]",
  "",
  "    --exe <文件>    安装包；默认按 tauri.conf.json 的版本去 NSIS 产物目录里找",
  "    --url <地址>    安装包直链；默认 GitHub Releases 的 v<版本> 附件",
  "    --out <目录>    写到哪儿；默认 dist-winget/manifests/u/unraveltao/Lattice/<版本>",
  "",
  "  产物是三份 YAML，提给 microsoft/winget-pkgs 的 manifests/u/unraveltao/Lattice/<版本>/。",
  "  步骤见 docs/reference/build.md 第五节。",
  "",
];

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`多余的参数：${token}`);
    if (!VALUE_FLAGS.has(token)) throw new Error(`不认识的选项：${token}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${token} 后面缺一个值`);
    options[token.slice(2)] = value;
    index += 1;
  }
  return options;
}

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function readConfig() {
  const path = join(root, "src-tauri", "tauri.conf.json");
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`读不了 src-tauri/tauri.conf.json：${error.message}`);
  }
}

export function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`\n  ${error.message}\n`);
    console.error(USAGE.join("\n"));
    process.exit(1);
  }

  const config = readConfig();
  const bundle = config.bundle ?? {};
  const version = normalizeVersion(config.version);
  if (!version) fail(`tauri.conf.json 的 version 不合法：${config.version}`);

  const publisher = String(bundle.publisher ?? "").trim() || defaultPublisher(config.identifier);
  if (!publisher) {
    fail(
      "算不出发布者名字：tauri.conf.json 既没有 bundle.publisher，identifier 也不是三段式。\n" +
        "  winget 清单的 Publisher 必须和安装器 ARP 里的那个一致（见文件头第 4 条）。",
    );
  }

  const exePath = options.exe ? resolve(process.cwd(), options.exe) : defaultInstallerPath(root, version);
  if (!existsSync(exePath)) {
    fail(
      `找不到安装包：${exePath}\n` +
        "  先 npm run tauri:build（或者把 --exe 指到已经出好的那个 exe 上）。\n" +
        "  winget 清单里的哈希是**字节的哈希**，没有安装包就没有清单。",
    );
  }

  const url = options.url ?? installerUrl(version);
  const urlProblem = checkInstallUrl(url, version);
  if (urlProblem) fail(urlProblem);

  const bytes = readFileSync(exePath);
  if (bytes.length === 0) fail(`安装包是 0 字节：${exePath}\n  哈希算得出来，但没有任何意义 —— 重新构建一次再回来。`);
  const sha256 = sha256Hex(bytes).toUpperCase();
  const outDir = options.out
    ? resolve(process.cwd(), options.out)
    : join(root, "dist-winget", "manifests", "u", "unraveltao", "Lattice", version);

  const en = {
    shortDescription: "Extensible desktop widgets for Windows",
    description:
      "Third-party desktop widgets written in plain HTML, CSS and JavaScript. Each one runs sandboxed and asks for platform capabilities through a permission manifest.",
  };

  const files = buildManifests({ version, sha256, url, publisher, ...en });

  mkdirSync(outDir, { recursive: true });
  for (const file of files) writeFileSync(join(outDir, file.name), file.body);

  const megabytes = (bytes.length / 1024 / 1024).toFixed(2);
  console.log(`\n  ${PACKAGE_IDENTIFIER} ${version}`);
  console.log(`  安装包    ${exePath.slice(root.length + 1)}（${megabytes} MB）`);
  console.log(`  sha256    ${sha256}`);
  console.log(`  直链      ${url}`);
  console.log(`  publisher ${publisher}`);

  console.log(`\n  三份清单写进 ${outDir.slice(root.length + 1) || outDir}`);
  for (const file of files) console.log(`    ${file.name}`);
  console.log(
    "\n  下一步：把这三份 YAML 放进 microsoft/winget-pkgs 的\n" +
      `    manifests/u/unraveltao/Lattice/${version}/\n` +
      "  提一个 PR（步骤与判据见 docs/reference/build.md 第五节）。\n" +
      "  提之前先 winget validate，那一遍会替你核对字段名与哈希。\n",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
