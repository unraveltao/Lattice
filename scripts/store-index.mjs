/**
 * 生成组件目录：把 `public/widgets/*` 打包、签名，写成一份静态的 `registry.json`。
 *
 *   npm run store:index
 *   npm run store:index -- --out public/store --widgets public/widgets
 *
 * 产物：
 *
 *   public/store/registry.json                       目录本体
 *   public/store/packages/<id>-<version>.lattice     每个组件一个包
 *
 * 这两样东西合起来就是"商店"。没有服务端，所以它既能跟着应用一起发
 * （内置目录），也能整目录扔到任何静态托管上（远端目录）—— 目录里的地址
 * 都是相对的，搬到别处只改 `storeSource` 那一行。
 *
 * # 为什么演示目录的私钥在仓库里
 *
 * `scripts/dev-publisher.key` 是**公开的**，它只签这 6 个官方自带的组件。
 * 不这么做的话，"npm run dev" 之后目录就验不过签 —— 一个开箱就报错的商店
 * 比没有商店更糟。真实发布者应该 `--gen-key` 自己生成一把，把公钥写进
 * 自己那份 registry.json 的 `publisher.key` 里。这件事在 README 里写清楚了：
 * 这把钥匙证明的是"这个包和这份目录是一起发的"，不是"这个人可信"。
 *
 * # 版本号从清单来
 *
 * 目录里的 `version` 必须和包里 `manifest.json` 的 `version` 一致 —— 安装时
 * Rust 会核对这一条（`store.rs`），不一致直接拒。所以这里**不**允许覆盖，
 * 想发新版本就改清单里的版本号再跑一遍。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildZip, collectFiles } from "./pack-widget.mjs";
import { publicKeyFromSeed, signBytes } from "./sign-widget.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_WIDGETS = "public/widgets";
const DEFAULT_OUT = "public/store";
const DEFAULT_KEY = "scripts/dev-publisher.key";
const PUBLISHER_NAME = "Lattice";

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

/**
 * 作者写的名字 / 描述可以是双语对象（`{ zh, en }`，见 `runtime/widget-text.ts`）。
 * 目录里**原样存下去**，两种语言都留着，界面按当前语言挑；
 * 这里只需要挑一个来排序 —— 挑不到就退回另一种，跟前端同一条规则。
 */
function pickText(value, lang = "zh") {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  return value[lang] || value.zh || value.en || "";
}

function main() {
  const widgetsDir = resolve(root, arg("--widgets", DEFAULT_WIDGETS));
  const outDir = resolve(root, arg("--out", DEFAULT_OUT));
  const keyPath = resolve(root, arg("--key", DEFAULT_KEY));

  if (!existsSync(widgetsDir)) {
    console.error(`\n  ${relative(root, widgetsDir)} 不存在 —— 先跑 npm run widgets:index\n`);
    process.exit(1);
  }
  if (!existsSync(keyPath)) {
    console.error(
      `\n  找不到签名私钥 ${relative(root, keyPath)}。\n  生成一把：npm run sign:widget -- --gen-key --out ${relative(root, keyPath)}\n`,
    );
    process.exit(1);
  }

  const seed = readFileSync(keyPath, "utf8");
  const { publicKey } = publicKeyFromSeed(seed);

  const packagesDir = join(outDir, "packages");
  mkdirSync(packagesDir, { recursive: true });

  const entries = [];
  let totalBytes = 0;

  for (const name of readdirSync(widgetsDir).sort()) {
    const dir = join(widgetsDir, name);
    if (!statSync(dir).isDirectory()) continue;

    const manifestPath = join(dir, "manifest.json");
    if (!existsSync(manifestPath)) {
      console.warn(`  ! ${name} 没有 manifest.json，跳过`);
      continue;
    }

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!manifest.id || !manifest.version) {
      console.warn(`  ! ${name} 的清单缺 id 或 version，跳过`);
      continue;
    }

    const names = collectFiles(dir);
    const files = names.map((item) => ({
      name: item,
      body: readFileSync(join(dir, ...item.split("/"))),
    }));
    const archive = buildZip(files);

    const sha256 = sha256Hex(archive);
    const signature = signBytes(archive, seed);
    const fileName = `${manifest.id}-${manifest.version}.lattice`;
    writeFileSync(join(packagesDir, fileName), archive);
    totalBytes += archive.length;

    entries.push({
      id: manifest.id,
      name: manifest.name ?? manifest.id,
      description: manifest.description ?? "",
      author: manifest.author ?? PUBLISHER_NAME,
      ...(manifest.icon ? { icon: `../widgets/${manifest.id}/${manifest.icon}` } : {}),
      versions: [
        {
          version: manifest.version,
          url: `packages/${fileName}`,
          sha256,
          size: archive.length,
          signature,
          permissions: Array.isArray(manifest.permissions) ? manifest.permissions : [],
        },
      ],
    });

    console.log(`  ${manifest.id} ${manifest.version}  ${(archive.length / 1024).toFixed(1)} KB`);
  }

  entries.sort((a, b) => pickText(a.name).localeCompare(pickText(b.name), "zh-CN"));

  const catalogue = {
    schema: 1,
    // 目录自己的名字也是双语：中文界面显示"棂官方组件"，英文界面还是原来那句
    name: { zh: "棂官方组件", en: "Lattice official" },
    updated: new Date().toISOString().slice(0, 10),
    publisher: { name: PUBLISHER_NAME, key: publicKey },
    widgets: entries,
  };

  const registryPath = join(outDir, "registry.json");
  writeFileSync(registryPath, `${JSON.stringify(catalogue, null, 2)}\n`);

  console.log(
    `\n  ${entries.length} 个组件 → ${relative(root, registryPath)}（共 ${(totalBytes / 1024).toFixed(1)} KB）`,
  );
  console.log(`  发布者公钥 ${publicKey}\n`);
}

main();
