const http = require("http");
const path = require("path");
const fsp = require("fs/promises");

const {
  DB_PATH,
  activateUserFromInvite,
  createInitialAdmin,
  createSession,
  deleteSession,
  getInviteInfo,
  getSessionByTokenHash,
  getUserByEmail,
  getUserById,
  hasUsers,
  inviteUser,
  listUsers,
  updateUser,
} = require("./database");
const {
  generateToken,
  hashPassword,
  hashToken,
  verifyPassword,
} = require("./auth");

const HOST = "0.0.0.0";
const PORT = process.env.PORT ? Number(process.env.PORT) : 3100;
const ROOT = __dirname;
const SESSION_COOKIE = "rederij_session";
const SESSION_TTL_DAYS = 14;

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const PAGE_ACCESS = {
  "/planning.html": ["member", "board", "admin"],
  "/zeildagen.html": ["member", "board", "admin"],
  "/logboek.html": ["member", "board", "admin"],
  "/informatie.html": ["member", "board", "admin"],
  "/kasboek.html": ["member", "board", "admin"],
  "/admin.html": ["admin"],
};

function resolvePath(urlPath) {
  if (urlPath === "/") {
    return path.join(ROOT, "index.html");
  }

  const safePath = path.normalize(path.join(ROOT, urlPath));
  if (!safePath.startsWith(ROOT)) {
    return null;
  }

  return safePath;
}

function json(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  const cookies = {};
  for (const part of raw.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (!name) {
      continue;
    }
    cookies[name] = decodeURIComponent(valueParts.join("="));
  }
  return cookies;
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }

      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(body);
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sessionCookieValue(token, expiresAt) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}${secure}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

function sessionExpiryIso() {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + SESSION_TTL_DAYS);
  return expiresAt.toISOString();
}

function publicUser(user) {
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName || user.display_name,
    role: user.role,
    shares: user.shares,
    isActive: typeof user.isActive === "boolean" ? user.isActive : Boolean(user.is_active),
  };
}

function getSessionFromRequest(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (!token) {
    return null;
  }
  return getSessionByTokenHash(hashToken(token));
}

function requireRole(session, allowedRoles) {
  return session && allowedRoles.includes(session.user.role);
}

