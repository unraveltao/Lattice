/**
 * winget 清单生成器的形状，用 `node --test` 钉住（`npm run test:winget`，不需要安装包）。
 *
 * 这里测的是"生成出来的三份 YAML 对不对"，不是"winget 收不收" —— 后者只有
 * `winget validate` 和 microsoft/winget-pkgs 的 CI 能回答。但三件本地就能错的事必须
 * 在这儿挡住：**哈希大小写**（清单要大写，`sha256Hex` 给小写）、**直链与附件名**
 * （版本号和文件名对不上是最常犯的抄错）、**Publisher 与安装器一致**（ARP 里那个名字
 * 来自 identifier 的第二段，见脚本文件头第 4 条）。
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  PACKAGE_IDENTIFIER,
  buildManifests,
  checkInstallUrl,
  defaultPublisher,
  installerName,
  installerUrl,
  normalizeVersion,
  parseArgs,
  yamlValue,
} from "./winget-manifest.mjs";

const VERSION = "0.1.1";
const BYTES = Buffer.from("a fake NSIS installer\n");
const SHA = createHash("sha256").update(BYTES).digest("hex").toUpperCase();

const manifests = () =>
  buildManifests({
    version: VERSION,
    sha256: SHA,
    url: installerUrl(VERSION),
    publisher: defaultPublisher("com.iron-tom.lattice"),
    shortDescription: "Extensible desktop widgets for Windows",
    description: "Third-party desktop widgets written in plain HTML, CSS and JavaScript.",
  });

test("版本号：v0.1.1 与 0.1.1 都收，半截版本号拒掉", () => {
  assert.equal(normalizeVersion("v0.1.1"), VERSION);
  assert.equal(normalizeVersion(" 0.1.1 "), VERSION);
  assert.equal(normalizeVersion("0.1"), null);
  assert.equal(normalizeVersion(""), null);
});

test("安装包名字与直链用的是同一份形状", () => {
  assert.equal(installerName(VERSION), "Lattice_0.1.1_x64-setup.exe");
  assert.equal(
    installerUrl(VERSION),
    "https://github.com/unraveltao/lattice/releases/download/v0.1.1/Lattice_0.1.1_x64-setup.exe",
  );
});

test("Publisher 取 identifier 的第二段（Tauri 自己的规则）", () => {
  assert.equal(defaultPublisher("com.iron-tom.lattice"), "iron-tom");
  assert.equal(defaultPublisher("lattice"), null);
  assert.equal(defaultPublisher(undefined), null);
});

test("YAML 值只在必要的时候加引号", () => {
  assert.equal(yamlValue("0.1.1"), "0.1.1");
  assert.equal(yamlValue("en-US"), "en-US");
  assert.equal(yamlValue("Extensible desktop widgets"), "Extensible desktop widgets");
  assert.equal(yamlValue("HTML, CSS and JavaScript"), '"HTML, CSS and JavaScript"');
  assert.equal(yamlValue("a: b"), '"a: b"');
  assert.equal(yamlValue(""), '""');
});

test("三份清单的名字与 ManifestType 对得上", () => {
  const byName = Object.fromEntries(manifests().map((file) => [file.name, file.body]));
  assert.deepEqual(Object.keys(byName).sort(), [
    `${PACKAGE_IDENTIFIER}.installer.yaml`,
    `${PACKAGE_IDENTIFIER}.locale.en-US.yaml`,
    `${PACKAGE_IDENTIFIER}.yaml`,
  ]);
  assert.match(byName[`${PACKAGE_IDENTIFIER}.yaml`], /^ManifestType: version$/m);
  assert.match(byName[`${PACKAGE_IDENTIFIER}.installer.yaml`], /^ManifestType: installer$/m);
  // 三件套里 locale 那一份是 `defaultLocale`，不是 `singleton`。
  //
  // 这条一开始写错了，而错的那一版被当成"期望值"钉在这儿，所以本地一直是绿的 ——
  // 直到 2026-10-26 第一次真的拿清单去 `winget validate`：
  // "The multi file manifest should not contain file with the particular ManifestType.
  //  [ManifestType] Value: singleton"。三件套里任何一份写 `singleton`，winget 就当成
  // "你把单文件清单拆错了"。`singleton` 只属于"一个文件写完整个清单"的那种投法。
  assert.match(byName[`${PACKAGE_IDENTIFIER}.locale.en-US.yaml`], /^ManifestType: defaultLocale$/m);
  for (const body of Object.values(byName)) {
    assert.doesNotMatch(body, /^ManifestType: singleton$/m, "三件套里不许出现 singleton");
  }
});

test("installer 那份是 nullsoft + 用户级 + x64", () => {
  const body = manifests().find((file) => file.name.endsWith(".installer.yaml")).body;
  assert.match(body, /^InstallerType: nullsoft$/m);
  assert.match(body, /^Scope: user$/m);
  assert.match(body, /^  - Architecture: x64$/m);
  assert.doesNotMatch(body, /MinimumOSVersion/, "不写没核对过的系统版本下限");
});

test("哈希是大写，且和独立算出来的一致", () => {
  const body = manifests().find((file) => file.name.endsWith(".installer.yaml")).body;
  const found = /^ {4}InstallerSha256: ([0-9a-fA-F]+)$/m.exec(body);
  assert.ok(found, "installer 清单里应该有 InstallerSha256");
  assert.equal(found[1], SHA);
  assert.match(found[1], /^[0-9A-F]{64}$/, "winget 要的是大写 hex");
});

test("locale 那份带 Publisher 和三段链接", () => {
  const body = manifests().find((file) => file.name.endsWith(".locale.en-US.yaml")).body;
  assert.match(body, /^Publisher: iron-tom$/m);
  assert.match(body, /^Moniker: lattice$/m);
  assert.match(body, /^License: MIT$/m);
  assert.match(body, /^PackageVersion: 0\.1\.1$/m);
});

test("同一份输入跑两次，三份清单逐字节相同", () => {
  const first = manifests();
  const second = manifests();
  assert.deepEqual(first, second);
});

test("直链的三道检查：https、附件名、正常", () => {
  assert.match(checkInstallUrl(`http://x/${installerName(VERSION)}`, VERSION) ?? "", /https/);
  assert.match(checkInstallUrl("https://x/Lattice_0.1.0_x64-setup.exe", VERSION) ?? "", /附件名/);
  assert.equal(checkInstallUrl(installerUrl(VERSION), VERSION), null);
});

test("参数解析：三个值选项都认，未知选项与缺值都拒", () => {
  assert.deepEqual(parseArgs(["--exe", "a.exe", "--url", "https://x/a.exe", "--out", "tmp"]), {
    exe: "a.exe",
    url: "https://x/a.exe",
    out: "tmp",
  });
  assert.throws(() => parseArgs(["--nope", "x"]), /不认识的选项/);
  assert.throws(() => parseArgs(["--exe"]), /缺一个值/);
  assert.throws(() => parseArgs(["a.exe"]), /多余的参数/);
});
