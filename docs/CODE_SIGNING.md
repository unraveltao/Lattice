# 代码签名：为什么现在不买，免费的怎么走

> 结论先说：**不买证书。** 申请 [SignPath Foundation](https://signpath.org)（开源项目免费，给的是 OV 级证书），同时把 winget 当成主要分发渠道。两条都不要钱，合起来比"买一张 OV 证书"更管用。

这份文档存在的原因：v0.7 那条 `[ ] 代码签名证书` 原本写着"要花钱买 OV/EV 证书"，这句话在 2026 年是错的 —— 付费买不到当初以为能买到的东西，而免费那条路正好对我们开着。下次想改回去之前，先把下面三节读完。

## 零、先说清楚：这个项目里有三个"签名"，只有一个缺

读到"签名"两个字就往下对号入座，是这个话题最容易犯的错 —— 尤其是 release 页面里明明白白躺着一个 `.sig` 文件。

| 签什么 | 用什么 | 现状 | 谁来验 |
| --- | --- | --- | --- |
| **组件包**（`.lattice` zip） | ed25519，作者的私钥 | **已实现**，发布必签（`npm run sign:widget`） | Rust 的 `signature.rs`，公钥钉在目录里的 `publisher.key` |
| **更新产物**（`latest.json` + 安装包） | Tauri updater 的 minisign | **已实现**，`createUpdaterArtifacts: true`，每次 `tauri:build` 自动生成 `.sig` | 更新插件，公钥在 `tauri.conf.json` 的 `plugins.updater.pubkey` |
| **安装包本体**（Authenticode） | OV/EV 证书 | **没有** | Windows / SmartScreen |

**看到 release 里那个 `.sig`，不要以为安装包签过了。** 它证明的是"这个包是持有 minisign 私钥的人为自动更新发出来的"，验它的是更新插件 —— 而用户双击安装包时，SmartScreen 根本不看那个文件，它看的是 Authenticode，那一栏现在是空的。所以"更新链路是签过名的"和"第一次安装会被拦"这两句话同时成立，不矛盾。

下面五节全部在讲第三行，也就是**唯一缺的那一个**。

## 一、付费这条路比看上去更不值

三个事实，都来自微软自己的文档（`learn.microsoft.com/windows/apps/package-and-deploy/code-signing-options`，2026-09 版）：

**1. EV 从 2024 年起不再跳过 SmartScreen。** 原文：*"That behavior was removed in 2024. EV-signed files now go through the same reputation-building process as OV certificates."* 以前多花一倍钱买 EV 只为一件事 —— 第一次下载就不弹警告 —— 这件事已经没有了。微软自己写着 *"Paying the EV premium ($400+/year) solely to avoid SmartScreen warnings is no longer justified"*。

**2. 最便宜的那条付费路对个人开发者是关着的。** Azure Artifact Signing（原 Trusted Signing）$9.99/月、5,000 次签名，看着是白菜价，但**个人开发者只限美国、加拿大**（组织限美/加/欧盟/英国）。不在这些地区就买不了，这不是手续问题。

**3. OV 证书 $150–300/年，且续期躲不掉。** CA/B Forum 从 2023-06 起要求代码签名私钥必须存放在硬件里（UKey 或云端 HSM），证书有效期上限一年。没有"买一次永久用"这个选项，每年都要重新验证身份、重新签发。

三条合起来：付费能买到的**唯一**东西，是 SmartScreen 上发布者名字从"未知发布者"变成你自己的名字 —— 而且**照样先弹警告**，要发好几个版本把声誉攒起来才消失。而这件事 SignPath 免费给。

## 二、主推：SignPath Foundation

### 它给什么

- 一张 **OV 级**代码签名证书（微软文档原话：*"The program provides OV-level certificate signing through a managed pipeline"*），有效期内的签名次数不设限
- **不需要个人实名**。它验证的不是"你是谁"，而是"这个二进制确实是从这个公开仓库构建出来的"，然后以自己的名义为这件事背书
- 私钥生成并保存在**他们的 HSM** 里，我们这边永远拿不到私钥，也就不存在"私钥泄露 = 所有用户被推假更新"这个风险面
- 走 CI 集成，不插 UKey

### 它的代价（这几条才是真正要想清楚的）

- **证书主体是 SignPath Foundation，不是我们。** 用户在"数字签名"里看到的发布者名字是 SignPath Foundation。这是这个模式的本质 —— 它替你背书，所以签的是它的名字。介意这一点的话，免费的替代方案不存在
- **构建必须跑在 CI 里，而且他们能看见。** 本地 `npm run tauri:build` 出来的 exe 签不了，因为那证明不了来源。**我们这条已经满足了**：`.github/workflows/release.yml` 从 `v0.1.0` 起就在 `windows-latest` 上全自动构建，产物是 NSIS 安装包 + `latest.json` + 更新器那个 `.sig`（minisign，见第零节 —— 它跟本文要的 Authenticode 是两件事）
- **每次发版要人工批准一次签名请求。** 这是他们的策略，也是他们的风控。一年发几次版的项目，代价可以忽略
- **项目要已经发过版、在维护、有 OSI 许可、GitHub 和 SignPath 账号都开 MFA。** 四条我们现在都满足：MIT（`LICENSE`）、公开仓库、`v0.1.0` 起有 release、持续在改

### 流程

1. 在 <https://signpath.org/apply> 申请 Foundation（免费）档：仓库地址、许可证、一段项目说明、维护者身份。人工审核，通常 1–3 个工作日
2. 批准后拿到一个 SignPath 组织。在控制台里建 **Project**（slug 例如 `lattice`）
3. 把 GitHub 加为 **trusted build system**，指向本仓库和 `release.yml`
4. 建 **Artifact configuration**：我们的产物是 NSIS 安装包（一个 PE 文件），注意 GitHub 的 artifact 是打 zip 上传的，配置里要按 zip 里取 exe
5. 建 **Signing policy**（通常叫 `release-signing`），绑到 Foundation 证书
6. 建一个 **API token**（submitter 权限），把 token 和四个 slug 写进仓库的 Secrets / Variables：
   - `SIGNPATH_API_TOKEN`（secret）
   - `SIGNPATH_ORGANIZATION_ID`、`SIGNPATH_PROJECT_SLUG`、`SIGNPATH_SIGNING_POLICY_SLUG`、`SIGNPATH_ARTIFACT_CONFIGURATION_SLUG`（variables）
7. `release.yml` 里那一步**已经写好了（2026-10-26）**，休眠中：整组签名步骤挂在 `vars.SIGNPATH_ORGANIZATION_ID != ''` 上 —— 没配就跳过，发布照常出未签名的包。批下来之后把第 6 步那五个值填进仓库设置，下一次打 tag 自动签，不用再改代码。

**这一步不光是把包交给 SignPath，签完还得自己收尾**（`release.yml` 里写在注释里，别删）：Authenticode 会改字节，而 tauri-action 早就按**未签名**的那份 exe 算过更新器那种 minisign（release 上的 `.exe.sig` 与 `latest.json` 里的 `signature`）。所以签完要把签过的 exe 放回打包目录、用同一把更新器私钥重签、把 `latest.json` 里两处 `signature` 换成新的、三个资产重传 —— 再往下走的 SHA-256 与 winget 清单都从那个目录现算，必须算在签过的字节上。漏掉重签的症状是"检查更新"看着成功、下载回来报签名校验失败。

**第一次启用前先拿一个一次性的 tag 干跑一遍**：这组步骤只有在真正配好 SignPath 之后才会第一次执行，本地没法验。跑完看两样东西：日志里 `status=Valid root=…` 那两行（信任链，见下面那个"未证实的说法"），以及 `releases/latest/download/latest.json` 里的 signature 与 release 上 `.exe.sig` 的内容一致。

第 7 步这个"休眠"的形状是照抄好几个项目的做法。别把它写成"必须签名才能发版"：那会让一次审核（或者 SignPath 一次故障）卡住整个发布。

### 一个没证实的说法，别当事实传

有中文博客说签出来的证书链到一个叫 `SignPath Root CA G2` 的私有根，**不在 Windows 默认信任库里**，用户还得手动装根证书。

这个说法和微软的措辞对不上：微软把它归在 "OV-level certificate signing"，而 OV 的定义就是链到 Microsoft Trusted Root Program 里的 CA（同一页里对 MSI/EXE 提交 Store 的要求写得很清楚）。另有第三方安装指南说是 DigiCert 签发的。**我没能在 SignPath 自己的文档里找到明确答案**，所以三种说法都记在这里，等真签出第一个包再定论。

**两分钟验证法**（签出第一个包之后做，别提前猜）：

```powershell
Get-AuthenticodeSignature .\Lattice_x.y.z_x64-setup.exe | Format-List Status, StatusMessage, SignerCertificate
```

`Status` 是 `Valid` 就说明整条链在**这台机器**上通得过；再找一台从没装过任何根证书的干净 Windows 验一次，那才是用户看到的样子。如果干净机器上 `Status` 是 `UnknownError` / `NotTrusted`，说明私有根的说法成立，那就得回到第三节。

## 三、如果信任链真的不通：winget 比签名更管用

**这一条不管签名成不成，都值得做**，而且它解决的是同一个问题（用户第一次装被拦）的另一半。

winget 的分发模型里，信任不是挂在证书上的，是挂在**清单审核**上的：往 `microsoft/winget-pkgs` 提一个 manifest，人工 + 自动校验过一遍，用户 `winget install Lattice` 就装上了。关键是**经过 winget 下载的安装包不带 Mark-of-the-Web**，所以那条"从浏览器下载 → SmartScreen 拦"的路径根本不发生。这是目前 Windows 上最接近"免费且真的不弹警告"的路。

代价：清单里要写版本号、安装包直链（GitHub Releases 的地址可以）和 SHA-256，**每发一版都要重新提 PR**。这三样已经不用手抄了：`npm run winget:manifest` 从这次真正打出来的 exe 上现算（`release.yml` 打完包会把三份 YAML 挂成 release 附件），动作与四条边界见 [`reference/build.md`](./reference/build.md) 第五节。留下来的人工步骤只有"提 PR 并等审核"。

**Scoop** 更轻：自己仓库里放一个 JSON，用户 `scoop install`。受众偏开发者，但成本几乎为零 —— 不过它要再维护一个 bucket，而且 NSIS 的静默参数没在真机上验过，所以先排在 winget 之后（同上那一节末尾）。

## 四、明确不做

**自签名证书。** 微软文档写得很直接：*"Blocks installation for public users."* 它只对两种情况有用 —— 你自己这台机器，或者有 IT 部门能用组策略下发根证书的内网。公开分发的项目自签名，等于把"未知发布者"换成"签名无效"，更难解释。**不要为了"至少有个签名"去自签**，那是负收益。

## 五、在那之前：现在就该做的两件事

1. **README 里那句实话**（已经写了，别删）：安装包没签名、SmartScreen 会拦、这是缺证书不是打包坏了。用户看到警告时手边正好有这句话，比什么签名都省事
2. **每个 release 附 SHA-256**：让"我下到的包是不是官方的"有个能自己核对的答案。CI 里那一步在 `release.yml` 末尾，带 `continue-on-error` —— 算哈希失败绝不能让一个已经编译完的 release 红掉

## 六、时间线

| 什么时候 | 做什么 | 花钱 |
| --- | --- | --- |
| 现在 | README 实话 + release 附 SHA-256 | 0 |
| 下一次发版前 | 提 SignPath 申请（审核 1–3 天，可以先提交再等） | 0 |
| 批准后 | 填那五个值（签名步骤已经写好、休眠着），发一版签过名的，按上面的验证法验一遍 | 0 |
| 有稳定安装包之后 | 提 winget manifest（生成器与 CI 附件已就绪，见 [`reference/build.md`](./reference/build.md) 第五节） | 0 |
| 永远 | 不买 OV/EV，不用自签名对外分发 | 0 |
