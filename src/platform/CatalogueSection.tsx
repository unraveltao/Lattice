/**
 * 棂 / Lattice —— 组件库里的"目录"段
 *
 * 这一段回答的问题是"**还能装什么**"，和上面两段的区别是：这里的条目来自
 * 一份外部 JSON，不是磁盘上已经有的东西。所以每张卡片都要说清三件事：
 *
 *   1. 从哪儿来（Bundled / 远端目录的名字）
 *   2. 签名状态（谁签的、钥匙指纹；换过人要点一次确认；被拉黑的一律不能装）
 *   3. 点下去会发生什么（安装 / 更新到 x.y.z / 已经最新 / 目录落后了 / 不能装）
 *
 * 界面上的判断全部来自 `runtime/catalogue.ts::planInstall` —— 这里不再算一遍。
 * "拉黑"和"换人了"和"有新版本"谁优先这种顺序，只应该在一个地方决定（有单测钉着）。
 *
 * 整段默认收起，里面再分堆：**已安装且没有新版本的条目一律不出卡片**（它在
 * "Installed" 里已经有一张了），只留一行统计交代；剩下的分成"能装 / 要决定"
 * 和"装不了"。目录越长这条越重要 —— 装过之后八条里通常只有一条需要点。
 */

import { useMemo, useState } from "react";
import {
  addedPermissions,
  isBlockedKey,
  isDemoPublisherKey,
  keyFingerprint,
  planInstall,
  sourceLabel,
  type CatalogueEntry,
  type CataloguePackage,
  type InstallPlan,
  type MergeConflict,
  type SourceSnapshot,
} from "../runtime/catalogue";
import { PERMISSION_LABELS, permissionLabel, type Permission } from "../runtime/manifest";
import { useLang, useT } from "../runtime/i18n";
import { textVariants, useText } from "../runtime/widget-text";
import type { CatalogueSnapshot } from "./catalogue";
import type { PermissionReview } from "./store";
import { Glyph, ICON } from "./icons";
import { LibSection } from "./LibSection";

export interface StoreBinding {
  snapshot: CatalogueSnapshot | null;
  /** 每源的读况（含停用的）—— 商店顶那几行状态用它 */
  sources: SourceSnapshot[];
  /** 同一个 id 被多个源提供：谁赢、谁被盖住 */
  conflicts: MergeConflict[];
  /** 源 id → 界面上的名字（卡片角标用） */
  sourceLabels: Record<string, string>;
  /** 正在读目录 */
  busy: boolean;
  /** 正在装的那一个（卡片上转圈，别的按钮禁用） */
  busyId: string | null;
  /** 已安装组件的版本与权限，按 widgetId */
  installedVersions: Map<string, string>;
  installedPermissions: Map<string, Permission[]>;
  /** 第一次安装时记下的发布者公钥 */
  pinnedKeys: Record<string, string>;
  /** 用户拉黑的发布者公钥（归一化后的 hex） */
  blockedKeys: string[];
  /** 待确认的"新版本多要了权限" */
  reviews: Record<string, PermissionReview>;
  onRefresh: () => void;
  /**
   * 装 / 更新一个目录条目。
   *
   * 返回值是 Promise：批量安装要**一条一条来**。并发跑的话，`busyId` 会被
   * 后一条覆盖，`setNotice` 也只剩最后一条能看见 —— 装 5 个坏 1 个，
   * 用户看到的是"装好了"。
   */
  onInstall: (entry: CatalogueEntry, pkg: CataloguePackage, acceptNewKey: boolean) => void | Promise<void>;
  /** 拉黑一把钥匙（"这人的东西我不装"，以及换钥匙时"旧的那把可能泄露了"） */
  onBlockKey: (key: string) => void;
  onUnblockKey: (key: string) => void;
}

interface CatalogueSectionProps {
  store: StoreBinding;
  /** 搜索词（已切分）；空数组表示没在搜 */
  tokens: string[];
  installedIds: Set<string>;
  /** 正在搜索 —— 无视折叠状态，直接摊开 */
  forceOpen?: boolean;
}

