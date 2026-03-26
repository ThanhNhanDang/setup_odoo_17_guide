import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Windows hosts file management
// C:\Windows\System32\drivers\etc\hosts
// ---------------------------------------------------------------------------

const HOSTS_PATH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
const MARKER_START = '# === Odoo 17 Installer - DO NOT EDIT ===';
const MARKER_END = '# === End Odoo 17 Installer ===';

/**
 * Read all Odoo domain entries from hosts file.
 */
export function getOdooHostEntries(): Array<{ domain: string; ip: string }> {
  try {
    const content = fs.readFileSync(HOSTS_PATH, 'utf8');
    const entries: Array<{ domain: string; ip: string }> = [];
    let inBlock = false;
    for (const line of content.split('\n')) {
      if (line.trim() === MARKER_START) { inBlock = true; continue; }
      if (line.trim() === MARKER_END) { inBlock = false; continue; }
      if (inBlock) {
        const match = line.trim().match(/^(\S+)\s+(\S+)/);
        if (match) entries.push({ ip: match[1], domain: match[2] });
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Add a domain entry to the hosts file.
 */
export function addHostEntry(domain: string, ip: string = '127.0.0.1'): { ok: boolean; msg: string } {
  try {
    let content = fs.readFileSync(HOSTS_PATH, 'utf8');

    // Check if domain already exists
    const existing = getOdooHostEntries();
    if (existing.some(e => e.domain === domain)) {
      return { ok: true, msg: 'Already exists' };
    }

    // Find or create our managed block
    if (!content.includes(MARKER_START)) {
      content = content.trimEnd() + '\n\n' + MARKER_START + '\n' + MARKER_END + '\n';
    }

    // Insert entry before end marker
    const entry = `${ip}\t${domain}`;
    content = content.replace(MARKER_END, `${entry}\n${MARKER_END}`);

    fs.writeFileSync(HOSTS_PATH, content, 'utf8');
    return { ok: true, msg: `Added ${domain}` };
  } catch (e: any) {
    if (e.code === 'EPERM' || e.code === 'EACCES') {
      return { ok: false, msg: 'Need admin rights to modify hosts file' };
    }
    return { ok: false, msg: String(e) };
  }
}

/**
 * Remove a domain entry from the hosts file.
 */
export function removeHostEntry(domain: string): { ok: boolean; msg: string } {
  try {
    let content = fs.readFileSync(HOSTS_PATH, 'utf8');
    const lines = content.split('\n');
    const filtered = lines.filter(line => {
      const trimmed = line.trim();
      return !(trimmed.includes(domain) && !trimmed.startsWith('#'));
    });
    fs.writeFileSync(HOSTS_PATH, filtered.join('\n'), 'utf8');
    return { ok: true, msg: `Removed ${domain}` };
  } catch (e: any) {
    return { ok: false, msg: String(e) };
  }
}

/**
 * Generate domain name from project name.
 */
export function projectToDomain(projectName: string): string {
  return projectName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase() + '.odoo.local';
}
