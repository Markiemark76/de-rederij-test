(() => {
  const access = document.body.dataset.access || "public";
  const loginLink = document.body.dataset.loginHref || "/login.html";

  async function loadSession() {
    const response = await fetch("/api/auth/me", {
      credentials: "same-origin",
    });
    const data = await response.json();
    return data.me || null;
  }

  function redirectToLogin() {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.replace(`${loginLink}?next=${next}`);
  }

  function enforceAccess(me) {
    if (access === "public") {
      return;
    }

    if (!me) {
      redirectToLogin();
      return;
    }

    if (access === "admin" && me.role !== "admin") {
      window.location.replace("/");
    }
  }

  loadSession()
    .then(enforceAccess)
    .catch(() => {
      if (access !== "public") {
        redirectToLogin();
      }
    });
})();
