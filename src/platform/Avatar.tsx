import { Glyph, ICON } from "./icons";

/**
 * 头像：一个字母 + 主题色圆角方块。
 *
 * 顶栏的齿轮、设置里的身份块、档案页共用这一个 —— 三处各画一份的话，
 * 名字里的 emoji、大小写、空名字的处理迟早会分叉。
 */
export function Avatar({ name, size }: { name?: string; size: number }) {
  const initial = name?.trim().slice(0, 1).toUpperCase();
  const style = { width: size, height: size, fontSize: Math.round(size * 0.4) };
  if (!initial) {
    return (
      <span className="lattice-avatar is-empty" style={style} aria-hidden="true">
        <Glyph d={ICON.user} size={Math.round(size * 0.5)} />
      </span>
    );
  }
  return (
    <span className="lattice-avatar" style={style} aria-hidden="true">
      {initial}
    </span>
  );
}
