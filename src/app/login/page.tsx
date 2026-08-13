"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

function AttechLogo() {
  return <div className="attech-logo attech-logo-login"><span className="attech-a">A</span><span className="attech-tech">TTECH</span></div>;
}

export default function LoginPage() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signInWithGoogle() {
    setIsLoading(true);
    setError(null);
    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    if (authError) {
      setError(authError.message);
      setIsLoading(false);
    }
  }

  return <main className="login-shell"><section className="login-card" aria-labelledby="login-title"><AttechLogo /><p className="login-product">TAX ID Cheker <span>v1.0.0 beta</span></p><h1 id="login-title">Đăng nhập hệ thống</h1><p className="login-description">Tra cứu và theo dõi tình trạng hoạt động mã số thuế trong danh mục ATTECH.</p><button className="login-google" type="button" onClick={signInWithGoogle} disabled={isLoading}><span className="google-letter">G</span>{isLoading ? "Đang kết nối Google..." : "Tiếp tục với Google"}</button>{error ? <p className="form-error">Không thể đăng nhập: {error}</p> : null}<p className="login-note">Tài khoản mới cần được quản trị viên phê duyệt.</p></section></main>;
}
