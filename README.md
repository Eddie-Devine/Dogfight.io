# Dogfight.io
A 2D dogfighting IO game for the browser.

## Development

- `npm start` (or `sudo npm start` if you keep nginx on ports 80/443) launches the entire stack via `scripts/manage-stack.js`, which starts nginx with the repo’s `nginx.conf` and then spawns `node Server.js`.
- `npm run stop` stops nginx in case it was left running (handy if the stack crashed).
- `node Server.js` still boots both the Express API/static server (default `HTTP_PORT=3000`) and the standalone WebSocket server (`WS_PORT=3001`) without nginx if you prefer to run them directly.
- The HTTP server now prefers HTTPS: if `SSL/key.pem` and `SSL/cert.pem` exist it serves TLS automatically. Set `USE_HTTPS=false` explicitly if you ever need to fall back to plain HTTP (e.g., local debugging without certs). Override cert paths via `HTTPS_KEY`/`HTTPS_CERT`.
- Cookies remain `secure` by default so production sessions only work over HTTPS. For local plain-HTTP testing you can temporarily set `COOKIE_SECURE=false`.

## Nginx gateway

Dogfight.io is designed to sit behind nginx (or any reverse proxy) that acts as the public TLS endpoint. Use `nginx.example.conf` as a template: proxy regular HTTP traffic to `127.0.0.1:3000` and forward `/ws/` (with upgrade headers) to the WebSocket server on `127.0.0.1:3001`. Update the `server_name` and certificate paths to match your environment, then enable the site via your distro’s nginx tooling.
