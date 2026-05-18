import * as fs from 'fs';

/**
 * Config migration cho odoo.conf (Odoo 15/17/18/19).
 *
 * Mục tiêu: sửa các project cũ mà user không sửa tay, không phá giá trị user tự chọn.
 *
 * 2 loại thay đổi:
 *   1) DELETE_KEYS: xóa các option không hợp lệ / đã bị Odoo 19 remove
 *      → spam warning "unknown option" và "reads 'False' isn't boolean".
 *      An toàn tuyệt đối vì Odoo đã ignore chúng.
 *
 *   2) FORCE_KEYS: ghi đè các option "quan trọng" (tối ưu hoặc bắt buộc).
 *      Chỉ overwrite khi giá trị hiện tại KHÔNG phù hợp (ví dụ limit_time_cpu=86400).
 *      KHÔNG đụng vào: http_port, db_*, admin_passwd, data_dir, dbfilter,
 *      addons_path, server_wide_modules, project_domain, odoo_version.
 */

/** Options đã bị Odoo 19 remove hoặc chỉ gây spam warning */
const DELETE_KEYS: readonly string[] = [
  // Removed options
  'osv_memory_age_limit',
  'osv_memory_count_limit',
  'translate_modules',
  'max_file_size',
  'http_socket_timeout',
  'demo',
  // 'False' placeholders trên boolean/optional fields → ignore bởi Odoo, chỉ spam log
  'db_name',
  'logfile',
  'email_from',
  'from_filter',
  'log_db',
  'smtp_password',
  'smtp_user',
  'smtp_ssl_certificate_filename',
  'smtp_ssl_private_key_filename',
  // Empty / default options không cần giữ
  'import_partial',
  'pidfile',
  'upgrade_path',
  'test_file',
  'test_tags',
  'reportgz',
  'syslog',
];

/**
 * Options quan trọng — force set khi giá trị hiện tại bị lỗi/quá cao.
 * Trả `undefined` = KHÔNG override (giữ giá trị user).
 */
function getForceValue(key: string, current: string, platform: NodeJS.Platform): string | undefined {
  switch (key) {
    case 'http_interface':
      // Empty gây warning "using 0.0.0.0 by default". Set 127.0.0.1.
      return !current ? '127.0.0.1' : undefined;

    case 'limit_time_cpu':
      // 86400s = 24h (value cũ trong template) — giảm xuống 3600s (1h).
      // Đủ cho install module lớn, migration. Match nginx 24h proxy timeout
      // (nginx chờ, Odoo kill sau 1h để không leak worker).
      return parseInt(current, 10) >= 86400 ? '3600' : undefined;

    case 'limit_time_real':
      // 86400s → 7200s (2h).
      return parseInt(current, 10) >= 86400 ? '7200' : undefined;

    case 'limit_request':
      // 0 = unlimited, gây leak request. Set 8192.
      return current === '0' || !current ? '8192' : undefined;

    case 'limit_memory_hard':
      // 10GB cũ → giảm xuống 2.5GB
      return parseInt(current, 10) >= 10737418240 ? '2684354560' : undefined;

    case 'limit_memory_soft':
      return parseInt(current, 10) >= 10737418240 ? '2147483648' : undefined;

    case 'unaccent':
      // False cũ → True (hầu hết use case cần unaccent search)
      return current === 'False' || !current ? 'True' : undefined;

    case 'db_maxconn':
      // Odoo 19 discuss/bus module cần ít nhất 128. Giá trị < 128 (bao gồm 8 và 64
      // từ các version migrator cũ) gây PoolError khi nhiều request đồng thời.
      return parseInt(current, 10) < 128 ? '128' : undefined;

    case 'workers': {
      // Windows: FORCE workers=0. Prefork (workers>=1) không chạy native trên Windows,
      // gây lỗi 'orm_signaling_registry does not exist' liên tục + response chậm/timeout.
      // User deploy Linux prod sẽ chỉnh trực tiếp trên server, không dùng Electron app này.
      if (platform === 'win32' && parseInt(current, 10) > 0) {
        return '0';
      }
      return undefined;
    }

    // DISABLED: không tự migrate db_sslmode/dev_mode để tránh thay đổi behavior
    // đột ngột trên project cũ. User muốn tối ưu thì sửa thủ công trong odoo.conf:
    //   - db_sslmode = disable (cho localhost, bỏ handshake)
    //   - dev_mode = (rỗng, không có reload/qweb/xml — tăng tốc backend)

    default:
      return undefined;
  }
}

export interface MigrationResult {
  readonly changed: boolean;
  readonly deletedKeys: readonly string[];
  readonly forcedKeys: readonly { key: string; from: string; to: string }[];
  readonly warnings: readonly string[];
}

/**
 * Migrate an existing odoo.conf in place. Preserves:
 *   - Comment lines at top (project_domain, odoo_version markers)
 *   - All keys not in DELETE_KEYS or FORCE logic
 *   - User-chosen values for http_port, db_*, paths, etc.
 *
 * @param odooVersion Version để thêm `; odoo_version = X` marker nếu file thiếu.
 *                    Dashboard dùng marker này để filter project theo version.
 */
