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

  // Build nginx.conf
  let conf = `# Auto-generated by Odoo 17 Installer
# DO NOT EDIT — regenerated on each Start/Stop

worker_processes 1;

events {
    worker_connections 1024;
}

http {
    sendfile on;
    keepalive_timeout 65;
    client_max_body_size 200m;

    # Upstream timeout for Odoo
    proxy_connect_timeout 600;
    proxy_send_timeout 600;
    proxy_read_timeout 600;

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

        location / {
            proxy_pass http://127.0.0.1:${p.port};
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_redirect off;
        }

        location /longpolling/ {
            proxy_pass http://127.0.0.1:${lpPort};
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_read_timeout 3600;
        }

        location /websocket {
            proxy_pass http://127.0.0.1:${lpPort};
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection $connection_upgrade;
            proxy_set_header Host $host;
            proxy_read_timeout 3600;
        }
    }

`;
    }

    // HTTP redirect to HTTPS (or direct proxy if no SSL)
    conf += `    server {
        listen 80;
        server_name ${p.domain};
        ${hasSsl ? 'return 301 https://$host$request_uri;' : `
        location / {
            proxy_pass http://127.0.0.1:${p.port};
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
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
