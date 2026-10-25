/**
 * 档案页的组件级检查。
 *
 * 纯逻辑在 `tests/usage.html` 里；这一页验的是"接线"：
 *   - 没档案时只有创建入口，有档案时只有编辑 + Sign out（不能两个都在）
 *   - 热力图画出来的是 53 × 7，未来的格子不冒充 0
 *   - 统计、危险区的位置和回调有没有真的接上
 *
 * 这些都属于"纯函数对了、界面还是不对"那一类，纯函数测试一条都抓不到。
 */

import { createRoot } from "react-dom/client";
import { act } from "react";
import "../src/styles.css";
import { ProfilePanel } from "../src/platform/ProfilePanel";
import { setLanguage } from "../src/runtime/i18n";
import { dayKey, type UsageData } from "../src/runtime/usage";
import type { Profile } from "../src/platform/store";

setLanguage("en");

const lines: string[] = [];
const log = (pass: boolean, text: string) => lines.push((pass ? "PASS " : "FAIL ") + text);
const eq = (actual: unknown, expected: unknown, text: string) =>
  log(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${text}（得到 ${JSON.stringify(actual)}）`,
  );
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const root = createRoot(document.getElementById("stage")!);

const PROFILE: Profile = {
  name: "Alex",
  email: "alex@example.com",
  since: "2026-01-02T00:00:00.000Z",
};

function usageWith(days: Record<string, number>): UsageData {
  return {
    days,
    totalMinutes: Object.values(days).reduce((sum, minutes) => sum + minutes, 0),
    since: Object.keys(days).sort()[0] ?? null,
  };
}

interface Handles {
  saved: Array<[string, string]>;
  signedOut: number;
  cleared: number;
}

function render(
  overrides: Partial<Parameters<typeof ProfilePanel>[0]> = {},
): Handles {
  const handles: Handles = { saved: [], signedOut: 0, cleared: 0 };
  const props = {
    profile: PROFILE,
    installedCount: 4,
    placementCount: 2,
    usage: usageWith({}),
    onSave: (name: string, email: string) => handles.saved.push([name, email]),
    onSignOut: () => {
      handles.signedOut += 1;
    },
    onClearUsage: () => {
      handles.cleared += 1;
    },
    ...overrides,
  };
  act(() => {
    root.render(<ProfilePanel {...props} />);
  });
  return handles;
}

const text = (selector: string) =>
  document.querySelector<HTMLElement>(selector)?.textContent?.trim() ?? "";
const buttonByText = (label: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === label,
  ) ?? null;

async function main() {
  const today = new Date();
  const todayKey = dayKey(today);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const yesterdayKey = dayKey(yesterday);

  // ---- 1. 有档案：资料、统计、编辑入口 ----
  const usage = usageWith({ [yesterdayKey]: 30, [todayKey]: 60, [dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 5))]: 15 });
  render({ usage });
  await sleep(60);

  log(text(".lattice-profile-name") === "Alex", "显示档案名");
  log(text(".lattice-profile-sub").includes("alex@example.com"), "显示邮箱");
  log(text(".lattice-profile-sub").includes("Member since"), "显示加入时间");
  eq(
    [...document.querySelectorAll(".lattice-stat b")].map((node) => node.textContent),
    ["3", "2", "1h 45m", "2", "4"],
    "统计：活跃 3 / 连续 2 / 1h45m / 画布 2 / 已装 4",
  );
  log(buttonByText("Edit profile") !== null, "有编辑入口");
  log(buttonByText("Create local profile") === null, "有档案时不再出现创建入口");
  log(text(".lattice-profile").includes("Sign out"), "Sign out 在页面上");

  // ---- 2. 热力图形状 ----
  const columns = [...document.querySelectorAll(".lattice-heatmap-column")];
  eq(columns.length, 53, "热力图 53 列");
  log(columns.every((column) => column.querySelectorAll(".lattice-heatmap-cell").length === 7), "每列 7 格");
  eq(document.querySelectorAll(".lattice-heatmap-grid .lattice-heatmap-cell").length, 53 * 7, "一共 371 格");
  eq(text(".lattice-heatmap-grid"), "", "格子本身不带文字（信息在 title 里）");

  const dayLabel = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(today);
  const todayCell = [...document.querySelectorAll<HTMLElement>(".lattice-heatmap-cell")].find(
    (cell) => cell.title === `${dayLabel} · 1h`,
  );
  log(Boolean(todayCell), "今天的格子找得到");
  eq(todayCell?.dataset.level, "3", "今天 60 分钟是第三档");

  // 未来的格子：本周剩下的天数，一天不少
  const weekday = (today.getDay() + 6) % 7;
  eq(
    document.querySelectorAll(".lattice-heatmap-grid .lattice-heatmap-cell[data-future='true']").length,
    6 - weekday,
    "今天之后到周日都标成未来",
  );

  // ---- 3. 空记录不画假历史 ----
  render({ usage: usageWith({}) });
  await sleep(60);
  log(text(".lattice-profile").includes("No activity yet"), "空记录写清楚从今天开始");
  eq(text(".lattice-stat b"), "0", "空记录活跃天数是 0");

  // ---- 4. 编辑资料真的接上了回调 ----
  const handles = render({ profile: PROFILE });
  await sleep(60);
  const edit = buttonByText("Edit profile");
  act(() => edit?.click());
  await sleep(40);

  const nameInput = document.querySelector<HTMLInputElement>(".lattice-profile-form input");
  log(nameInput?.value === "Alex", "编辑表单带出当前名字");
  if (nameInput) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(nameInput, "Alex Chen");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  act(() => buttonByText("Save")?.click());
  await sleep(40);
  eq(handles.saved, [["Alex Chen", "alex@example.com"]], "保存把名字交给 store");

  // ---- 5. 危险区：清楚记录要二次确认，Sign out 单独一颗 ----
  const dangerHandles = render({ usage });
  await sleep(60);
  const danger = document.querySelector(".lattice-profile-danger");
  log(danger !== null, "危险区存在");
  eq(danger?.parentElement?.lastElementChild === danger, true, "危险区是档案页的最后一个孩子");

  act(() => buttonByText("Clear usage history")?.click());
  await sleep(40);
  log(text(".lattice-profile-danger").includes("Clear the local activity record?"), "清除记录先问一次");
  act(() => buttonByText("Clear")?.click());
  await sleep(40);
  eq(dangerHandles.cleared, 1, "确认后清空只调一次");

  act(() => buttonByText("Sign out")?.click());
  eq(dangerHandles.signedOut, 1, "Sign out 接上了回调");

  // ---- 6. 没有档案：这一页就是创建入口 ----
  const emptyHandles = render({ profile: null });
  await sleep(60);
  log(text(".lattice-profile").includes("No profile yet"), "空档案有标题");
  log(text(".lattice-profile").includes("Stored on this computer only"), "写着只保存在本机");
  const create = buttonByText("Create local profile");
  log(create !== null && create.disabled, "名字没填时创建按钮是灰的");
  const emptyInput = document.querySelector<HTMLInputElement>(".lattice-profile-form input");
  if (emptyInput) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(emptyInput, "Nova");
      emptyInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  await sleep(40);
  const createNow = buttonByText("Create local profile");
  log(createNow !== null && !createNow.disabled, "填了名字就能创建");
  act(() => createNow?.click());
  await sleep(40);
  eq(emptyHandles.saved, [["Nova", ""]], "创建也走同一个保存回调");

  const out = document.getElementById("out")!;
  out.innerHTML = lines
    .map((line) => `<span class="${line.startsWith("PASS") ? "ok" : "bad"}">${line}</span>`)
    .join("\n");
  (window as unknown as { __done: boolean }).__done = true;
}

void main();
