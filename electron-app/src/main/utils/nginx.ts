import * as fs from 'fs';
import * as path from 'path';
import { runCmd } from './shell';
import { downloadFile } from './download';
import { LoggerService } from '../services/logger';

// ---------------------------------------------------------------------------
// Nginx Reverse Proxy Manager
// HTTPS reverse proxy for *.odoo.local domains with longpolling support
//
// Each project: https://project.odoo.local → http://localhost:port
// Longpolling:  https://project.odoo.local/longpolling → localhost:longpolling_port
// Websocket:    https://project.odoo.local/websocket → localhost:longpolling_port
// ---------------------------------------------------------------------------

const NGINX_VERSION = '1.27.4';
const NGINX_URL = `https://nginx.org/download/nginx-${NGINX_VERSION}.zip`;
const NGINX_DIR_NAME = 'nginx';

export interface NginxProject {
  readonly domain: string;
  readonly port: string;
  readonly longpollingPort: string;
}

export function getNginxDir(baseDir: string): string {
  return path.join(baseDir, NGINX_DIR_NAME);
}

export function getNginxExe(baseDir: string): string {
  return path.join(getNginxDir(baseDir), `nginx-${NGINX_VERSION}`, 'nginx.exe');
}

export function isNginxInstalled(baseDir: string): boolean {
  return fs.existsSync(getNginxExe(baseDir));
}

/**
 * Find Nginx across multiple base directories.
 * Returns the baseDir where Nginx is found, or null.
 */
export function findNginxAcrossBaseDirs(baseDirs: readonly string[]): string | null {
  for (const dir of baseDirs) {
    if (fs.existsSync(getNginxExe(dir))) return dir;
  }
  return null;
}

function getSslDir(baseDir: string): string {
  return path.join(getNginxDir(baseDir), 'ssl');
}

function getConfDir(baseDir: string): string {
  return path.join(getNginxDir(baseDir), `nginx-${NGINX_VERSION}`, 'conf');
}

// ---------------------------------------------------------------------------
// Self-signed SSL certificate generation using OpenSSL (bundled with Git)
// ---------------------------------------------------------------------------