export function migrateOdooConf(
  confFile: string,
  platform: NodeJS.Platform = process.platform,
  odooVersion?: string,
): MigrationResult {
  if (!fs.existsSync(confFile)) {
    return { changed: false, deletedKeys: [], forcedKeys: [], warnings: ['File not found'] };
  }

  const raw = fs.readFileSync(confFile, 'utf8');
  const lines = raw.split(/\r?\n/);

  // Check if marker comments exist (dashboard filter + domain detection depend on these)
  const hasVersionMarker = /^;\s*odoo_version\s*=\s*\d+/m.test(raw);
  const hasDomainMarker = /^;\s*project_domain\s*=/m.test(raw);

  const deletedKeys: string[] = [];
  const forcedKeys: { key: string; from: string; to: string }[] = [];
  const warnings: string[] = [];
  const outputLines: string[] = [];
  const seenKeys = new Set<string>();
  let inOptions = false;
  let strippedNonAscii = false;

  // Python configparser on Windows reads odoo.conf with cp1252 encoding by default
  // and CRASHES on UTF-8 diacritics (`UnicodeDecodeError: byte 0x90`). Strip any
  // non-ASCII chars from comments — preserves structure, removes only diacritics.
  const toAscii = (line: string): string => {
    const trimmed = line.trim();
    if (!trimmed.startsWith(';') && !trimmed.startsWith('#')) return line;
    if (/^[\x00-\x7F]*$/.test(line)) return line;
    strippedNonAscii = true;
    // Normalize + remove combining marks, then drop any remaining non-ASCII.
    return line.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\x00-\x7F]/g, '');
  };

  for (const rawLine of lines) {
    const line = toAscii(rawLine);
    const trimmed = line.trim();

    // Preserve blank lines + comments + section headers verbatim
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) {
      outputLines.push(line);
      continue;
    }
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      inOptions = sectionMatch[1] === 'options';
      outputLines.push(line);
      continue;
    }

    if (!inOptions || !trimmed.includes('=')) {
      outputLines.push(line);
      continue;
    }

    const eqIdx = trimmed.indexOf('=');
    const key = trimmed.substring(0, eqIdx).trim();
    const value = trimmed.substring(eqIdx + 1).trim();

    // 1) Delete deprecated keys
    if (DELETE_KEYS.includes(key)) {
      deletedKeys.push(key);
      continue;
    }

    seenKeys.add(key);

    // 2) Force-overwrite important keys
    const forced = getForceValue(key, value, platform);
    if (forced !== undefined && forced !== value) {
      forcedKeys.push({ key, from: value, to: forced });
      outputLines.push(`${key} = ${forced}`);
      continue;
    }

    outputLines.push(line);
  }

  // Warn (not force) about workers>0 on Windows
  if (platform === 'win32') {
    const workersLine = outputLines.find(l => l.trim().match(/^workers\s*=/));
    if (workersLine) {
      const val = workersLine.split('=')[1]?.trim();
      if (val && parseInt(val, 10) > 0) {
        warnings.push(
          `workers=${val} trên Windows có thể gây lỗi 'orm_signaling_registry does not exist' ` +
          `và chậm. Khuyến nghị đặt workers=0 trong odoo.conf.`
        );
      }
    }
  }

  // Ensure http_interface present if missing (add before [options] keys dropped)
  if (!seenKeys.has('http_interface')) {
    // Insert after [options] header
    const optionsIdx = outputLines.findIndex(l => l.trim() === '[options]');
    if (optionsIdx >= 0) {
      outputLines.splice(optionsIdx + 1, 0, 'http_interface = 127.0.0.1');
      forcedKeys.push({ key: 'http_interface', from: '(missing)', to: '127.0.0.1' });
    }
  }

  // Prepend missing marker comments — dashboard filters projects by `; odoo_version`
  // và đọc domain từ `; project_domain`. Nếu thiếu, project bị ẩn khỏi tab version
  // tương ứng trong Dashboard.
  let markerAdded = false;
  if (odooVersion && !hasVersionMarker) {
    outputLines.unshift(`; odoo_version = ${odooVersion}`);
    forcedKeys.push({ key: '; odoo_version', from: '(missing)', to: odooVersion });
    markerAdded = true;
  }
  if (!hasDomainMarker) {
    // Extract dbfilter giá trị để gợi ý project_domain. Nếu không có, để trống.
    const dbfilterMatch = raw.match(/^dbfilter\s*=\s*\^([a-z0-9_-]+)/im);
    const projectName = dbfilterMatch?.[1]?.replace(/\[.*?\]/g, '_') || '';
    if (projectName) {
      const version = odooVersion || '19';
      outputLines.unshift(`; project_domain = ${projectName}.odoo${version}.local`);
      forcedKeys.push({ key: '; project_domain', from: '(missing)', to: `${projectName}.odoo${version}.local` });
      markerAdded = true;
    }
  }

  if (strippedNonAscii) {
    warnings.push(
      'Stripped non-ASCII chars from comments to avoid cp1252 UnicodeDecodeError on Windows.'
    );
  }

  const changed = deletedKeys.length > 0 || forcedKeys.length > 0 || markerAdded || strippedNonAscii;
  if (changed) {
    const newContent = outputLines.join('\n');
    // Write as latin1 to guarantee cp1252-compatible bytes on Windows.
    // Stripping non-ASCII above ensures no data loss.
    fs.writeFileSync(confFile, newContent, 'latin1');
  }

  return { changed, deletedKeys, forcedKeys, warnings };
}