function matches(entry: CatalogueEntry, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = [
    // 名字与描述是作者写的，两门都摆进来（和 `library-search.ts` 同一条规矩）
    ...textVariants(entry.name),
    entry.id,
    ...textVariants(entry.description),
    entry.author,
    // 权限名中英各放一份：英文名保持原样（与 `library-search.ts` 一致），
    // 另一份按当前界面语言取 —— 中文界面下搜"网络"要能命中要联网的包。
    ...entry.versions.flatMap((item) =>
      item.permissions.flatMap((p) => [PERMISSION_LABELS[p] ?? p, permissionLabel(p)]),
    ),
  ]
    .join(" ")
    .toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

/**
 * 哪些处置方式算"有东西可做"。
 *
 * `blocked` / `untrusted` 也在这里：它们虽然不能直接装，但卡片上有
 * "解除拉黑" / "信任新钥匙"两颗按钮 —— 收进"Nothing to install"里，
 * 用户就再也找不到那两颗按钮了。
 */
const NEEDS_ACTION = new Set<InstallPlan["kind"]>(["install", "update", "untrusted", "blocked"]);

export function CatalogueSection({
  store,
  tokens,
  installedIds,
  forceOpen = false,
}: CatalogueSectionProps) {
  const t = useT();
  const text = useText();
  /** 中文里列举用「、」，英文里是逗号 —— 拼出来的是句子，标点要跟着语言走 */
  const isZh = useLang() === "zh";
  const listSep = isZh ? "、" : ", ";
  const notesSep = isZh ? "、" : " and ";
  const { snapshot } = store;
  /** 批量安装正在进行：期间把按钮按住，免得点两遍 */
  const [batchBusy, setBatchBusy] = useState(false);

  const entries = useMemo(() => {
    const list = snapshot?.catalogue?.entries ?? [];
    return list.filter((entry) => matches(entry, tokens));
    // 切换界面语言会换一套权限名，命中结果要跟着重算
  }, [snapshot, tokens, isZh]);

  /*
   * 每条的处置在这里一次算完，再分堆。
   *
   * 卡片自己不再算：同一条目算两遍，一旦两处的入参有出入，就会出现
   * "标题说 2 条能装、展开只有 1 张卡"这种对不上的界面。
   *
   * `versionPlan` 是**只看版本**的那一份（把钉住的钥匙和拉黑名单都去掉）。
   * 用它判断"已安装的这一条还值不值得再打扰用户" —— 不能直接看 `plan.kind`：
   * `planInstall` 把换钥匙排在版本比较**前面**，所以一条"换了人且真有新版"的
   * 条目会返回 `untrusted`，只看 kind 就会把新版本一起吞掉。
   */
  const rows = useMemo(() => {
    return entries
      .map((entry) => {
        const installedVersion = store.installedVersions.get(entry.id) ?? null;
        const pinned = store.pinnedKeys[entry.id];
        return {
          entry,
          installed: installedIds.has(entry.id),
          plan: planInstall(entry, {
            installedVersion,
            /*
             * 公开的演示钥匙不算身份（`isDemoPublisherKey` 里写了为什么）：
             * 内置目录就是用它签的，而远端目录用发布者自己的钥匙 —— 同一份组件
             * 在两处有两把钥匙，钉住前者只会在切源时制造一次"换人了"的假警报。
             */
            pinnedKey: isDemoPublisherKey(pinned) ? null : (pinned ?? null),
            blockedKeys: store.blockedKeys,
          }),
          versionPlan: planInstall(entry, { installedVersion, pinnedKey: null, blockedKeys: null }),
        };
      })
      .filter(
        (row): row is typeof row & { plan: InstallPlan; versionPlan: InstallPlan } =>
          row.plan !== null && row.versionPlan !== null,
      );
  }, [entries, installedIds, store.installedVersions, store.pinnedKeys, store.blockedKeys]);

  if (!snapshot) return null;

  // 目录坏了要说出来，但不能占满整个面板 —— 上面两段还能正常工作
  if (snapshot.error) {
    return (
      <LibSection
        title="Catalogue"
        count={snapshot.catalogue ? null : t("Offline")}
        defaultOpen
        className="lattice-store"
      >
        <div className="lattice-lib-note">
          <p className="lattice-lib-note-title">{t("The catalogue could not be read")}</p>
          <p className="lattice-hint">{snapshot.error}</p>
          <button type="button" className="lattice-btn is-small" onClick={store.onRefresh}>
            {t("Try again")}
          </button>
        </div>
      </LibSection>
    );
  }

  if (!snapshot.catalogue) return null;

  // 目录自己的名字也是作者写的（可以两门），按当前语言取
  const name = text(snapshot.catalogue.name);
  const updated = snapshot.catalogue.updated;

  /*
   * 先做去重，再分组。
   *
   * **已安装、且目录里没有更高版本的条目，这里一张卡都不出。** 它在上面
   * "Installed" 里已经有一张卡了 —— 同一件东西在一屏里出现两次，会让人以为
   * 自己装了两份。这条规则以前没有，于是 8 个已装组件能铺出 14 张卡。
   *
   * 判据用 `versionPlan` 而不是 `plan`：换钥匙排在版本比较前面，一条"换了人
   * 且真有新版"的条目 `plan.kind` 是 `untrusted`，只看它会把新版本一起吞掉。
   */
  const quiet = rows.filter((row) => row.installed && row.versionPlan.kind !== "update");
  const visible = rows.filter((row) => !quiet.includes(row));

  /*
   * 剩下的再分两堆：有按钮要按的排前面，装不了的单独一层。
   * 第二堆叫 "Cannot be installed" 而不是 "Up to date"：能落到这一堆的
   * 只有 `unsigned`（没签名，装不了），说"最新"是假的。
   */
  const actionable = visible.filter((row) => NEEDS_ACTION.has(row.plan.kind));
  const stuck = visible.filter((row) => !NEEDS_ACTION.has(row.plan.kind));
  /** 批量安装只覆盖"从没装过"的；更新可能多要权限，必须一张一张确认 */
  const fresh = visible.filter((row) => row.plan.kind === "install");
  /*
   * 平时这一堆就是"能装的"。只有出现换钥匙 / 被拉黑时才改口 ——
   * 那两种条目严格说来**装不了**（要先确认或先解黑），继续写
   * "Can be installed" 会让标题变成一句假话。
   */
  const routine = actionable.every((row) => row.plan.kind === "install" || row.plan.kind === "update");

  /*
   * 静默统计行：被折叠掉的那些已装条目，总得有个交代。
   *
   * 只写数量，不出卡片 —— 它就是"去重"这件事本身。异常的那几种单独点一句，
   * 否则把它们一起静默就成了瞒报。
   *
   * **两类数字不能相加**：版本那一维（up to date / older / unsigned）每条只落
   * 一个，钥匙那一维（换人 / 被拉黑）是叠在上面的 —— 一条"换了人且已最新"的
   * 条目会同时进两个桶。写成 "6 up to date, 1 with a changed key" 会让人以为
   * 一共有 7 条。所以钥匙那句另起一句，用 "N of them"。
   */
  const versionParts: string[] = [];
  const tally = (test: (row: (typeof quiet)[number]) => boolean) => quiet.filter(test).length;
  const upToDate = tally((row) => row.versionPlan.kind === "current");
  const behind = tally((row) => row.versionPlan.kind === "older");
  const unsigned = tally((row) => row.versionPlan.kind === "unsigned");
  if (upToDate) versionParts.push(t("{count} up to date", { count: upToDate }));
  if (behind) versionParts.push(t("{count} older than your copy", { count: behind }));
  if (unsigned) versionParts.push(t("{count} unsigned", { count: unsigned }));

  const keyNotes: string[] = [];
  const changedKey = tally((row) => row.plan.kind === "untrusted");
  const blockedKey = tally((row) => row.plan.kind === "blocked");
  if (changedKey) keyNotes.push(t("a changed publisher key"));
  if (blockedKey) keyNotes.push(t("a blocked publisher key"));

  return (
    <LibSection
      title={name}
      count={store.busy ? t("Loading…") : rows.length}
      forceOpen={forceOpen}
      className="lattice-store"
      action={
        <button
          type="button"
          className={`lattice-icon-btn is-tiny${store.busy ? " is-spinning" : ""}`}
          onClick={store.onRefresh}
          title={
            updated
              ? t("Catalogue updated {date} — click to reload", { date: updated })
              : t("Reload the catalogue")
          }
          aria-label={t("Reload the catalogue")}
        >
          <Glyph d={ICON.refresh} size={12} />
        </button>
      }
    >
      {snapshot.notice && (
        <div className="lattice-lib-note is-stale">
          <p className="lattice-lib-note-title">
            {snapshot.notice.kind === "stale" ? t("Showing an older copy") : t("Offline")}
          </p>
          <p className="lattice-hint">{snapshot.notice.message}</p>
          <button type="button" className="lattice-btn is-small" onClick={store.onRefresh}>
            {t("Try again")}
          </button>
        </div>
      )}

      {snapshot.warnings.length > 0 && (
        <details className="lattice-store-warnings">
          <summary>{t("{count} entries were skipped", { count: snapshot.warnings.length })}</summary>
          <ul>
            {snapshot.warnings.slice(0, 8).map((line, index) => (
              <li key={`${line}-${index}`}>{line}</li>
            ))}
          </ul>
        </details>
      )}

      {/*
        订阅了不止一个源时，把每源的读况摊出来：哪个读到了、哪个读不到、哪个关着。
        一个源挂了**只让它自己这行变红** —— 整间商店空白是"我订阅了两个、其中一个
        挂了"最常见的坏结果，也是最没必要的一种。
      */}
      {store.sources.length > 1 && (
        <ul className="lattice-store-sources">
          {store.sources.map((item) => {
            const sourceName = sourceLabel(item);
            return (
              <li key={item.source.id} className={item.error ? "is-bad" : undefined}>
                <span className="lattice-store-source-name">{sourceName}</span>
                <span className="lattice-store-source-note">
                  {!item.source.enabled
                    ? t("Turned off")
                    : item.error
                      ? item.error
                      : t("{count} widgets", { count: item.catalogue?.entries.length ?? 0 })}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {rows.length === 0 && (
        <p className="lattice-hint">
          {tokens.length > 0
            ? t("Nothing in the catalogue matches your search.")
            : t("This catalogue is empty.")}
        </p>
      )}

      {actionable.length > 0 && (
        <div className="lattice-lib-group-head">
          <span className="lattice-lib-group-name">
            {routine ? t("Can be installed") : t("Needs a decision")}
            <span className="lattice-lib-count">{actionable.length}</span>
          </span>
          {/*
            一次装完这一堆。只收 `install` 那几支 —— 更新可能多要权限，
            批量更新等于把"逐条确认"这道闸绕过去，那正是权限变更提示存在的理由。
          */}
          {fresh.length > 1 && (
            <button
              type="button"
              className="lattice-btn is-small"
              disabled={store.busy || batchBusy}
              onClick={async () => {
                setBatchBusy(true);
                try {
                  // 串行：每一条都要走完验签、落盘、刷新，抢着跑只会互相盖状态
                  for (const row of fresh) {
                    await store.onInstall(row.entry, row.plan.pkg, false);
                  }
                } finally {
                  setBatchBusy(false);
                }
              }}
              title={t("Install all {count} widgets at once", { count: fresh.length })}
            >
              {batchBusy ? t("Installing…") : t("Install all")}
            </button>
          )}
        </div>
      )}

      {actionable.map((row) => (
        <CatalogueCard
          key={row.entry.id}
          entry={row.entry}
          plan={row.plan}
          store={store}
          installed={installedIds.has(row.entry.id)}
        />
      ))}

      {/*
        被去重掉的那些已装条目：一行字交代完，不出卡片。
        它们在上面 "Installed" 里各自有一张卡，这里再来一张就是同一个东西说两遍。
      */}
      {quiet.length > 0 && (
        <p className="lattice-store-note lattice-store-quiet">
          {t("Already installed — {versions}.", { versions: versionParts.join(listSep) })}
          {keyNotes.length > 0
            ? `${isZh ? "" : " "}${t(
                changedKey + blockedKey === 1 ? "1 of them has {notes}." : "{count} of them have {notes}.",
                { count: changedKey + blockedKey, notes: keyNotes.join(notesSep) },
              )}`
            : ""}
          {isZh ? "" : " "}
          {t("They are listed under Installed above.")}
        </p>
      )}

      {stuck.length > 0 && (
        <LibSection
          title="Cannot be installed"
          count={stuck.length}
          forceOpen={forceOpen}
          className="is-nested"
        >
          {stuck.map((row) => (
            <CatalogueCard
              key={row.entry.id}
              entry={row.entry}
              plan={row.plan}
              store={store}
              installed={installedIds.has(row.entry.id)}
            />
          ))}
        </LibSection>
      )}
    </LibSection>
  );
}

function CatalogueCard({
  entry,
  plan,
  store,
  installed,
}: {
  entry: CatalogueEntry;
  /** 处置方式由外面算好传进来，见 `CatalogueSection` 里那段注释 */
  plan: InstallPlan;
  store: StoreBinding;
  installed: boolean;
}) {
  const t = useT();
  const text = useText();
  const listSep = useLang() === "zh" ? "、" : ", ";
  const review = store.reviews[entry.id];
  const busy = store.busyId === entry.id;

  const before = store.installedPermissions.get(entry.id) ?? [];
  const added = addedPermissions(before, plan.pkg.permissions);
  const key = entry.publisher?.key ?? "";
  /** 换钥匙那一支里，"旧的那把"是不是已经被拉黑了 —— 拉过就别再给一次按钮 */
  const pinnedBlocked =
    plan.kind === "untrusted" && isBlockedKey(plan.pinned, store.blockedKeys);

  return (
    <div className={`lattice-card is-store${installed ? " is-installed" : ""}`}>
      <div className="lattice-card-top">
        <span className="lattice-card-glyph" aria-hidden>
          {entry.icon ? (
            <img className="lattice-card-glyph-img" src={entry.icon} alt="" width={17} height={17} />
          ) : (
            text(entry.name).trim().slice(0, 1)
          )}
        </span>
        <span className="lattice-card-heading">
          <span className="lattice-card-name">{text(entry.name)}</span>
          <code className="lattice-card-id">{entry.id}</code>
        </span>
        {plan.kind === "blocked" ? (
          <span className="lattice-chip is-warn">{t("Blocked")}</span>
        ) : review ? (
          <span className="lattice-chip is-warn">{t("Review")}</span>
        ) : installed ? (
          <span className="lattice-chip is-accent">{t("Installed")}</span>
        ) : (
          <span className="lattice-chip">{entry.publisher ? t("Signed") : t("Unsigned")}</span>
        )}
      </div>

      <p className="lattice-card-desc">{text(entry.description) || t("No description yet")}</p>

      <div className="lattice-card-meta">
        <span className="lattice-mono">v{plan.pkg.version}</span>
        <span className="lattice-mono">{entry.author}</span>
        {plan.pkg.size > 0 && (
          <span className="lattice-mono">{Math.max(1, Math.round(plan.pkg.size / 1024))} KB</span>
        )}
        {/* 订阅了不止一个源时才标出来源：只有一个源时这枚角标每张卡都一样，纯噪声 */}
        {store.sources.length > 1 && entry.sourceId && (
          <span className="lattice-mono">{store.sourceLabels[entry.sourceId] ?? entry.sourceId}</span>
        )}
      </div>

      {/*
        同 id 被两个源提供时说一句。**不静默**：两个源里的同 id 是两段代码、两把钥匙，
        用户得知道另有一份 —— 但也不能让他以为可以"挑一个装"（安装只看生效的那份）。
      */}
      {entry.alsoIn && entry.alsoIn.length > 0 && (
        <p className="lattice-store-note">
          {t("Another source also offers it: {names}. This card uses the one above it in the list.", {
            names: entry.alsoIn.join(listSep),
          })}
        </p>
      )}

      {plan.pkg.permissions.length > 0 && (
        <div className="lattice-perm-list">
          {plan.pkg.permissions.map((permission) => (
            <span
              key={permission}
              className={`lattice-perm${added.includes(permission) ? " is-new" : ""}`}
              title={
                added.includes(permission)
                  ? t("This version asks for a permission you have not granted")
                  : undefined
              }
            >
              {permissionLabel(permission)}
            </span>
          ))}
        </div>
      )}

      {key && (
        <p className="lattice-store-key" title={`ed25519 ${key}`}>
          {t("Signed by {name} · {fingerprint}", {
            name: entry.publisher?.name ?? "",
            fingerprint: keyFingerprint(key),
          })}
        </p>
      )}

      <div className="lattice-card-actions">
        {plan.kind === "install" && (
          <button
            type="button"
            className="lattice-btn is-small is-primary"
            disabled={busy}
            onClick={() => store.onInstall(entry, plan.pkg, false)}
          >
            {busy ? t("Installing…") : t("Install")}
          </button>
        )}

        {plan.kind === "update" && (
          <button
            type="button"
            className="lattice-btn is-small is-primary"
            disabled={busy}
            onClick={() => store.onInstall(entry, plan.pkg, false)}
            title={
              added.length > 0
                ? t("This update asks for {permissions}", {
                    permissions: added.map((item) => permissionLabel(item)).join(listSep),
                  })
                : undefined
            }
          >
            {busy ? t("Updating…") : t("Update to {version}", { version: plan.pkg.version })}
          </button>
        )}

        {plan.kind === "current" && (
          <span className="lattice-store-note">
            {installed ? t("Up to date") : t("Already installed ({version})", { version: plan.pkg.version })}
          </span>
        )}

        {/*
          目录比本地旧。以前这一支混在 `Up to date` 里 —— 那句话在
          "我有 1.0.0、目录只到 0.9.0" 的时候是假的。这里不提供任何按钮：
          降级是个需要人明确说"我知道"的动作，不该长成一颗随手能点的按钮。
        */}
        {plan.kind === "older" && (
          <span className="lattice-store-note">
            {t("The catalogue only has {version} — you have {installed}. Nothing to do.", {
              version: plan.pkg.version,
              installed: plan.installed,
            })}
          </span>
        )}

        {plan.kind === "blocked" && (
          <div className="lattice-store-trust">
            <span className="lattice-store-note is-warn">
              {t("You blocked this publisher key ({fingerprint}). Nothing signed with it will be installed.", {
                fingerprint: keyFingerprint(plan.key),
              })}
            </span>
            <button
              type="button"
              className="lattice-btn is-small"
              onClick={() => store.onUnblockKey(plan.key)}
            >
              {t("Unblock this key")}
            </button>
          </div>
        )}

        {plan.kind === "unsigned" && (
          <span className="lattice-store-note is-warn">
            {t("No publisher signature — this catalogue entry cannot be installed")}
          </span>
        )}

        {plan.kind === "untrusted" && (
          <div className="lattice-store-trust">
            <span className="lattice-store-note is-warn">
              {t("Publisher key changed: was {old}, now {new}.", {
                old: keyFingerprint(plan.pinned),
                new: keyFingerprint(plan.offered),
              })}
            </span>
            <button
              type="button"
              className="lattice-btn is-small is-danger"
              disabled={busy}
              onClick={() => store.onInstall(entry, plan.pkg, true)}
            >
              {t("Trust the new key and install")}
            </button>
            {/*
              换钥匙是"私钥泄露"最像的样子：旧钥匙还在本地被钉着，而它可能已经
              在别人手上。所以这个对话框里要有一条"旧的那把别再用了"的路 ——
              点完之后这把钥匙进拉黑名单，将来哪怕它又签了什么，也装不进来。
            */}
            {pinnedBlocked ? (
              <span className="lattice-store-note">{t("The old key is blocked — it can no longer ship to you.")}</span>
            ) : (
              <button
                type="button"
                className="lattice-btn is-small"
                onClick={() => store.onBlockKey(plan.pinned)}
                title={t("Stop trusting the previous key entirely — use this if it may have leaked")}
              >
                {t("Block the old key instead")}
              </button>
            )}
          </div>
        )}
      </div>

      {plan.kind === "update" && added.length > 0 && (
        <p className="lattice-store-note is-warn">
          {t("Adds {permissions} — you will be asked to allow it.", {
            permissions: added.map((item) => permissionLabel(item)).join(listSep),
          })}
        </p>
      )}
    </div>
  );
}
