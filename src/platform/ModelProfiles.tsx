/**
 * 模型档：清单 + 编辑器。
 *
 * # 一处代码，两个入口
 *
 *   - 设置 → Models（`variant="settings"`）：整页，带说明和"配置文件"入口
 *   - 助手面板的设置态（`variant="panel"`）：窄一列，这一块在上面，
 *     下面接着"它能不能动手"（手）和外部服务
 *
 * 为什么不各写一份：这一块有三百行状态（新建 / 编辑 / 测连接 / 存 key /
 * 删档 / 切 active），抄一份的代价不是多写一遍，而是以后每次改都要改两遍，
 * 而只有一处会被真的点到。上一版就住在助手面板里，设置里只有一个入口链接。
 *
 * # 三个不该合并的动作
 *
 *   点行     = 打开编辑器（`Edit`）
 *   用它     = 把全局切到这一档（`Use`）
 *   删掉     = 两步确认，key 跟着一起走
 *
 * 把"编辑"和"切过去"合成一个点击，会让"我只是想改个模型名"变成"我把全局
 * 切走了" —— 切走之后下一条消息就发到另一个端点上，而且没有任何提示。
 *
 * # 行上的状态点是"能不能用"，不是"连没连上"
 *
 * 绿点 = 这一档 key 齐了、模型名也有，发得出去。它**不代表**网络通 ——
 * 那要一次真的请求，代价是钱和时间，所以只在用户点"测试连接"时才做。
 *
 * # 那盏灯测的是"刚刚这一次"
 *
 * 灯在「测试连接」右边（`lattice-model-probe`）：绿 = 这次通了，红 = 这次没通，
 * 灰 = 还没测过。三条规矩：
 *
 * 1. **它不落盘，也不合并进行上的状态点**。一次真实请求的结果有保质期，而
 *    过期时间取决于对面那个端点 —— 我们不知道它什么时候变。所以它是"这一次
 *    的观察"，不是"这一档的属性"。合并进去，行上那个点就会在重启后骗人。
 * 2. **改了就作废**（`fingerprint`）：地址、鉴权形状、这次粘的 key 一变，
 *    上一次的绿灯就不再描述现在这张表单了，退回灰的比留着错的强。
 * 3. **灯只报状态，原因还是那段红字**：红点旁边挤不下 401 的原文，悬停能看
 *    全（`title`），但"为什么失败"仍旧由下面那行 `lattice-modal-error` 承担。
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  activateLlmProfile,
  configPath,
  listModels,
  readLlmProfiles,
  readSecretsStatus,
  removeLlmProfile,
  saveLlmKey,
  saveLlmProfile,
  type ProfileView,
  type ProfilesView,
  type SecretsStatus,
} from "./assistant";
import { hasRust } from "./devLlm";
import { AUTH_SHAPES, PRESETS, knownModel, type AuthShape, type Preset } from "../runtime/llm-models";
import { useT } from "../runtime/i18n";
import { describeFailure } from "../runtime/llm-errors";

/** 和 Rust 的 `DEFAULT_TEMPERATURE` 对齐：模型没存过温度时表单显示这个 */
const DEFAULT_TEMPERATURE = 0.6;

/** 还没保存的那一档在 `probes` 里的键。真实 id 都以 `p-` 开头，撞不上 */
const DRAFT_KEY = "*";

/**
 * 一次「测试连接」的结果。**只在这次会话里有效**，不落盘 —— 见文件头
 * "那盏灯测的是刚刚这一次"。
 */
interface Probe {
  state: "idle" | "busy" | "ok" | "bad";
  /** 灯旁边那句话（短，挤得下） */
  label: string;
  /** 悬停才看到的全文：失败时是后端那句原文 */
  detail: string;
  /** 测的是哪一组值。表单改了就作废，别拿旧绿灯照新表单 */
  fingerprint: string;
}

