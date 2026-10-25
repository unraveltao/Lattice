/**
 * 档案页：这台电脑上的"我"，以及一张使用热力图。
 *
 * 三件事必须一直清楚：
 *   1. **不是账号**。没有服务端，名字和邮箱只写进 `state.json`；每一处
 *      "登录"的措辞旁边都要能看到"只保存在这台电脑"。
 *   2. **热力图是本机记录**。Rust 按"有没有 Lattice 窗口在前台"数分钟数，
 *      不上传，也不进 agent 快照。清掉它不该动档案。
 *   3. **没有历史就不画假历史**。第一次打开时整张图是空的，文案写明
 *      "从今天开始记录"，而不是先填几格让页面看起来热闹。
 */
import { useState } from "react";

import { lang, useT } from "../runtime/i18n";
import {
  activeDays,
  buildHeatmap,
  currentStreak,
  describeMinutes,
  fromDayKey,
  type UsageData,
} from "../runtime/usage";
import type { Profile } from "./store";
import { Avatar } from "./Avatar";

interface ProfilePanelProps {
  profile: Profile | null;
  installedCount: number;
  placementCount: number;
  usage: UsageData;
  onSave: (name: string, email: string) => void;
  onSignOut: () => void;
  onClearUsage: () => void;
}

function locale(): string {
  return lang() === "en" ? "en-US" : "zh-CN";
}

/**
 * 一年 × 星期的方格。行是周一 → 周日，列是周。
 *
 * 每一格的颜色只由分钟数决定（`levelFor`），不由"今年用得比去年多"决定 ——
 * 否则同一张图里深浅的含义会随年份变。未来的格子留白，不画成 0。
 */
