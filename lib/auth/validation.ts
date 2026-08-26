export type AuthInput = {
  username: string;
  password: string;
  displayName?: string;
};

export function parseAuthInput(value: unknown, mode: "login" | "register") {
  if (!value || typeof value !== "object") return { error: "请求格式不正确。" } as const;
  const body = value as Record<string, unknown>;
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";

  if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) {
    return { error: "账号只能包含字母、数字和下划线，长度为 3-24 位。" } as const;
  }
  if (password.length < 8 || password.length > 72) {
    return { error: "密码长度需要在 8-72 位之间。" } as const;
  }
  if (mode === "register" && displayName.length > 30) {
    return { error: "昵称不能超过 30 个字符。" } as const;
  }

  return {
    data: {
      username,
      password,
      displayName: displayName || username,
    } satisfies AuthInput,
  } as const;
}
