import { useEffect, useState } from "react";
import { EXPORT_EXCEL_URL, EXPORT_PDF_URL, fetchStats, verifyAdminPassword } from "./api";
import ContributionSection from "./ContributionSection";
import BalloonSection from "./BalloonSection";
import "./App.css";

function money(v) {
  return `¥${Number(v || 0).toFixed(2)}`;
}

export default function App() {
  const [stats, setStats] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const [adminPassword, setAdminPassword] = useState(
    () => sessionStorage.getItem("admin_password") || ""
  );
  const [isAdmin, setIsAdmin] = useState(false);
  const [loginInput, setLoginInput] = useState("");
  const [loginError, setLoginError] = useState("");

  useEffect(() => {
    fetchStats()
      .then(setStats)
      .catch(() => {});
  }, [refreshKey]);

  useEffect(() => {
    if (!adminPassword) return;
    verifyAdminPassword(adminPassword)
      .then((res) => setIsAdmin(res.ok))
      .catch(() => setIsAdmin(false));
  }, [adminPassword]);

  function handleChanged() {
    setRefreshKey((k) => k + 1);
  }

  async function handleLogin(e) {
    e.preventDefault();
    setLoginError("");
    try {
      const res = await verifyAdminPassword(loginInput);
      if (res.ok) {
        sessionStorage.setItem("admin_password", loginInput);
        setAdminPassword(loginInput);
        setIsAdmin(true);
        setLoginInput("");
      } else {
        setLoginError("密码错误");
      }
    } catch (e) {
      setLoginError(e.message);
    }
  }

  function handleLogout() {
    sessionStorage.removeItem("admin_password");
    setAdminPassword("");
    setIsAdmin(false);
  }

  const balloonMismatch =
    stats &&
    Math.abs(stats.contribution.total_balloon - stats.balloon.total_amount) > 0.01;

  return (
    <div className="wrap">
      <h1>🧨 鞭子 · 🎈 气球 随礼登记</h1>
      <p className="subtitle">统计大家给堂哥出的鞭子钱、气球钱，以及气球署名</p>

      <div className="card">
        <div className="admin-bar">
          {isAdmin ? (
            <>
              <span>管理模式已开启</span>
              <button className="btn-small" onClick={handleLogout}>
                退出
              </button>
            </>
          ) : (
            <form onSubmit={handleLogin} className="inline-form">
              <input
                type="password"
                placeholder="管理密码"
                value={loginInput}
                onChange={(e) => setLoginInput(e.target.value)}
              />
              <button className="btn-small" type="submit">
                登录
              </button>
              {loginError && <span className="error-text">{loginError}</span>}
            </form>
          )}
        </div>

        {stats && (
          <>
            <div className="stats">
              <div>
                <div className="num">{stats.contribution.count}</div>
                <div className="label">出资人数</div>
              </div>
              <div>
                <div className="num">{money(stats.contribution.total_firecracker)}</div>
                <div className="label">鞭子总额</div>
              </div>
              <div>
                <div className="num">{money(stats.contribution.total_balloon)}</div>
                <div className="label">气球总额</div>
              </div>
              <div>
                <div className="num">{money(stats.contribution.total_all)}</div>
                <div className="label">合计</div>
              </div>
            </div>
            <div className="reconcile">
              气球署名 {stats.balloon.count} 个 × ¥{stats.balloon.unit_price.toFixed(0)} ={" "}
              {money(stats.balloon.total_amount)}
              {balloonMismatch && (
                <span className="mismatch">
                  {" "}
                  ⚠️ 和气球出资总额（{money(stats.contribution.total_balloon)}）对不上
                </span>
              )}
            </div>
          </>
        )}

        <div className="export-bar">
          <a className="btn-small" href={EXPORT_EXCEL_URL}>
            导出 Excel
          </a>
          <a className="btn-small" href={EXPORT_PDF_URL}>
            导出 PDF
          </a>
        </div>
      </div>

      <ContributionSection
        isAdmin={isAdmin}
        adminPassword={adminPassword}
        onChanged={handleChanged}
      />
      <BalloonSection
        isAdmin={isAdmin}
        adminPassword={adminPassword}
        onChanged={handleChanged}
      />
    </div>
  );
}
