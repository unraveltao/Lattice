# Lattice / 棂 — logo

3×3 窗棂：一个"可以往里装东西的框"。落位的格子（左列 + 底行）拼出字母 **L**。

## 几何（唯一真源，改这里就够）

画布 512×512，外框落在 88..424：

| 量 | 值 |
| --- | --- |
| 外框边长 | 336 |
| 竖/横条宽 | 30 |
| 格（空位）边长 | 72 |
| 条位置（竖） | x = 88 / 190 / 292 / 394 |
| 条位置（横） | y = 88 / 190 / 292 / 394 |
| 格位置 | 118 / 220 / 322 |
| 圆角（app icon 底板） | 112 |

验证：88 + 30 + 72 + 30 + 72 + 30 + 72 + 30 = 424 ✓

**别用图像模型重画这张图**——等分几何它画不准（试过，线条会歪、格子大小不一）。要改就改 SVG 里的数字。

## 颜色

取自 `src/styles.css` 的变量，不要另起一套：

| 用途 | 亮色 | 暗色 |
| --- | --- | --- |
| 窗棂 / 条 | `#0F6E56`（`--lattice-accent`） | `#5DCAA5`（暗色 `--lattice-accent`） |
| 落位的格子 | `#5DCAA5` | `#CFF5E6` |
| 底板 | `#F4F1E8` | `#17171D`（`--lattice-surface` 系） |

## 文件

| 文件 | 用途 |
| --- | --- |
| `lattice-appicon.svg` | 主标，圆角底板，512 |
| `lattice-appicon-dark.svg` | 暗色底板 |
| `lattice-mark.svg` | 透明底，只有图形 |
| `lattice-mark-small.svg` | 单色 2×2 简化版，16–24px / 托盘用 |
| `lattice-lockup.svg` | 横版：标 + `lattice` 字标（字标是占位排版） |
| `lattice-appicon-a.svg` / `-alt-b.svg` | 备选，未采用 |
| `lattice.ico` | Windows 图标，内嵌 16/24/32/48/64/128/256 |
| `png/` | 各尺寸位图，`_sheet.png` 是方案对比图 |
| `preview.html` | 对比页，`render.sh` 会把它截成 `png/_sheet.png` |

## 重新生成

```bash
bash design/logo/render.sh                       # SVG → png/（用本机 Chrome headless）
python design/logo/make_ico.py                   # png/ → lattice.ico
```

## 换掉 Tauri 自带的占位图标

```bash
npm run tauri icon design/logo/png/appicon-1024.png
```

会重写 `src-tauri/icons/` 整个目录（含 `icon.icns`）。跑之前先确认 `.icns` 那套也要换。
