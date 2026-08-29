import { useEffect, useMemo, useState } from "react";

import type { BootstrapResponse } from "../shared/contracts/api";
import { AdminWorkspace } from "./AdminWorkspace";
import { AdminApiError, BrowserAdminApi } from "./api";

const LoginCard = ({ denied = false }: { denied?: boolean }) => (
  <main className="login-page">
    <section className="login-card">
      <div className="login-mark">I</div>
      <span className="eyebrow">IRL Stream HUD</span>
      <h1>{denied ? "Kein Editor-Zugriff" : "Live-Regie öffnen"}</h1>
      <p>
        {denied
          ? "Zugriff erhalten nur der Broadcaster und aktuell eingetragene Twitch-Moderator:innen."
          : "Melde dich mit Twitch an. Der Broadcaster und aktuelle Twitch-Moderator:innen dürfen das Overlay gemeinsam steuern."}
      </p>
      <a className="twitch-login" href="/auth/twitch/start">
        Mit Twitch anmelden
      </a>
      <small>Keine Chat-, E-Mail- oder OBS-Berechtigung erforderlich.</small>
    </section>
  </main>
);

export const AdminApp = () => {
  const api = useMemo(() => new BrowserAdminApi(), []);
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "login" | "denied" | "error">("loading");

  useEffect(() => {
    let disposed = false;
    void api
      .bootstrap()
      .then((result) => {
        if (!disposed) setBootstrap(result);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        if (error instanceof AdminApiError && error.status === 401) setStatus("login");
        else if (error instanceof AdminApiError && error.code === "role_ineligible") setStatus("denied");
        else setStatus("error");
      });
    return () => {
      disposed = true;
    };
  }, [api]);

  useEffect(() => {
    if (bootstrap === null) return;
    const revalidate = () => {
      void api.revalidate().catch(() => {
        window.location.assign("/login?error=session_expired");
      });
    };
    const interval = window.setInterval(revalidate, 55 * 60 * 1_000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") revalidate();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [api, bootstrap]);

  if (bootstrap !== null) return <AdminWorkspace initialBootstrap={bootstrap} api={api} />;
  if (status === "login") return <LoginCard />;
  if (status === "denied") return <LoginCard denied />;
  if (status === "error") {
    return (
      <main className="login-page">
        <section className="login-card">
          <div className="login-mark">!</div>
          <h1>Verbindung nicht möglich</h1>
          <p>Der HUD-Dienst ist gerade nicht erreichbar oder noch nicht vollständig konfiguriert.</p>
          <button className="button button--primary" onClick={() => window.location.reload()} type="button">
            Erneut versuchen
          </button>
        </section>
      </main>
    );
  }
  return (
    <div className="admin-skeleton" aria-busy="true" aria-label="Editor wird geladen">
      <div className="skeleton-top" />
      <div className="skeleton-side" />
      <div className="skeleton-preview" />
      <div className="skeleton-controls" />
    </div>
  );
};

export const LoginApp = () => {
  const denied = new URLSearchParams(window.location.search).get("error") === "not_editor";
  return <LoginCard denied={denied} />;
};
