/**
 * 组件库的搜索：把一句查询变成"这个包要不要显示"。
 *
 * 单独成文件而不是写在 `LibraryPanel.tsx` 里，是因为它是**纯函数**：
 * 没有 React、没有 DOM、没有清单校验，所以 `tests/library-search.html`
 * 能直接 import 它跑断言。搜索的边界（大小写、空格、多词、空查询）
 * 全在下面这几行，别在组件里再写一遍。
 */

import { PERMISSION_LABELS, permissionLabel, type Permission } from "./manifest";
import { textVariants, type LocalizedText } from "./widget-text";

/** 只需要清单里的这几项，测试里给个对象就能跑 */
export interface SearchableWidget {
  manifest: {
    name: LocalizedText;
    id: string;
    description: LocalizedText;
    author: string;
    permissions: Permission[];
  };
}

/**
 * 切成词。空白（含全角空格）都算分隔符，连续空白不产生空词。
 *
 * 多词是"都要命中"（AND），不是"命中一个就行"：搜 `clock 24` 的人是想在时钟里
 * 找 24 小时制那项，把整个库都倒出来对他没用。
 */
export function tokenize(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * 搜什么：名字、id、描述、作者、权限名。
 *
 * 权限也算进去是有意的 —— "哪个组件能读系统指标"、"哪些要联网" 是真实问题，
 * 而权限恰好就写在卡片上，搜不到反而奇怪。
 *
 * 权限名**中英各放一份**：英文名是 `PERMISSION_LABELS`（测试钉着它），
 * 另一份按当前界面语言取 —— 中文界面下搜"网络"要能命中要联网的包，
 * 而英文查询的结果不能被多出来的中文名改变。
 *
 * 作者写的名字 / 描述**所有语言各放一份**（`textVariants`）：用户不记得自己
 * 当初看到的是哪一门，打"鲸鱼"要能搜到大肥鱼，打 "whale" 也要能。
 *
 * 空词表（也就是空查询）**一律命中**：那是"没在搜"，不是"什么都不要"。
 */
export function matchesWidget(record: SearchableWidget, tokens: string[]): boolean {
  if (tokens.length === 0) return true;

  const haystack = [
    ...textVariants(record.manifest.name),
    record.manifest.id,
    ...textVariants(record.manifest.description),
    record.manifest.author,
    ...record.manifest.permissions.flatMap((permission) => [
      PERMISSION_LABELS[permission] ?? permission,
      permissionLabel(permission),
    ]),
  ]
    .join(" ")
    .toLowerCase();

  return tokens.every((token) => haystack.includes(token));
}
