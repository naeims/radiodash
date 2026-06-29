const crypto = require("crypto");

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireApiToken(req, res, next) {
  if (req.method === "OPTIONS") {
    return next();
  }

  const authHeader = req.headers["authorization"] || "";
  const xToken = req.headers["x-api-token"] || "";

  let provided = "";
  if (authHeader.startsWith("Bearer ")) {
    provided = authHeader.slice(7);
  } else if (xToken) {
    provided = xToken;
  }

  const expected = process.env.API_TOKEN || "";

  if (!expected || !provided || !timingSafeEqual(provided, expected)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

function requireAdmin(req, res, next) {
  const authHeader = req.headers["authorization"] || "";

  if (!authHeader.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="RadioDash Admin"');
    return res.status(401).json({ error: "Unauthorized" });
  }

  const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
  const colonIdx = decoded.indexOf(":");
  if (colonIdx === -1) {
    res.set("WWW-Authenticate", 'Basic realm="RadioDash Admin"');
    return res.status(401).json({ error: "Unauthorized" });
  }

  const user = decoded.slice(0, colonIdx);
  const pass = decoded.slice(colonIdx + 1);

  const expectedUser = process.env.ADMIN_USER || "";
  const expectedPass = process.env.ADMIN_PASSWORD || "";

  if (
    !expectedUser ||
    !expectedPass ||
    !timingSafeEqual(user, expectedUser) ||
    !timingSafeEqual(pass, expectedPass)
  ) {
    res.set("WWW-Authenticate", 'Basic realm="RadioDash Admin"');
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

module.exports = { requireApiToken, requireAdmin };