/** 只认这三样：模型名换一个不影响"这个端点通不通" */
function probeFingerprint(baseUrl: string, auth: string, key: string): string {
  return [baseUrl, auth, key].join("\u0000");
}

/** 鉴权形状的三档。和 Rust 的 `normalize_auth` 一一对应 */
function authLabel(auth: AuthShape): string {
  if (auth === "none") return "No key (local model)";
  if (auth === "api-key-header") return "api-key header";
  return "Bearer token";
}

export interface ModelProfilesProps {
  /** `settings` = 设置里那一整页；`panel` = 助手面板里窄的那一列 */
  variant?: "settings" | "panel";
  /** 每次列表变了都报一声 —— 面板的标题要显示"正在用哪个模型" */
  onChange?: (view: ProfilesView) => void;
  /** 刚存好一档且它能用。面板据此切回对话；设置里没人听 */
  onReady?: () => void;
  /**
   * 外部改了磁盘上的配置（导入之后），把这个数加一，这里就重读一遍。
   * 用"计一个数"而不是传回调：这一块的状态全在自己身上，外面只需要喊一声。
   */
  reloadToken?: number;
}

export function ModelProfiles({ variant = "settings", onChange, onReady, reloadToken = 0 }: ModelProfilesProps) {
  const t = useT();

  const [view, setView] = useState<ProfilesView | null>(null);
  /** null = 编辑器关着；`{ id: null }` = 正在新建；`{ id }` = 正在改那一档 */
  const [draft, setDraft] = useState<{ id: string | null } | null>(null);

  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [auth, setAuth] = useState<AuthShape>("bearer");
  const [model, setModel] = useState("");
  const [temperature, setTemperature] = useState(DEFAULT_TEMPERATURE);
  const [key, setKey] = useState("");
  const [models, setModels] = useState<string[]>([]);

  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** 「测试连接」在飞。和 `saving` 分开：测的时候 Save 那颗按钮不该写着"保存中…" */
  const [testing, setTesting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 配置文件路径。浏览器预览里拿不到（也没有这个文件），拿不到就不显示那一行 */
  const [file, setFile] = useState<string | null>(null);
  /**
   * 密封库的状态。**只在"存不进去"时说话** —— `error` 非空意味着这一把 key
   * 还以明文躺在 `assistant.json` 里。那是"没加密"，不是"丢了"，但用户得知道。
   */
  const [seal, setSeal] = useState<SecretsStatus | null>(null);
  /** 每档最后一次「测试连接」的结果。键是档 id，没保存的那张表用 `DRAFT_KEY` */
  const [probes, setProbes] = useState<Record<string, Probe>>({});

  const apply = useCallback(
    (next: ProfilesView) => {
      setView(next);
      onChange?.(next);
    },
    [onChange],
  );

  const profiles = view?.profiles ?? [];
  const draftId = draft?.id ?? null;
  const editingProfile = profiles.find((item) => item.id === draftId) ?? null;
  const info = useMemo(() => knownModel(model), [model]);

  /*
   * 灯现在该说什么。`fingerprint` 对不上就是"还没测过"：这张表单已经被改过了，
   * 上一次那个绿灯描述的已经不是它。
   */
  const probeKey = draftId ?? DRAFT_KEY;
  const remembered = probes[probeKey];
  const probe =
    remembered && remembered.fingerprint === probeFingerprint(baseUrl, auth, key) ? remembered : null;
  const probeState = probe?.state ?? "idle";

  /** 把一档灌进表单 */
  const fill = useCallback((profile: ProfileView) => {
    setDraft({ id: profile.id });
    setLabel(profile.label);
    setBaseUrl(profile.baseUrl);
    setAuth(profile.auth);
    setModel(profile.model);
    setTemperature(profile.temperature ?? DEFAULT_TEMPERATURE);
    setModels(profile.models ?? []);
    setKey("");
    setConfirmRemove(null);
    setNote(null);
    setError(null);
  }, []);

  /** 空表单 = 新建一档。给一个预设就把地址/鉴权/模型先填好 */
  const startNew = useCallback((preset?: Preset) => {
    setDraft({ id: null });
    setLabel("");
    setBaseUrl(preset?.baseUrl ?? PRESETS[0].baseUrl);
    setAuth(preset?.auth ?? "bearer");
    setModel(preset?.model ?? "");
    setTemperature(DEFAULT_TEMPERATURE);
    setModels([]);
    setKey("");
    setConfirmRemove(null);
    setNote(null);
    setError(null);
  }, []);

  // 读一次档列表：`llm_profiles` 只回掩码，key 本身永远不进前端
  useEffect(() => {
    let cancelled = false;
    void readLlmProfiles()
      .then((next) => {
        if (cancelled) return;
        apply(next);
        // 一档都没有的时候，直接开着一张空表：这是第一次配，不该再点一次"添加"
        if (!next.profiles.length) startNew();
      })
      .catch((problem) => {
        if (!cancelled) setError(describeFailure(String(problem instanceof Error ? problem.message : problem)));
      });
    if (hasRust()) {
      void configPath()
        .then((path) => {
          if (!cancelled) setFile(path);
        })
        .catch(() => {
          // 预览里没有这条命令：那一行不显示就是了
        });
      void readSecretsStatus().then((next) => {
        if (!cancelled) setSeal(next);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [apply, startNew]);

  /** 重新读磁盘。用户在编辑器里改完文件之后按这个 —— 这里没有缓存，读就是读 */
  const reload = useCallback(async () => {
    setError(null);
    setNote(null);
    try {
      const next = await readLlmProfiles();
      apply(next);
      const stillThere = draft?.id ? next.profiles.some((item) => item.id === draft.id) : true;
      if (!stillThere) setDraft(null);
      setNote(t("Read the file again."));
    } catch (problem) {
      setError(describeFailure(String(problem instanceof Error ? problem.message : problem)));
    }
  }, [apply, draft?.id, t]);

  /**
   * 外面刚导入过一份配置（`reloadToken` 变了）：把清单重读一遍，但**不吭声** ——
   * 那句"已经从文件里重读了一遍"是「重新读取」按钮的回报，导入的回报由发起
   * 导入的那一处去说。表单不动：用户可能正在里面打字。
   */
  useEffect(() => {
    if (!reloadToken) return;
    let cancelled = false;
    void readLlmProfiles()
      .then((next) => {
        if (!cancelled) apply(next);
      })
      .catch((problem) => {
        if (!cancelled) setError(describeFailure(String(problem instanceof Error ? problem.message : problem)));
      });
    return () => {
      cancelled = true;
    };
  }, [apply, reloadToken]);

  const persist = useCallback(async () => {
    setSaving(true);
    setNote(null);
    setError(null);
    try {
      const saved = await saveLlmProfile({
        id: draftId ?? undefined,
        label,
        baseUrl,
        auth,
        model,
        temperature,
      });
      let next = saved.view;
      if (key.trim()) {
        next = await saveLlmKey(saved.id, key);
        // 刚存了一把 key —— 这一句是"它到底加密了没有"的唯一答案
        void readSecretsStatus().then(setSeal);
      }
      apply(next);
      setKey("");
      const stored = next.profiles.find((item) => item.id === saved.id);
      if (stored) fill(stored);
      /*
       * 灯跟着这一档走：刚才测的是同一组值，存完不该变回灰的。key 那一格空了
       * （存进文件了），所以指纹按空 key 重算 —— 那正是"用存着的那把"这个状态。
       */
      setProbes((prev) => {
        const done = prev[draftId ?? DRAFT_KEY];
        if (!done || done.state === "idle" || done.state === "busy") return prev;
        const moved = { ...prev };
        delete moved[DRAFT_KEY];
        moved[saved.id] = { ...done, fingerprint: probeFingerprint(baseUrl, auth, "") };
        return moved;
      });
      setNote(
        stored?.configured
          ? t("Saved. This profile is ready to use.")
          : auth === "none"
            ? t("Saved. A local model needs no key.")
            : t("Saved, but there is no key yet — paste one and save again."),
      );
      if (stored?.configured) onReady?.();
    } catch (problem) {
      setError(describeFailure(String(problem instanceof Error ? problem.message : problem)));
    } finally {
      setSaving(false);
    }
  }, [apply, auth, baseUrl, draftId, fill, key, label, model, onReady, t, temperature]);

  const test = useCallback(async () => {
    // 这一档在 `probes` 里的格子：没保存的那张表用 `DRAFT_KEY`
    const slot = probeKey;
    const typed = key.trim();
    const fingerprint = probeFingerprint(baseUrl, auth, key);
    setTesting(true);
    setNote(null);
    setError(null);
    setProbes((prev) => ({ ...prev, [slot]: { state: "busy", label: "", detail: "", fingerprint } }));
    try {
      // 编辑已有的档时把 id 一起带上：没重新输入 key，就用存着的那一把（Rust 里读）
      const list = await listModels({
        profileId: draftId ?? undefined,
        baseUrl,
        auth,
        key: typed || undefined,
      });
      setModels(list);
      setProbes((prev) => ({
        ...prev,
        [slot]: {
          state: "ok",
          label: list.length
            ? t("Connected · {count} models", { count: list.length })
            : t("Connected · no models listed"),
          detail: list.length ? list.slice(0, 8).join("\n") : t("This endpoint listed no models."),
          fingerprint,
        },
      }));
      // 有的中转站 `/models` 什么都不给，那时只能手填 —— 这句指导性的话留着
      if (!list.length) {
        setNote(t("Connected, but this endpoint listed no models. Type the model name by hand."));
      }
      if (!model.trim() && list[0]) setModel(list[0]);
    } catch (problem) {
      const message = describeFailure(String(problem instanceof Error ? problem.message : problem));
      setProbes((prev) => ({ ...prev, [slot]: { state: "bad", label: t("Connection failed"), detail: message, fingerprint } }));
      setError(message);
    } finally {
      setTesting(false);
    }
  }, [auth, baseUrl, draftId, key, model, probeKey, t]);

  const forgetKey = useCallback(async () => {
    if (!draftId) return;
    setSaving(true);
    setError(null);
    try {
      const next = await saveLlmKey(draftId, "");
      apply(next);
      const stored = next.profiles.find((item) => item.id === draftId);
      if (stored) fill(stored);
      setNote(t("Key removed from this machine."));
    } catch (problem) {
      setError(describeFailure(String(problem instanceof Error ? problem.message : problem)));
    } finally {
      setSaving(false);
    }
  }, [apply, draftId, fill, t]);

  const use = useCallback(
    async (id: string) => {
      setError(null);
      try {
        apply(await activateLlmProfile(id));
      } catch (problem) {
        setError(describeFailure(String(problem instanceof Error ? problem.message : problem)));
      }
    },
    [apply],
  );

  const remove = useCallback(
    async (id: string) => {
      setSaving(true);
      setError(null);
      try {
        const next = await removeLlmProfile(id);
        apply(next);
        if (draft?.id === id) setDraft(null);
        setNote(t("Profile deleted, along with its key."));
      } catch (problem) {
        setError(describeFailure(String(problem instanceof Error ? problem.message : problem)));
      } finally {
        setSaving(false);
        setConfirmRemove(null);
      }
    },
    [apply, draft?.id, t],
  );

  const presets = draft?.id === null && (
    <div className="lattice-preset-row">
      {PRESETS.map((preset) => (
        <button
          key={preset.id}
          type="button"
          className="lattice-preset-chip"
          title={t(preset.hint)}
          onClick={() => startNew(preset)}
        >
          {preset.label}
        </button>
      ))}
    </div>
  );

  const editor = (
    <div className="lattice-model-editor">
      {presets}

      <div className="lattice-model-grid">
        <label className="lattice-textfield">
          <span>{t("Name")}</span>
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={t("Leave empty to use the host name")}
            spellCheck={false}
          />
        </label>

        <label className="lattice-textfield">
          <span>{t("Model")}</span>
          <input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder={PRESETS[0].model}
            list="lattice-llm-models"
            spellCheck={false}
          />
          <datalist id="lattice-llm-models">
            {[...new Set([...models, ...(editingProfile?.models ?? [])])].map((item) => (
              <option key={item} value={item} />
            ))}
          </datalist>
        </label>

        <label className="lattice-textfield is-wide">
          <span>{t("API base URL")}</span>
          <input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://api.deepseek.com/v1"
            spellCheck={false}
          />
        </label>

        <label className="lattice-textfield">
          <span>{t("How does this endpoint want the key?")}</span>
          <select value={auth} onChange={(event) => setAuth(event.target.value as AuthShape)}>
            {AUTH_SHAPES.map((shape) => (
              <option key={shape} value={shape}>
                {t(authLabel(shape))}
              </option>
            ))}
          </select>
        </label>

        {auth !== "none" && (
          <label className="lattice-textfield">
            <span>
              {editingProfile?.keyHint
                ? t("API key (currently {hint})", { hint: editingProfile.keyHint })
                : t("API key")}
            </span>
            <input
              type="password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder={editingProfile?.keyHint ? t("Leave empty to keep the current key") : "sk-…"}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
        )}

        {info.temperature && (
          <label className="lattice-textfield is-wide">
            <span>
              {t("Temperature {value} (lower is steadier; 0.4–0.8 works well for changing the desktop)", {
                value: temperature.toFixed(2),
              })}
            </span>
            <input
              type="range"
              min="0"
              max="1.5"
              step="0.05"
              value={temperature}
              onChange={(event) => setTemperature(Number(event.target.value))}
            />
          </label>
        )}
      </div>

      <p className="lattice-settings-hint">
        {t("Any OpenAI-compatible endpoint works. Plain http is only allowed for localhost.")}
      </p>
      {!info.tools && (
        <p className="lattice-assistant-hint is-warn">
          {t("This model cannot call tools — it can talk, but it cannot change the desktop.")}
        </p>
      )}
      {editingProfile?.keySource === "env" && (
        <p className="lattice-settings-hint">
          {t("This key comes from the environment, not from this machine's settings.")}
        </p>
      )}
      {/*
        密封失败时唯一的那句话。**不是"存不进去"** —— key 照样能用，它只是
        还以明文躺在 assistant.json 里。两件事必须说成两件事：说成"保存失败"
        用户会以为 key 丢了，然后去后台重新生成一把。
      */}
      {seal?.error && (
        <p className="lattice-assistant-hint is-warn">
          {t("This key is still stored as plain text ({reason}). It works, but it is not encrypted at rest.", {
            reason: seal.error,
          })}
        </p>
      )}

      {/*
        两颗不同的心思，分开站：
          左边  Save / Forget key / Cancel —— 只碰这张表单
          右边  Test connection + 灯     —— 碰网络，会花钱、会花时间
        以前它排在 Save 左边，读起来像"保存流程的第一步"。挪到对面之后，
        点下去的结果就落在它自己右边那盏灯上，不用再去下面那行小字里找。
      */}
      <div className="lattice-model-editor-foot">
        <div className="lattice-model-foot-actions">
          <button
            type="button"
            className="lattice-btn is-small is-primary"
            onClick={() => void persist()}
            disabled={saving || testing}
          >
            {saving ? t("Saving…") : t("Save")}
          </button>
          {auth !== "none" && editingProfile?.keyHint && (
            <button
              type="button"
              className="lattice-btn is-small"
              onClick={() => void forgetKey()}
              disabled={saving || testing}
            >
              {t("Forget key")}
            </button>
          )}
          <button type="button" className="lattice-btn is-small" onClick={() => setDraft(null)}>
            {t("Cancel")}
          </button>
        </div>

        <div className={`lattice-model-probe is-${probeState}`}>
          <button
            type="button"
            className="lattice-btn is-small"
            onClick={() => void test()}
            disabled={saving || testing}
            title={t("Send one real request to this endpoint — it costs a few tokens.")}
          >
            {t("Test connection")}
          </button>
          <span className="lattice-lamp" aria-hidden="true" />
          <span
            className="lattice-model-probe-label"
            role="status"
            aria-live="polite"
            title={probe?.detail || t("Not tested yet")}
          >
            {probeState === "busy"
              ? t("Testing…")
              : probeState === "ok"
                ? probe?.label
                : probeState === "bad"
                  ? t("Connection failed")
                  : t("Not tested")}
          </span>
        </div>
      </div>

      {error && <p className="lattice-modal-error">{error}</p>}
      {note && <p className="lattice-settings-hint">{note}</p>}
    </div>
  );

  return (
    <div className={`lattice-models is-${variant}`}>
      {variant === "settings" && (
        <p className="lattice-models-intro">
          {t("Enter your API keys to use models from the following providers.")}
        </p>
      )}

      <ul className="lattice-model-list">
        {profiles.map((item) => {
          const open = draft?.id === item.id;
          return (
            <li key={item.id} className={`lattice-model-card${open ? " is-open" : ""}`}>
              <div className="lattice-model-row">
                <button
                  type="button"
                  className="lattice-model-ident"
                  onClick={() => (open ? setDraft(null) : fill(item))}
                  aria-expanded={open}
                >
                  <span className="lattice-model-name">{item.label || item.baseUrl}</span>
                  <span className={`lattice-model-status${item.configured ? " is-ok" : " is-bad"}`}>
                    <span className="lattice-model-dot" />
                    {item.configured ? t("Ready") : t("No key")}
                  </span>
                  <span className="lattice-model-endpoint">{item.model || t("no model yet")}</span>
                </button>

                <span className="lattice-model-actions">
                  {item.id === view?.activeId ? (
                    <span className="lattice-model-badge">{t("In use")}</span>
                  ) : (
                    <button
                      type="button"
                      className="lattice-btn is-small"
                      onClick={() => void use(item.id)}
                      title={t("Make this the profile the assistant uses")}
                    >
                      {t("Use")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="lattice-btn is-small"
                    onClick={() => (open ? setDraft(null) : fill(item))}
                  >
                    {t("Edit")}
                  </button>
                  <button
                    type="button"
                    className={`lattice-btn is-small${confirmRemove === item.id ? " is-danger" : ""}`}
                    onClick={() => {
                      if (confirmRemove === item.id) void remove(item.id);
                      else setConfirmRemove(item.id);
                    }}
                    disabled={saving}
                  >
                    {confirmRemove === item.id ? t("Delete it and its key?") : t("Delete")}
                  </button>
                </span>
              </div>

              {open && editor}
            </li>
          );
        })}

        {draft?.id === null && <li className="lattice-model-card is-open">{editor}</li>}
      </ul>

      {view && !profiles.length && !draft && (
        <p className="lattice-settings-hint">{t("No model profile yet.")}</p>
      )}

      <button type="button" className="lattice-model-add" onClick={() => startNew()}>
        <span aria-hidden="true">+</span> {t("Add model provider")}
      </button>

      {variant === "settings" && file && (
        <div className="lattice-model-file">
          <span className="lattice-model-file-path" title={file}>
            {file}
          </span>
          <button type="button" className="lattice-btn is-small" onClick={() => void reload()}>
            {t("Read the file again")}
          </button>
        </div>
      )}
    </div>
  );
}
