#!/usr/bin/env bash
# 用本机 Chrome / Edge headless 把 SVG 渲染成各尺寸 PNG（透明背景）。
# 路径全部相对脚本自身，可从任意目录调用：bash design/logo/render.sh
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$DIR/png"
mkdir -p "$OUT"

CHROME="${CHROME:-}"
if [ -z "$CHROME" ]; then
  for c in \
    "/c/Program Files/Google/Chrome/Application/chrome.exe" \
    "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"; do
    [ -x "$c" ] && CHROME="$c" && break
  done
fi
if [ -z "$CHROME" ]; then
  echo "找不到 Chrome / Edge，可用 CHROME=/path/to/browser 指定" >&2
  exit 1
fi

# Chrome 只认 Windows 路径，转一次
winpath() { cygpath -m "$1" 2>/dev/null || echo "$1"; }

fail=0
render() { # $1=svg 文件名  $2=边长px  $3=输出名
  local svg="$1" s="$2" name="$3" wrap="$DIR/.wrap.html"
  cat > "$wrap" <<HTML
<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}
img{display:block;width:${s}px;height:${s}px}</style>
<img src="$svg">
HTML
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-sandbox \
    --force-device-scale-factor=1 --default-background-color=00000000 \
    --window-size="$s,$s" --screenshot="$(winpath "$OUT/$name.png")" \
    "file:///$(winpath "$wrap")" >/dev/null 2>&1
  if [ -s "$OUT/$name.png" ]; then
    echo "  $name.png  ${s}x${s}"
  else
    echo "  FAILED: $name" >&2
    fail=1
  fi
}

echo "app icon:"
for s in 1024 512 256 128 64 48 32 24 16; do render "lattice-appicon.svg" "$s" "appicon-$s"; done
echo "dark:"
render "lattice-appicon-dark.svg" 512 "appicon-dark-512"
echo "mark (transparent):"
render "lattice-mark.svg" 1024 "mark-1024"
render "lattice-mark.svg" 512 "mark-512"
echo "mono:"
render "lattice-mark-small.svg" 256 "mark-mono-256"
render "lattice-mark-small.svg" 32 "mark-mono-32"

echo "sheet:"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-sandbox \
  --force-device-scale-factor=2 --window-size=1140,900 \
  --screenshot="$(winpath "$OUT/_sheet.png")" \
  "file:///$(winpath "$DIR/preview.html")" >/dev/null 2>&1
[ -s "$OUT/_sheet.png" ] && echo "  _sheet.png" || { echo "  FAILED: _sheet" >&2; fail=1; }

rm -f "$DIR/.wrap.html"
[ "$fail" -eq 0 ] && echo "done" || { echo "有失败项" >&2; exit 1; }