function protectPage(req, res, pathname) {
  const allowedRoles = PAGE_ACCESS[pathname];
  if (!allowedRoles) {
    return false;
  }

  const session = getSessionFromRequest(req);
  if (!session) {
    res.statusCode = 302;
    res.setHeader("Location", `/login.html?next=${encodeURIComponent(pathname)}`);
    res.end();
    return true;
  }

  if (!allowedRoles.includes(session.user.role)) {
    res.statusCode = 302;
    res.setHeader("Location", "/");
    res.end();
    return true;
  }

  return false;
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    json(res, 200, {
      ok: true,
      databasePath: DB_PATH,
      hasUsers: hasUsers(),
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/auth/bootstrap") {
    const session = getSessionFromRequest(req);
    json(res, 200, {
      hasUsers: hasUsers(),
      me: session ? publicUser(session.user) : null,
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/auth/me") {
    const session = getSessionFromRequest(req);
    json(res, 200, {
      me: session ? publicUser(session.user) : null,
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/setup-admin") {
    if (hasUsers()) {
      json(res, 409, { error: "Er bestaat al een eerste beheerder." });
      return true;
    }

    const body = await parseJsonBody(req);
    const email = String(body.email || "").trim();
    const displayName = String(body.displayName || "").trim();
    const password = String(body.password || "");

    if (!email || !displayName || password.length < 10) {
      json(res, 400, {
        error: "Vul naam, e-mailadres en een wachtwoord van minimaal 10 tekens in.",
      });
      return true;
    }

    const { hash, salt } = hashPassword(password);
    const admin = createInitialAdmin({
      email,
      displayName,
      passwordHash: hash,
      passwordSalt: salt,
    });

    const rawToken = generateToken();
    const expiresAt = sessionExpiryIso();
    createSession(admin.id, hashToken(rawToken), expiresAt);
    res.setHeader("Set-Cookie", sessionCookieValue(rawToken, expiresAt));
    json(res, 201, { user: publicUser(admin) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await parseJsonBody(req);
    const email = String(body.email || "").trim();
    const password = String(body.password || "");
    const user = getUserByEmail(email);

    if (!user || !user.is_active || !verifyPassword(password, user.password_hash, user.password_salt)) {
      json(res, 401, { error: "Onjuiste inloggegevens." });
      return true;
    }

    const rawToken = generateToken();
    const expiresAt = sessionExpiryIso();
    createSession(user.id, hashToken(rawToken), expiresAt);
    res.setHeader("Set-Cookie", sessionCookieValue(rawToken, expiresAt));
    json(res, 200, {
      user: publicUser(user),
      message: "Inloggen gelukt.",
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    const cookies = parseCookies(req);
    if (cookies[SESSION_COOKIE]) {
      deleteSession(hashToken(cookies[SESSION_COOKIE]));
    }
    res.setHeader("Set-Cookie", clearSessionCookie());
    json(res, 200, { ok: true });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/activate") {
    const body = await parseJsonBody(req);
    const inviteToken = String(body.inviteToken || "").trim();
    const password = String(body.password || "");

    if (!inviteToken || password.length < 10) {
      json(res, 400, {
        error: "Vul een geldige activatiecode en een wachtwoord van minimaal 10 tekens in.",
      });
      return true;
    }

    const { hash, salt } = hashPassword(password);
    const activatedUser = activateUserFromInvite({
      tokenHash: hashToken(inviteToken),
      passwordHash: hash,
      passwordSalt: salt,
    });

    if (!activatedUser) {
      json(res, 404, { error: "Deze activatiecode is niet gevonden." });
      return true;
    }

    if (activatedUser.expired) {
      json(res, 410, { error: "Deze activatiecode is verlopen." });
      return true;
    }

    const rawToken = generateToken();
    const expiresAt = sessionExpiryIso();
    createSession(activatedUser.id, hashToken(rawToken), expiresAt);
    res.setHeader("Set-Cookie", sessionCookieValue(rawToken, expiresAt));
    json(res, 200, {
      user: publicUser(activatedUser),
      message: "Account geactiveerd.",
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/auth/invite-info") {
    const token = String(url.searchParams.get("token") || "").trim();
    if (!token) {
      json(res, 400, { error: "Geef een activatiecode op." });
      return true;
    }

    const inviteInfo = getInviteInfo(hashToken(token));
    if (!inviteInfo) {
      json(res, 404, { error: "Deze activatiecode is niet gevonden." });
      return true;
    }

    if (inviteInfo.expired) {
      json(res, 410, { error: "Deze activatiecode is verlopen." });
      return true;
    }

    json(res, 200, { user: inviteInfo });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/users") {
    const session = getSessionFromRequest(req);
    if (!requireRole(session, ["admin"])) {
      json(res, 403, { error: "Alleen beheerders mogen leden beheren." });
      return true;
    }

    json(res, 200, {
      users: listUsers(),
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/users/invite") {
    const session = getSessionFromRequest(req);
    if (!requireRole(session, ["admin"])) {
      json(res, 403, { error: "Alleen beheerders mogen leden uitnodigen." });
      return true;
    }

    const body = await parseJsonBody(req);
    const email = String(body.email || "").trim();
    const displayName = String(body.displayName || "").trim();
    const role = String(body.role || "member").trim();
    const shares = Number(body.shares || 1);

    if (!email || !displayName || !["member", "board", "admin"].includes(role) || shares < 0) {
      json(res, 400, { error: "Controleer naam, e-mailadres, rol en aantal aandelen." });
      return true;
    }

    const inviteToken = generateToken();
    const inviteExpiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString();
    const user = inviteUser({
      email,
      displayName,
      role,
      shares,
      inviteTokenHash: hashToken(inviteToken),
      inviteExpiresAt,
    });

    json(res, 201, {
      user,
      inviteToken,
      inviteExpiresAt,
      message: "Lid aangemaakt. Laat het lid zelf met deze code een wachtwoord kiezen.",
    });
    return true;
  }

  if (req.method === "PATCH" && url.pathname.startsWith("/api/admin/users/")) {
    const session = getSessionFromRequest(req);
    if (!requireRole(session, ["admin"])) {
      json(res, 403, { error: "Alleen beheerders mogen leden aanpassen." });
      return true;
    }

    const id = Number(url.pathname.split("/").pop());
    if (!Number.isInteger(id) || id <= 0) {
      json(res, 400, { error: "Ongeldig lid-id." });
      return true;
    }

    const currentUser = getUserById(id);
    if (!currentUser) {
      json(res, 404, { error: "Lid niet gevonden." });
      return true;
    }

    const body = await parseJsonBody(req);
    const displayName = String(body.displayName || currentUser.display_name || "").trim();
    const role = String(body.role || currentUser.role).trim();
    const shares = Number(body.shares ?? currentUser.shares);
    const isActive = typeof body.isActive === "boolean" ? body.isActive : Boolean(currentUser.is_active);

    if (!displayName || !["member", "board", "admin"].includes(role) || shares < 0) {
      json(res, 400, { error: "Controleer naam, rol en aantal aandelen." });
      return true;
    }

    if (session.user.id === id && (!isActive || role !== "admin")) {
      json(res, 400, {
        error: "Je kunt je eigen account niet deactiveren of je admin-rol weghalen.",
      });
      return true;
    }

    const user = updateUser({
      id,
      displayName,
      role,
      shares,
      isActive,
    });

    json(res, 200, {
      user,
      message: "Lid bijgewerkt.",
    });
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(req, res, url);
      if (!handled) {
        json(res, 404, { error: "API-route niet gevonden." });
      }
      return;
    }

    if (protectPage(req, res, url.pathname)) {
      return;
    }

    const filePath = resolvePath(url.pathname);

    if (!filePath) {
      res.statusCode = 403;
      res.end("Niet toegestaan");
      return;
    }

    const data = await fsp.readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    res.statusCode = 200;
    res.setHeader("Content-Type", CONTENT_TYPES[extension] || "application/octet-stream");
    res.end(data);
  } catch (error) {
    if (error instanceof SyntaxError) {
      json(res, 400, { error: "De ontvangen gegevens zijn geen geldige JSON." });
      return;
    }

    if (error.code === "ENOENT") {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Niet gevonden");
      return;
    }

    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Er ging iets mis.");
    console.error(error);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`de Rederij mobile-first draait op http://${HOST}:${PORT}`);
  console.log(`Database actief op ${DB_PATH}`);
});
