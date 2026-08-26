"use client";

import { useState } from "react";
import { ArrowRight, Eye, EyeOff, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import styles from "./login.module.css";

type AuthMode = "login" | "register";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<AuthMode>("login");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, displayName, password }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error || "登录失败，请稍后重试。");
      router.push("/");
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "登录失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  function switchMode(nextMode: AuthMode) {
    setMode(nextMode);
    setError("");
  }

  return (
    <main className={styles.shell}>
      <section className={styles.story}>
        <div className={styles.brand}><span><Sparkles size={18} /></span>成长回路</div>
        <div className={styles.storyCopy}>
          <p className={styles.eyebrow}>GROWTH LOOP · LOCAL FIRST</p>
          <h1>把每一次学习，<br />变成下一步行动。</h1>
          <p>记录事实、验证掌握、继续学习。你的数据先保存在这台设备上。</p>
        </div>
        <div className={styles.loopLine}><span>学习</span><i /><span>校验</span><i /><span>继续</span></div>
      </section>

      <section className={styles.authPanel}>
        <div className={styles.authCard}>
          <div className={styles.tabs} role="tablist" aria-label="账号操作">
            <button type="button" role="tab" aria-selected={mode === "login"} className={mode === "login" ? styles.activeTab : ""} onClick={() => switchMode("login")}>登录</button>
            <button type="button" role="tab" aria-selected={mode === "register"} className={mode === "register" ? styles.activeTab : ""} onClick={() => switchMode("register")}>创建账号</button>
          </div>

          <div className={styles.heading}>
            <span>{mode === "login" ? "欢迎回来" : "从今天开始"}</span>
            <h2>{mode === "login" ? "继续你的成长回路" : "创建本地成长账号"}</h2>
            <p>{mode === "login" ? "输入账号和密码，回到今天的下一步。" : "账号只用于区分本机上的不同用户。"}</p>
          </div>

          <form onSubmit={submit} className={styles.form}>
            <label>
              <span>账号</span>
              <input name="username" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="3-24 位字母、数字或下划线" autoComplete="username" required />
            </label>
            {mode === "register" && <label>
              <span>昵称 <em>可选</em></span>
              <input name="displayName" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="界面中显示的名字" autoComplete="name" maxLength={30} />
            </label>}
            <label>
              <span>密码</span>
              <div className={styles.passwordField}>
                <input name="password" type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 8 位" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={8} maxLength={72} />
                <button type="button" onClick={() => setShowPassword((visible) => !visible)} aria-label={showPassword ? "隐藏密码" : "显示密码"}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button>
              </div>
            </label>

            {error && <div className={styles.error} role="alert">{error}</div>}
            <button className={styles.submit} disabled={busy} type="submit">
              {busy ? "正在处理…" : mode === "login" ? "进入工作台" : "创建并进入"}
              {!busy && <ArrowRight size={17} />}
            </button>
          </form>

          <p className={styles.localHint}>SQLite 本地存储 · 密码仅保存哈希 · 30 天登录会话</p>
        </div>
      </section>
    </main>
  );
}