function findOpenssl(): string | null {
  const candidates = [
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function generateSslCert(baseDir: string, domain: string, logger: LoggerService): Promise<boolean> {
  const sslDir = getSslDir(baseDir);
  fs.mkdirSync(sslDir, { recursive: true });

  const keyFile = path.join(sslDir, `${domain}.key`);
  const crtFile = path.join(sslDir, `${domain}.crt`);

  // If cert exists, ensure it's trusted and return
  if (fs.existsSync(keyFile) && fs.existsSync(crtFile)) {
    // Remove old entries then re-add (handles cert regeneration)
    await runCmd(`certutil -delstore "Root" "${domain}"`);
    await runCmd(`certutil -addstore -f "Root" "${crtFile}"`);
    return true;
  }

  const openssl = findOpenssl();
  if (!openssl) {
    logger.log('  > OpenSSL not found (install Git to get it). Skipping SSL cert.');
    return false;
  }

  // Create config file for proper cert extensions (Chrome requires these)
  const confFile = path.join(sslDir, `${domain}.cnf`);
  const confContent = `[req]
distinguished_name = req_dn
x509_extensions = v3_ca
prompt = no

[req_dn]
CN = ${domain}

[v3_ca]
subjectAltName = DNS:${domain}
basicConstraints = CA:TRUE
keyUsage = digitalSignature, keyEncipherment, keyCertSign
extendedKeyUsage = serverAuth
`;
  fs.writeFileSync(confFile, confContent, 'utf8');

  const { code } = await runCmd(
    `"${openssl}" req -x509 -nodes -days 3650 -newkey rsa:2048 ` +
    `-keyout "${keyFile}" -out "${crtFile}" ` +
    `-config "${confFile}"`
  );

  // Cleanup config
  if (fs.existsSync(confFile)) fs.unlinkSync(confFile);

  if (code !== 0 || !fs.existsSync(crtFile)) return false;

  // Import cert to Windows Trusted Root CA store (requires Admin)
  // Delete old entries first, then add new
  await runCmd(`certutil -delstore "Root" "${domain}"`);
  const { code: trustCode } = await runCmd(
    `certutil -addstore -f "Root" "${crtFile}"`
  );
  if (trustCode === 0) {
    logger.log(`  > SSL cert for ${domain} trusted by Windows.`);
  } else {
    logger.log(`  > SSL cert created but not trusted (run as Admin to trust).`);
  }

  return true;
}

/** Public wrapper: generate + trust SSL cert for a domain (called during project creation) */
export async function generateSslCertForDomain(baseDir: string, domain: string, logger: LoggerService): Promise<boolean> {
  return generateSslCert(baseDir, domain, logger);
}

// ---------------------------------------------------------------------------
// Install Nginx
// ---------------------------------------------------------------------------

export async function installNginx(baseDir: string, logger: LoggerService): Promise<boolean> {
  const nginxDir = getNginxDir(baseDir);
  const nginxExe = getNginxExe(baseDir);

  if (fs.existsSync(nginxExe)) {
    logger.log('Nginx already installed.');
    return true;
  }

  fs.mkdirSync(nginxDir, { recursive: true });
  logger.log('Downloading Nginx...');

  try {
    const zipPath = path.join(nginxDir, 'nginx.zip');
    await downloadFile(NGINX_URL, zipPath, logger, 'install_nginx');

    if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size < 500_000) {
      if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
      throw new Error('Download failed or file too small');
    }

    logger.log('  > Extracting...');
    await runCmd(`powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${nginxDir}' -Force"`);

    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

    if (!fs.existsSync(nginxExe)) {
      throw new Error('Extract failed — nginx.exe not found');
    }

    logger.log('Nginx installed!');
    return true;
  } catch (e) {
    logger.log(`  > Nginx install failed: ${e}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Generate nginx.conf
// ---------------------------------------------------------------------------

export async function generateNginxConfig(
  baseDir: string,
  projects: readonly NginxProject[],
  logger: LoggerService,
): Promise<string> {
  const confDir = getConfDir(baseDir);
  const confPath = path.join(confDir, 'nginx.conf');
  const sslDir = getSslDir(baseDir);

  fs.mkdirSync(confDir, { recursive: true });
  fs.mkdirSync(sslDir, { recursive: true });

  // Generate SSL certs for each project domain
  for (const p of projects) {
    if (p.domain) {
      await generateSslCert(baseDir, p.domain, logger);
    }
  }

  // Write service worker killswitch — force browser unregister stale Odoo SW.
  // Background: Odoo 19 (và một số custom addon) đăng ký SW tại /web/service-worker.js.
  // Khi git pull source mới, endpoint có thể đổi/bỏ → SW cũ trong browser vẫn intercept
  // request và serve cached 502/stale response → page xoay vô tận.
  // File này được serve thay cho Odoo endpoint: SW mới sẽ unregister chính nó +
  // xóa toàn bộ cache, ép browser tải trực tiếp từ network.
  const swKillswitchPath = path.join(confDir, 'sw-killswitch.js').replace(/\\/g, '/');
  const swKillswitchJs = `// Auto-generated SW killswitch by Odoo Installer.
// Unregisters self and clears caches so browser stops intercepting Odoo requests.
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach((c) => { try { c.navigate(c.url); } catch (_) {} });
    } catch (_) { /* best effort */ }
  })());
});
// Pass-through fetch — never serve from cache.
self.addEventListener('fetch', () => { /* no-op */ });
`;
  fs.writeFileSync(swKillswitchPath, swKillswitchJs, 'utf8');

  // Build nginx.conf
  // Timeout default 86400s (24h) — đủ cho các tác vụ nặng của Odoo:
  //   - Install/update module lớn (migration, seed data)
  //   - DB backup/restore file lớn
  //   - Import CSV/Excel nhiều triệu dòng
  //   - Generate report PDF hàng loạt
  // Nếu cần ngắn hơn cho prod (tránh DoS slowloris), chỉnh xuống 3600-7200.
  const TIMEOUT = 86400;
  let conf = `# Auto-generated by Odoo 17 Installer
