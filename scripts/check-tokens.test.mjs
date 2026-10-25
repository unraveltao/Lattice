/**
 * 检查器自己的断言（`npm run test:tokens`，不需要 dev server）。
 *
 * 守门人要是漏检，比没有守门人更糟 —— 它会让人以为规矩还在。所以这里既钉
 * 规则本身（半像素 / 非白名单圆角 / 奇数间距 / 豁免），也钉"仓库现状是干净的"
 * 这一条：`npm run check:tokens` 忘挂了也不要紧，这条会红。
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { collectFiles, inspect } from "./check-tokens.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const violations = (css) => inspect(css);
const reasons = (css) => violations(css).map((item) => item.reason);

test("五档字号与六档圆角、偶数间距都放过", () => {
  const css = `
.a {
  font-size: 11px;
  border-radius: 12px;
  padding: 8px 12px;
  margin: -1px;
  gap: var(--lattice-heat-gap);
}
`;
  assert.deepEqual(violations(css), []);
});

test("半像素字号要报 —— 100% 缩放下取整不一致，中文会发虚", () => {
  for (const size of ["9px", "10px", "10.5px", "11.5px", "12.5px", "14px", "16px"]) {
    const found = violations(`.a {\n  font-size: ${size};\n}`);
    assert.equal(found.length, 1, `${size} 应该被报`);
    assert.match(found[0].reason, /字号只有/);
    assert.equal(found[0].line, 2, "行号要对得上，否则改了也没法定位");
  }
});

test("藏在 font 简写里的字号也要报", () => {
  const found = violations(`.a {\n  font: 11.5px/1.45 ui-sans-serif, system-ui, sans-serif;\n}`);
  assert.equal(found.length, 1);
  assert.match(found[0].reason, /font 简写/);

  assert.deepEqual(violations(`.a {\n  font: 12px/1.45 ui-sans-serif;\n}`), []);
});

test("圆角只认那几档", () => {
  for (const radius of ["5px", "9px", "18px", "20px"]) {
    const found = violations(`.a {\n  border-radius: ${radius};\n}`);
    assert.equal(found.length, 1, `${radius} 应该被报`);
  }
  // 多值写法逐个查：三个合法值不能掩盖一个非法值
  const mixed = violations(`.a {\n  border-radius: 10px 10px 9px 10px;\n}`);
  assert.equal(mixed.length, 1);
  assert.match(mixed[0].value, /9px/);

  assert.deepEqual(violations(`.a {\n  border-radius: 10px 10px 2px 10px;\n}`), []);
  assert.deepEqual(violations(`.a {\n  border-radius: 50%;\n}`), []);
});

test("奇数间距要报，负值和算出来的值不报", () => {
  for (const value of ["7px", "3px", "9px 11px", "0 5px"]) {
    const found = violations(`.a {\n  padding: ${value};\n}`);
    assert.equal(found.length, 1, `${value} 应该被报`);
  }
  assert.deepEqual(violations(`.a {\n  margin: -3px;\n}`), [], "负边距是刻意的重叠");
  assert.deepEqual(violations(`.a {\n  gap: calc(50% - 0.5px);\n}`), []);
  assert.deepEqual(violations(`.a {\n  margin: 0 auto;\n}`), []);
});

test("注释里的值不算数 —— 文档里写 10.5px 不该红", () => {
  const css = `
/*
 * 以前这里写过 font-size: 10.5px;
 * 也写过 border-radius: 9px;
 */
.a {
  font-size: 12px;
}
`;
  assert.deepEqual(violations(css), []);
});

test("行尾 token-ok 可以豁免，但必须写理由", () => {
  const withReason = `.a {\n  margin: 7px; /* token-ok 16px 图标在 30px 格子里居中 */\n}`;
  assert.deepEqual(violations(withReason), []);

  const noReason = `.a {\n  margin: 7px; /* token-ok */\n}`;
  const found = violations(noReason);
  assert.equal(found.length, 1);
  assert.match(found[0].reason, /要写理由/);
});

test("仓库现状是干净的", () => {
  const files = collectFiles(join(root, "src"));
  assert.ok(files.length > 0, "src 下应该有样式文件");

  const dirty = files.flatMap((file) =>
    inspect(readFileSync(file, "utf8")).map((item) => `${file}:${item.line} ${item.prop}: ${item.value}`),
  );
  assert.deepEqual(dirty, [], `越界的值：\n${dirty.join("\n")}`);
});
