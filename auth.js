const crypto = require("crypto");

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return {
    salt,
    hash: derivedKey.toString("hex"),
  };
}

function verifyPassword(password, storedHash, salt) {
  if (!storedHash || !salt) {
    return false;
  }

  const derivedKey = crypto.scryptSync(password, salt, 64);
  const storedBuffer = Buffer.from(storedHash, "hex");

  if (derivedKey.length !== storedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(derivedKey, storedBuffer);
}

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

module.exports = {
  generateToken,
  hashPassword,
  hashToken,
  verifyPassword,
};