# DO NOT EDIT — regenerated on each Start/Stop

worker_processes auto;

events {
    worker_connections 2048;
}

http {
    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 300;
    keepalive_requests 1000;
    client_max_body_size 0;
    client_body_timeout ${TIMEOUT};
    client_header_timeout ${TIMEOUT};

    # Upstream timeout cho tác vụ nặng (backup/restore/install module/import lớn)
    proxy_connect_timeout ${TIMEOUT};
    proxy_send_timeout ${TIMEOUT};
    proxy_read_timeout ${TIMEOUT};
    send_timeout ${TIMEOUT};

    # Default: buffer upload bodies tắt (Odoo dùng streaming cho file lớn),
    # nhưng response buffering BẬT mặc định để gửi nhanh static asset.
    # /longpolling/ và /websocket sẽ override proxy_buffering off ở location riêng.
    proxy_request_buffering off;
    proxy_buffering on;
    proxy_buffer_size 64k;
    proxy_buffers 16 64k;
    proxy_busy_buffers_size 128k;

    # Nén response — quan trọng cho Odoo asset bundle (JS/CSS 5–10MB)
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_min_length 1024;
    gzip_comp_level 6;
    gzip_types
        text/plain text/css text/xml text/javascript
        application/javascript application/x-javascript application/json
        application/xml application/xml+rss application/wasm
        font/ttf font/otf font/woff font/woff2
        image/svg+xml image/x-icon;

    # Long domain names (e.g. project-name.odoo17.local) need larger bucket
    server_names_hash_bucket_size 128;

    map $http_upgrade $connection_upgrade {
        default upgrade;
        '' close;
    }

`;

  for (const p of projects) {
    if (!p.domain || !p.port) continue;

    const keyFile = path.join(sslDir, `${p.domain}.key`).replace(/\\/g, '/');
    const crtFile = path.join(sslDir, `${p.domain}.crt`).replace(/\\/g, '/');
    const hasSsl = fs.existsSync(keyFile) && fs.existsSync(crtFile);
    const lpPort = p.longpollingPort || String(parseInt(p.port, 10) + 3);

    if (hasSsl) {
      conf += `    # ${p.domain} (HTTPS)
    server {
        listen 443 ssl;
        server_name ${p.domain};

        ssl_certificate "${crtFile}";
        ssl_certificate_key "${keyFile}";
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_session_cache shared:SSL:10m;
        ssl_session_timeout 1d;

        client_max_body_size 0;

        # Service worker killswitch — phải đặt TRƯỚC location /
        # exact-match \`=\` → ưu tiên cao nhất, không bị regex location bên dưới chiếm.
        location = /web/service-worker.js {
            alias "${swKillswitchPath}";
            default_type application/javascript;
            add_header Service-Worker-Allowed "/" always;
            add_header Cache-Control "no-store, no-cache, must-revalidate, max-age=0" always;
        }

        # Static assets — buffer + browser cache (giảm tải Odoo, F5 nhanh)
        # /web/assets/<version>/... có hash version nên cache lâu an toàn.
        # /web/static/ là source file, cache ngắn hơn.
        location ~* ^/(web/assets|website/image/website\\.s_)/ {
            proxy_pass http://127.0.0.1:${p.port};
            proxy_http_version 1.1;
            proxy_set_header Connection "";
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_buffering on;
            expires 30d;
            add_header Cache-Control "public, immutable";
        }

        location ~* ^/web/static/ {
            proxy_pass http://127.0.0.1:${p.port};
            proxy_http_version 1.1;
            proxy_set_header Connection "";
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_buffering on;
            expires 7d;
            add_header Cache-Control "public";
        }

        location / {
            proxy_pass http://127.0.0.1:${p.port};
            proxy_http_version 1.1;
            proxy_set_header Connection "";
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_redirect off;
            proxy_buffering on;
            proxy_connect_timeout ${TIMEOUT};
            proxy_read_timeout ${TIMEOUT};
            proxy_send_timeout ${TIMEOUT};
        }

        location /longpolling/ {
            proxy_pass http://127.0.0.1:${p.port};
            proxy_http_version 1.1;
            proxy_set_header Connection "";
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_buffering off;
            proxy_read_timeout ${TIMEOUT};
            proxy_send_timeout ${TIMEOUT};
        }

        location /websocket {
            proxy_pass http://127.0.0.1:${p.port};
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection $connection_upgrade;
            proxy_set_header Host $host;
            proxy_buffering off;
            proxy_read_timeout 7200s;
            proxy_connect_timeout 7200s;
            proxy_send_timeout 7200s;
        }
    }

`;
    }

    // HTTP redirect to HTTPS (or direct proxy if no SSL)
    conf += `    server {
        listen 80;
        server_name ${p.domain};
        ${hasSsl ? 'return 301 https://$host$request_uri;' : `
        client_max_body_size 0;

        location = /web/service-worker.js {
            alias "${swKillswitchPath}";
            default_type application/javascript;
            add_header Service-Worker-Allowed "/" always;
            add_header Cache-Control "no-store, no-cache, must-revalidate, max-age=0" always;
        }

        location ~* ^/(web/assets|website/image/website\\.s_)/ {
            proxy_pass http://127.0.0.1:${p.port};
            proxy_http_version 1.1;
            proxy_set_header Connection "";
            proxy_set_header Host $host;
            proxy_buffering on;
            expires 30d;
            add_header Cache-Control "public, immutable";
        }

        location ~* ^/web/static/ {
            proxy_pass http://127.0.0.1:${p.port};
            proxy_http_version 1.1;
            proxy_set_header Connection "";
            proxy_set_header Host $host;
            proxy_buffering on;
            expires 7d;
            add_header Cache-Control "public";
        }

        location / {
            proxy_pass http://127.0.0.1:${p.port};
            proxy_http_version 1.1;
            proxy_set_header Connection "";
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_buffering on;
            proxy_connect_timeout ${TIMEOUT};
            proxy_read_timeout ${TIMEOUT};
            proxy_send_timeout ${TIMEOUT};
        }

        location /longpolling/ {
            proxy_pass http://127.0.0.1:${p.port};
            proxy_http_version 1.1;
            proxy_set_header Connection "";
            proxy_set_header Host $host;
            proxy_buffering off;
            proxy_read_timeout ${TIMEOUT};
            proxy_send_timeout ${TIMEOUT};
        }

        location /websocket {
            proxy_pass http://127.0.0.1:${p.port};
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection $connection_upgrade;
            proxy_set_header Host $host;
            proxy_buffering off;
            proxy_read_timeout ${TIMEOUT};
            proxy_send_timeout ${TIMEOUT};
        }`}
    }

`;
  }

  conf += '}\n';

  fs.writeFileSync(confPath, conf, 'utf8');
  return confPath;
}

// ---------------------------------------------------------------------------
// Start / Reload / Stop Nginx
// ---------------------------------------------------------------------------

export async function startNginx(baseDir: string, logger: LoggerService): Promise<boolean> {
  const nginxExe = getNginxExe(baseDir);
  const nginxRoot = path.dirname(nginxExe);

  if (!fs.existsSync(nginxExe)) {
    logger.log('  > Nginx not installed, skipping reverse proxy.');
    return false;
  }

  // Try reload first (if already running)
  const { code: reloadCode } = await runCmd(`"${nginxExe}" -s reload`, nginxRoot);
  if (reloadCode === 0) {
    logger.log('  > Nginx reloaded with new config.');
    return true;
  }

  // Start fresh
  logger.log('  > Starting Nginx...');
  const { exec: execChild } = require('child_process');
  execChild(`"${nginxExe}"`, {
    cwd: nginxRoot,
    windowsHide: true,
  });

  await new Promise(resolve => setTimeout(resolve, 1000));
  logger.log('  > Nginx HTTPS proxy started.');
  return true;
}

export async function stopNginx(baseDir: string, logger: LoggerService): Promise<void> {
  const nginxExe = getNginxExe(baseDir);
  if (fs.existsSync(nginxExe)) {
    await runCmd(`"${nginxExe}" -s quit`, path.dirname(nginxExe));
    logger.log('  > Nginx stopped.');
  }
}