export function UsageHeatmap({ days, today }: { days: Record<string, number>; today: Date }) {
  const t = useT();
  const language = lang();
  const weeks = buildHeatmap(days, today);
  const monthFormat = new Intl.DateTimeFormat(locale(), { month: "short" });
  const dayFormat = new Intl.DateTimeFormat(locale(), { month: "short", day: "numeric" });

  return (
    <div className="lattice-heatmap">
      <div
        className="lattice-heatmap-months"
        style={{ gridTemplateColumns: `repeat(${weeks.length}, var(--lattice-heat-cell))` }}
        aria-hidden="true"
      >
        {weeks.map((week, index) => {
          const date = week.monthStart ? fromDayKey(week.monthStart) : null;
          return (
            <span key={index} style={{ gridColumn: index + 1 }}>
              {date ? monthFormat.format(date) : ""}
            </span>
          );
        })}
      </div>

      <div className="lattice-heatmap-body">
        <div className="lattice-heatmap-weekdays" aria-hidden="true">
          <span>{t("Mon")}</span>
          <span />
          <span>{t("Wed")}</span>
          <span />
          <span>{t("Fri")}</span>
          <span />
          <span />
        </div>

        <div
          className="lattice-heatmap-grid"
          role="img"
          aria-label={t("Daily activity over the last year")}
        >
          {weeks.map((week, weekIndex) => (
            <div className="lattice-heatmap-column" key={weekIndex}>
              {week.cells.map((cell) => {
                const date = fromDayKey(cell.date);
                const label = date ? dayFormat.format(date) : cell.date;
                return (
                  <span
                    key={cell.date}
                    className="lattice-heatmap-cell"
                    data-level={cell.level}
                    data-future={cell.future ? "true" : undefined}
                    title={
                      cell.future
                        ? undefined
                        : `${label} · ${describeMinutes(cell.minutes, language)}`
                    }
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <div className="lattice-heatmap-legend" aria-hidden="true">
        <span>{t("Less")}</span>
        {[0, 1, 2, 3, 4].map((level) => (
          <span key={level} className="lattice-heatmap-cell" data-level={level} />
        ))}
        <span>{t("More")}</span>
      </div>
    </div>
  );
}

/**
 * 没有档案时的创建表单。
 *
 * 单独一个组件，是为了让它在"刚退出登录"时**重新挂载**：草稿状态留在
 * 上一个组件实例里的话，退出之后表单还显示着上一个人的名字和邮箱。
 * 用 `key` 强制重置也行，但独立组件连"两套草稿"都不存在，更直接。
 */
function CreateProfileForm({ onSave }: { onSave: (name: string, email: string) => void }) {
  const t = useT();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    onSave(trimmed, email.trim());
  };

  return (
    <form className="lattice-profile-form" onSubmit={submit}>
      <label className="lattice-textfield">
        <span>{t("Display name")}</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t("What should we call you?")}
          maxLength={24}
          autoFocus
        />
      </label>
      <label className="lattice-textfield">
        <span>{t("Email (optional)")}</span>
        <input
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          inputMode="email"
          maxLength={64}
        />
      </label>
      <p className="lattice-account-hint">
        {t(
          "Stored on this computer only. Nothing is uploaded, no password needed, and it is removed with the rest of the platform data.",
        )}
      </p>
      <div className="lattice-profile-form-actions">
        <button type="submit" className="lattice-btn is-small is-primary" disabled={!name.trim()}>
          {t("Create local profile")}
        </button>
      </div>
    </form>
  );
}

export function ProfilePanel({
  profile,
  installedCount,
  placementCount,
  usage,
  onSave,
  onSignOut,
  onClearUsage,
}: ProfilePanelProps) {
  const t = useT();
  const language = lang();
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(profile?.name ?? "");
  const [draftEmail, setDraftEmail] = useState(profile?.email ?? "");
  const [confirmClear, setConfirmClear] = useState(false);

  const today = new Date();
  const days = usage.days;
  const streak = currentStreak(days, today);
  const active = activeDays(days);

  const startEdit = () => {
    setDraftName(profile?.name ?? "");
    setDraftEmail(profile?.email ?? "");
    setEditing(true);
  };

  const sinceDate = profile?.since ? new Date(profile.since) : null;
  const since =
    sinceDate && !Number.isNaN(sinceDate.getTime())
      ? new Intl.DateTimeFormat(locale(), { year: "numeric", month: "long" }).format(sinceDate)
      : null;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const name = draftName.trim();
    if (!name) return;
    onSave(name, draftEmail.trim());
    setEditing(false);
  };

  /*
   * 没有档案时，这一页就是创建入口 —— 导航里不再并列一个 "Sign in" 和
   * 一个 "Profile"。表单直接摊开，少一次点击。
   */
  if (!profile) {
    return (
      <div className="lattice-profile">
        <header className="lattice-profile-head is-empty">
          <Avatar size={48} />
          <div>
            <h3 className="lattice-profile-name">{t("No profile yet")}</h3>
            <p className="lattice-profile-sub">
              {t("Give this computer a name. Nothing leaves it.")}
            </p>
          </div>
        </header>

        <CreateProfileForm onSave={onSave} />
      </div>
    );
  }

  return (
    <div className="lattice-profile">
      <header className="lattice-profile-head">
        <Avatar name={profile.name} size={48} />
        <div className="lattice-profile-id">
          <h3 className="lattice-profile-name">{profile.name}</h3>
          <p className="lattice-profile-sub">
            {profile.email || t("Local profile")}
            {since ? ` · ${t("Member since {date}", { date: since })}` : ""}
          </p>
        </div>
        {!editing && (
          <button type="button" className="lattice-btn is-small" onClick={startEdit}>
            {t("Edit profile")}
          </button>
        )}
      </header>

      {editing ? (
        <form className="lattice-profile-form" onSubmit={submit}>
          <label className="lattice-textfield">
            <span>{t("Display name")}</span>
            <input
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              placeholder={t("What should we call you?")}
              maxLength={24}
              autoFocus
            />
          </label>
          <label className="lattice-textfield">
            <span>{t("Email (optional)")}</span>
            <input
              value={draftEmail}
              onChange={(event) => setDraftEmail(event.target.value)}
              placeholder="you@example.com"
              inputMode="email"
              maxLength={64}
            />
          </label>
          <p className="lattice-account-hint">
            {t(
              "Stored on this computer only. Nothing is uploaded, no password needed, and it is removed with the rest of the platform data.",
            )}
          </p>
          <div className="lattice-profile-form-actions">
            <button type="button" className="lattice-btn is-small" onClick={() => setEditing(false)}>
              {t("Cancel")}
            </button>
            <button type="submit" className="lattice-btn is-small is-primary" disabled={!draftName.trim()}>
              {t("Save")}
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="lattice-profile-stats">
            <div className="lattice-stat">
              <b>{active}</b>
              <span>{t("Active days")}</span>
            </div>
            <div className="lattice-stat">
              <b>{streak}</b>
              <span>{t("Day streak")}</span>
            </div>
            <div className="lattice-stat">
              <b>{describeMinutes(usage.totalMinutes, language)}</b>
              <span>{t("Total time")}</span>
            </div>
            <div className="lattice-stat">
              <b>{placementCount}</b>
              <span>{t("On canvas")}</span>
            </div>
            <div className="lattice-stat">
              <b>{installedCount}</b>
              <span>{t("Installed")}</span>
            </div>
          </div>

          <section className="lattice-activity">
            <header className="lattice-activity-head">
              <h4>{t("Activity")}</h4>
              <span>{t("Last 12 months")}</span>
            </header>
            <UsageHeatmap days={days} today={today} />
            {usage.totalMinutes === 0 && (
              <p className="lattice-hint">
                {t("No activity yet — the heatmap starts recording from today.")}
              </p>
            )}
          </section>

          <div className="lattice-profile-danger">
            {confirmClear ? (
              <>
                <span className="lattice-profile-danger-text">
                  {t("Clear the local activity record? Your profile stays.")}
                </span>
                <button
                  type="button"
                  className="lattice-btn is-small"
                  onClick={() => {
                    onClearUsage();
                    setConfirmClear(false);
                  }}
                >
                  {t("Clear")}
                </button>
                <button type="button" className="lattice-link-btn" onClick={() => setConfirmClear(false)}>
                  {t("Cancel")}
                </button>
              </>
            ) : (
              <button type="button" className="lattice-link-btn" onClick={() => setConfirmClear(true)}>
                {t("Clear usage history")}
              </button>
            )}
            <button type="button" className="lattice-link-btn is-danger" onClick={onSignOut}>
              {t("Sign out")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
