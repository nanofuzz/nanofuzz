import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as net from "net";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

export class FuzzPanelTestServer {
  private _server: http.Server;
  private _port = 0;
  private _htmlProvider: () => string;

  constructor(htmlProvider: () => string) {
    this._htmlProvider = htmlProvider;
    this._server = http.createServer((req, res) => {
      const cleanPath = req.url?.split("?")[0] ?? "/";

      // Root path returns current HTML
      if (cleanPath === "/" || cleanPath === "/index.html") {
        const html = this._htmlProvider();
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": Buffer.byteLength(html, "utf8"),
        });
        res.end(html);
        return;
      }

      // Resolve static asset from repository root
      const relPath = cleanPath.startsWith("/") ? cleanPath.slice(1) : cleanPath;
      const fullPath = path.resolve(process.cwd(), relPath);

      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        const ext = path.extname(fullPath).toLowerCase();
        const contentType = MIME_TYPES[ext] || "application/octet-stream";
        const stat = fs.statSync(fullPath);

        res.writeHead(200, {
          "Content-Type": contentType,
          "Content-Length": stat.size,
        });
        fs.createReadStream(fullPath).pipe(res);
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      }
    });
  }

  public async start(): Promise<string> {
    return new Promise((resolve, reject) => {
      this._server.listen(0, "127.0.0.1", () => {
        const addr = this._server.address() as net.AddressInfo;
        this._port = addr.port;
        resolve(`http://127.0.0.1:${this._port}/`);
      });
      this._server.on("error", reject);
    });
  }

  public async stop(): Promise<void> {
    return new Promise((resolve) => {
      this._server.close(() => resolve());
    });
  }
}
