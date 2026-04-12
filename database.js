const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "rederij.sqlite");

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('member', 'board', 'admin')),
    shares INTEGER NOT NULL DEFAULT 1,
    is_active INTEGER NOT NULL DEFAULT 1,
    password_hash TEXT,
    password_salt TEXT,
    invite_token_hash TEXT,
    invite_expires_at TEXT,
    last_password_set_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

const statements = {
  countUsers: db.prepare("SELECT COUNT(*) AS count FROM users"),
  insertInitialAdmin: db.prepare(`
    INSERT INTO users (
      email,
      display_name,
      role,
      shares,
      is_active,
      password_hash,
      password_salt,
      last_password_set_at,
      created_at,
      updated_at
    ) VALUES (?, ?, 'admin', 1, 1, ?, ?, ?, ?, ?)
  `),
  getUserByEmail: db.prepare(`
    SELECT id, email, display_name, role, shares, is_active, password_hash, password_salt,
           invite_token_hash, invite_expires_at, last_password_set_at, created_at, updated_at
    FROM users
    WHERE lower(email) = lower(?)
  `),
  getUserById: db.prepare(`
    SELECT id, email, display_name, role, shares, is_active, password_hash, password_salt,
           invite_token_hash, invite_expires_at, last_password_set_at, created_at, updated_at
    FROM users
    WHERE id = ?
  `),
  getUserByInviteHash: db.prepare(`
    SELECT id, email, display_name, role, shares, is_active, password_hash, password_salt,
           invite_token_hash, invite_expires_at, last_password_set_at, created_at, updated_at
    FROM users
    WHERE invite_token_hash = ?
  `),
  createSession: db.prepare(`
    INSERT INTO sessions (user_id, token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `),
  getSessionByHash: db.prepare(`
    SELECT s.id, s.user_id, s.token_hash, s.expires_at, s.created_at,
           u.email, u.display_name, u.role, u.shares, u.is_active
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `),
  deleteSessionByHash: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
  deleteExpiredSessions: db.prepare("DELETE FROM sessions WHERE expires_at <= ?"),
  listUsers: db.prepare(`
    SELECT id, email, display_name, role, shares, is_active,
           invite_expires_at, last_password_set_at, created_at, updated_at
    FROM users
    ORDER BY is_active DESC, lower(display_name) ASC
  `),
  inviteUser: db.prepare(`
    INSERT INTO users (
      email,
      display_name,
      role,
      shares,
      is_active,
      invite_token_hash,
      invite_expires_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      display_name = excluded.display_name,
      role = excluded.role,
      shares = excluded.shares,
      is_active = 1,
      invite_token_hash = excluded.invite_token_hash,
      invite_expires_at = excluded.invite_expires_at,
      updated_at = excluded.updated_at
  `),
  activateInvitedUser: db.prepare(`
    UPDATE users
    SET password_hash = ?,
        password_salt = ?,
        invite_token_hash = NULL,
        invite_expires_at = NULL,
        last_password_set_at = ?,
        updated_at = ?
    WHERE id = ?
  `),
  updateUser: db.prepare(`
    UPDATE users
    SET display_name = ?,
        role = ?,
        shares = ?,
        is_active = ?,
        updated_at = ?
    WHERE id = ?
  `),
};

function nowIso() {
  return new Date().toISOString();
}

function mapPublicUser(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    shares: row.shares,
    isActive: Boolean(row.is_active),
    inviteExpiresAt: row.invite_expires_at || null,
    lastPasswordSetAt: row.last_password_set_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hasUsers() {
  return statements.countUsers.get().count > 0;
}

function createInitialAdmin({ email, displayName, passwordHash, passwordSalt }) {
  const timestamp = nowIso();
  statements.insertInitialAdmin.run(
    email.trim().toLowerCase(),
    displayName.trim(),
    passwordHash,
    passwordSalt,
    timestamp,
    timestamp,
    timestamp
  );
  return mapPublicUser(statements.getUserByEmail.get(email));
}

function getUserByEmail(email) {
  return statements.getUserByEmail.get(email.trim().toLowerCase()) || null;
}

function getUserById(id) {
  return statements.getUserById.get(id) || null;
}

function getInviteInfo(tokenHash) {
  const user = statements.getUserByInviteHash.get(tokenHash);
  if (!user) {
    return null;
  }

  if (!user.invite_expires_at || user.invite_expires_at <= nowIso()) {
    return { expired: true };
  }

  return mapPublicUser(user);
}

function createSession(userId, tokenHash, expiresAt) {
  statements.deleteExpiredSessions.run(nowIso());
  statements.createSession.run(userId, tokenHash, expiresAt, nowIso());
}

function getSessionByTokenHash(tokenHash) {
  statements.deleteExpiredSessions.run(nowIso());
  const session = statements.getSessionByHash.get(tokenHash);
  if (!session) {
    return null;
  }
  if (session.expires_at <= nowIso() || !session.is_active) {
    statements.deleteSessionByHash.run(tokenHash);
    return null;
  }
  return {
    id: session.id,
    expiresAt: session.expires_at,
    createdAt: session.created_at,
    user: {
      id: session.user_id,
      email: session.email,
      displayName: session.display_name,
      role: session.role,
      shares: session.shares,
      isActive: Boolean(session.is_active),
    },
  };
}

function deleteSession(tokenHash) {
  statements.deleteSessionByHash.run(tokenHash);
}

function listUsers() {
  return statements.listUsers.all().map(mapPublicUser);
}

function inviteUser({ email, displayName, role, shares, inviteTokenHash, inviteExpiresAt }) {
  const timestamp = nowIso();
  statements.inviteUser.run(
    email.trim().toLowerCase(),
    displayName.trim(),
    role,
    shares,
    inviteTokenHash,
    inviteExpiresAt,
    timestamp,
    timestamp
  );
  return mapPublicUser(statements.getUserByEmail.get(email));
}

function activateUserFromInvite({ tokenHash, passwordHash, passwordSalt }) {
  const user = statements.getUserByInviteHash.get(tokenHash);
  if (!user) {
    return null;
  }
  if (!user.invite_expires_at || user.invite_expires_at <= nowIso()) {
    return { expired: true };
  }

  const timestamp = nowIso();
  statements.activateInvitedUser.run(passwordHash, passwordSalt, timestamp, timestamp, user.id);
  return mapPublicUser(statements.getUserById.get(user.id));
}

function updateUser({ id, displayName, role, shares, isActive }) {
  statements.updateUser.run(
    displayName.trim(),
    role,
    shares,
    isActive ? 1 : 0,
    nowIso(),
    id
  );
  return mapPublicUser(statements.getUserById.get(id));
}

module.exports = {
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
  mapPublicUser,
  updateUser,
};
