"use client";

import { FormEvent, useState } from "react";

function AttechLogo() {
  return <div className="attech-logo attech-logo-login" role="img" aria-label="ATTECH - Trung tâm Bảo đảm Kỹ thuật"><span className="attech-wordmark"><span className="attech-a">A</span><span className="attech-tech">TTECH</span></span><span className="attech-unit-name">Trung tâm Bảo đảm Kỹ thuật</span></div>;
}

export default function LoginPage() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    const formData = new FormData(event.currentTarget);
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: formData.get("username"),
        password: formData.get("password"),
      }),
    });
    const payload = await response.json() as { error?: string };
    if (!response.ok) {
      setError(payload.error ?? "Không thể đăng nhập.");
      setIsLoading(false);
      return;
    }
    window.location.href = "/";
  }

  return <main className="login-shell"><section className="login-card" aria-labelledby="login-title"><div className="login-brand"><AttechLogo /><p className="login-product">TAX ID Checker <span>v1.0.0 beta</span></p></div><h1 id="login-title">Đăng nhập hệ thống</h1><p className="login-description">Tra cứu và theo dõi tình trạng hoạt động mã số thuế trong danh mục nhà cung ứng ATTECH.</p><form className="login-form" onSubmit={signIn}><label htmlFor="username">Tài khoản</label><input id="username" name="username" autoComplete="username" required placeholder="Nhập tên tài khoản" /><label htmlFor="password">Mật khẩu</label><input id="password" name="password" type="password" autoComplete="current-password" required placeholder="Nhập mật khẩu" /><button className="login-google" type="submit" disabled={isLoading}>{isLoading ? "Đang xác thực..." : "Đăng nhập"}</button></form>{error ? <p className="form-error">{error}</p> : null}<p className="login-note">Tài khoản nội bộ Trung tâm Bảo đảm kỹ thuật</p></section></main>;
}
