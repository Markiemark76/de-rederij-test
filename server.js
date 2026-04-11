const http = require("http");
const path = require("path");
const fsp = require("fs/promises");

const HOST = "127.0.0.1";
const PORT = process.env.PORT ? Number(process.env.PORT) : 3100;
const ROOT = __dirname;

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
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
});
