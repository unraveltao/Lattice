/**
 * 组件回收站：留多久、留几份、"这条还能不能恢复"。
 *
 * # 为什么要有它
 *
 * 删一个组件的地方有两颗 ✕（宿主页窗饰上的、画布卡片上的），它们都是**不可逆**
 * 删除，而 ✕ 只有 22×22、还挂在会淡入的窗饰上 —— 手滑一次，用户摆好的布局就少
 * 一块。原来的兜底是主窗口底部那条 8 秒 `Undo`：够快，但只够快 —— 你点了别的
 * 东西、或者正好没看着屏幕，那 8 秒就过去了，之后没有任何地方能把它找回来。
 *
 * 所以删除分两步走：**8 秒撤销条照旧**（手滑当场救回来），**同时留一条快照进
 * 回收站**（事后还能找）。这条快照是用户数据，跟着 `state.json` 落盘。
 *
 * # 三条边界（都是刻意的）
 *
 * - **只留最近 20 条、7 天**。这不是一个"归档"功能：它回答的是"我刚才删错了"，
 *   而不是"我三个月前删过什么"。留得越久，用户越会把它当备份，而它不是 ——
 *   恢复回来不会跨机器，也不留组件的私有数据。
 * - **同一个实例只有一个坑位**。删了、恢复、又删，回收站里还是那一条（时间是
 *   最后一次删的时刻）。列表里出现好几张一模一样的卡，等于让用户猜哪张是真的。
 * - **恢复要求组件还装着**。摆放的 widgetId 那个包被卸载之后再恢复，画布上会是
 *   一张"组件不见了"的破卡 —— 那不是恢复，是给用户添一个坏东西。这一条由
 *   `canRestore` 说，界面据此把恢复按钮按灰并写清原因（只留删除）。
 *
 * # 这一份是"形状"，不是又一份快照
 *
 * 条目本身就是 `store.ts` 的 `ClosedPlacement`（摆放 + 桌面矩形 + 配置 + 时刻）：
 * 恢复需要的东西和撤销需要的是同一组，存两套只会两边走歪。所以这里只要求结构上
 * 有 `placement.instanceId` / `placement.widgetId` / `at` 三样 —— 判据够用，
 * 而落盘的那份仍由 store 定义。
 *
 * 这个文件里没有 React、没有 store、也没有 `t()`：判据全在纯函数里，
 * `tests/trash.html` 直接跑。
 */

/** 判据只需要这三样。`ClosedPlacement` 结构上满足它，所以不用拷一份 */
export interface TrashEntry {
  placement: { instanceId: string; widgetId: string };
  /** 删除发生的时刻（毫秒），留着算年龄与过期 */
  at: number;
}

/** 最多留 20 条。再多就不是"刚才删错了"，而是拿回收站当备份 */
export const TRASH_LIMIT = 20;

/** 留 7 天。理由同上：它回答的是"刚才"，不是"上个月" */
export const TRASH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 把过期的裁掉，再只留最近 `TRASH_LIMIT` 条。
 *
 * 入参**按新到旧**排好（`pushTrash` 就是这么放的），所以 `slice` 丢的是最老的。
 * `at` 在未来的条目（机器时钟往回跳过）一律留下 —— 那条只是"时间戳不可信"，
 * 不该因此把用户的东西丢掉。
 */
export function pruneTrash<T extends TrashEntry>(list: readonly T[], now: number): T[] {
  return list.filter((item) => now - item.at < TRASH_TTL_MS).slice(0, TRASH_LIMIT);
}

/**
 * 放进回收站：新的在最前，同一个实例的老条目被顶掉，顺手做一次裁剪。
 *
 * `now` 由调用方给（store 传 `Date.now()`，测试传常量）：这个模块不读时钟，
 * 否则断言就只能靠"跑得够快"。
 */
export function pushTrash<T extends TrashEntry>(list: readonly T[], item: T, now: number): T[] {
  const { instanceId } = item.placement;
  const rest = list.filter((entry) => entry.placement.instanceId !== instanceId);
  return pruneTrash([item, ...rest], now);
}

/** 从回收站拿掉一条（恢复成功、或者用户点删） */
export function dropTrash<T extends TrashEntry>(list: readonly T[], instanceId: string): T[] {
  return list.filter((entry) => entry.placement.instanceId !== instanceId);
}

/**
 * 这条还能不能恢复：组件还装着才行。
 *
 * 判据是"装上"（`installedIds`），不是"发现得到"：可安装那一段里的包还没装，
 * 恢复出来同样是一张破卡。卸载之后用户要做的第一件事是重新装，不是恢复。
 */
export function canRestore(item: TrashEntry, installedIds: ReadonlySet<string>): boolean {
  return installedIds.has(item.placement.widgetId);
}
