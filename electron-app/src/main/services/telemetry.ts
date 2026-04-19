// ---------------------------------------------------------------------------
// Telemetry Service — Background event tracking with offline-first support
// Pushes events to Supabase. Falls back to local JSON file when offline.
// ---------------------------------------------------------------------------

import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { app } from 'electron';

// --- Supabase Configuration ---
const SUPABASE_URL = 'https://uxmehzxanzlpmrgpjfte.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV4bWVoenhhbnpscG1yZ3BqZnRlIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NjU4MjUyOSwiZXhwIjoyMDkyMTU4NTI5fQ.eEWlJ98b6esUMceTWLlCnf00-bwdW6ph7AnrvoJLBS8';

// --- Admin Password Hash (SHA-256 of '123456aA@') ---
export const ADMIN_PASSWORD_HASH = '55de1e4b50da90d84249ab53f61a99a6959d4c6fd8a6c402670b4115c137beae';

// --- State ---
let _machineId = '';
let _osUsername = '';
let _flushTimer: ReturnType<typeof setInterval> | null = null;

function getOfflineLogPath(): string {
  return path.join(app.getPath('userData'), 'offline-logs.json');
}

// ---------------------------------------------------------------------------
// Supabase REST API helper (uses built-in Node.js https — no external deps)
// ---------------------------------------------------------------------------
function supabaseRequest(
  method: string,
  endpoint: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`/rest/v1/${endpoint}`, SUPABASE_URL);
    const payload = body ? JSON.stringify(body) : undefined;

    const headers: Record<string, string> = {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload).toString();

    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          let data: unknown;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ status: res.statusCode || 0, data });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Machine ID — uses node-machine-id for a unique hardware fingerprint
// ---------------------------------------------------------------------------
async function getMachineId(): Promise<string> {
  if (_machineId) return _machineId;
  try {
    const { machineIdSync } = require('node-machine-id');
    _machineId = machineIdSync(true); // true = original (not hashed)
  } catch {
    // Fallback: hash hostname + username + CPU model
    const raw = `${os.hostname()}-${os.userInfo().username}-${os.cpus()[0]?.model || ''}-${os.totalmem()}`;
    _machineId = crypto.createHash('sha256').update(raw).digest('hex').substring(0, 32);
  }
  return _machineId;
}

function getOsUsername(): string {
  if (!_osUsername) {
    try { _osUsername = os.userInfo().username; } catch { _osUsername = 'unknown'; }
  }
  return _osUsername;
}

// ---------------------------------------------------------------------------
// Initialize telemetry — upsert machine into users_machine table
// ---------------------------------------------------------------------------
export async function initTelemetry(): Promise<void> {
  try {
    const machineId = await getMachineId();
    const username = getOsUsername();
    const version = app.getVersion();

    await supabaseRequest('POST', 'users_machine', {
      machine_id: machineId,
      os_username: username,
      os_platform: `${os.platform()} ${os.release()}`,
      app_version: version,
      last_seen_at: new Date().toISOString(),
    }, {
      'Prefer': 'resolution=merge-duplicates',
    });

    console.log('[Telemetry] Machine registered:', machineId.substring(0, 8) + '...');
  } catch (e) {
    console.log('[Telemetry] Init failed (offline?):', (e as Error).message);
  }

  // Start auto-flush timer (every 60 seconds)
  if (!_flushTimer) {
    _flushTimer = setInterval(() => flushOfflineLogs(), 60_000);
  }
}

// ---------------------------------------------------------------------------
// Track an event — push to Supabase or save offline
// ---------------------------------------------------------------------------
export async function trackEvent(actionType: string, details: Record<string, unknown> = {}): Promise<void> {
  const machineId = await getMachineId();
  const logEntry = {
    machine_id: machineId,
    action_type: actionType,
    details,
    created_at: new Date().toISOString(),
  };

  try {
    const { status } = await supabaseRequest('POST', 'action_logs', logEntry, {
      'Prefer': 'return=minimal',
    });
    if (status >= 200 && status < 300) {
      return; // Success
    }
    throw new Error(`HTTP ${status}`);
  } catch {
    // Offline fallback — save to local JSON file
    appendOfflineLog(logEntry);
  }
}

// ---------------------------------------------------------------------------
// Offline log management
// ---------------------------------------------------------------------------
function appendOfflineLog(entry: Record<string, unknown>): void {
  try {
    const filePath = getOfflineLogPath();
    let logs: Record<string, unknown>[] = [];
    if (fs.existsSync(filePath)) {
      try {
        logs = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch { logs = []; }
    }
    logs.push(entry);
    // Cap at 10,000 entries to prevent unbounded growth
    if (logs.length > 10_000) logs = logs.slice(-10_000);
    fs.writeFileSync(filePath, JSON.stringify(logs, null, 2), 'utf8');
  } catch {
    // Failed to write offline log — silently ignore
  }
}

let _flushing = false;

export async function flushOfflineLogs(): Promise<number> {
  // Prevent concurrent flushes (could cause duplicates)
  if (_flushing) return 0;
  _flushing = true;

  const filePath = getOfflineLogPath();
  let logs: Record<string, unknown>[] = [];

  try {
    if (!fs.existsSync(filePath)) return 0;

    try {
      logs = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return 0;
    }
    if (!Array.isArray(logs) || logs.length === 0) return 0;

    // Step 1: Immediately clear the file BEFORE uploading.
    // This prevents new logs appended during upload from being wiped out later,
    // and prevents re-uploading the same batch on next flush cycle.
    fs.writeFileSync(filePath, '[]', 'utf8');

    // Step 2: Upload the batch to Supabase
    const { status } = await supabaseRequest('POST', 'action_logs', logs, {
      'Prefer': 'return=minimal',
    });

    if (status >= 200 && status < 300) {
      console.log(`[Telemetry] Flushed ${logs.length} offline logs`);
      return logs.length;
    }

    // Step 3: Upload failed — put the logs back (prepend to any new logs added during upload)
    throw new Error(`HTTP ${status}`);
  } catch {
    // Restore failed batch: merge back with any new logs that were added during the upload attempt
    if (logs.length > 0) {
      try {
        let current: Record<string, unknown>[] = [];
        if (fs.existsSync(filePath)) {
          try { current = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { current = []; }
        }
        const merged = [...logs, ...current].slice(-10_000);
        fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), 'utf8');
      } catch { /* truly hopeless — silently drop */ }
    }
    return 0;
  } finally {
    _flushing = false;
  }
}

// ---------------------------------------------------------------------------
// Admin API — fetch stats from Supabase for dashboard
// ---------------------------------------------------------------------------

/** Fetch action logs with optional filters */
export async function fetchActionLogs(
  limit = 200,
  offset = 0,
  actionType?: string,
  dateFrom?: string,
  dateTo?: string,
): Promise<{ ok: boolean; data: unknown; count: number }> {
  try {
    let query = `action_logs?select=*,users_machine(os_username,os_platform,app_version)&order=created_at.desc&limit=${limit}&offset=${offset}`;
    if (actionType) query += `&action_type=eq.${actionType}`;
    if (dateFrom) query += `&created_at=gte.${dateFrom}`;
    if (dateTo) query += `&created_at=lte.${dateTo}`;

    const { status, data } = await supabaseRequest('GET', query, undefined, {
      'Prefer': 'count=exact',
    });
    if (status >= 200 && status < 300) {
      return { ok: true, data, count: Array.isArray(data) ? data.length : 0 };
    }
    return { ok: false, data: [], count: 0 };
  } catch (e) {
    return { ok: false, data: (e as Error).message, count: 0 };
  }
}

/** Fetch all registered machines/users */
export async function fetchUsers(): Promise<{ ok: boolean; data: unknown }> {
  try {
    const { status, data } = await supabaseRequest(
      'GET',
      'users_machine?select=*&order=last_seen_at.desc',
    );
    if (status >= 200 && status < 300) {
      return { ok: true, data };
    }
    return { ok: false, data: [] };
  } catch (e) {
    return { ok: false, data: (e as Error).message };
  }
}

/** Fetch aggregated stats for dashboard charts */
export async function fetchAdminStats(
  dateFrom?: string,
  dateTo?: string,
): Promise<{ ok: boolean; data: unknown }> {
  try {
    // Fetch all logs in date range (for client-side aggregation and recent table)
    let query = 'action_logs?select=*&order=created_at.desc&limit=5000';
    if (dateFrom) query += `&created_at=gte.${dateFrom}`;
    if (dateTo) query += `&created_at=lte.${dateTo}`;

    const [logsResult, usersResult] = await Promise.all([
      supabaseRequest('GET', query),
      supabaseRequest('GET', 'users_machine?select=machine_id,os_username,last_seen_at,app_version,created_at&order=last_seen_at.desc'),
    ]);

    return {
      ok: true,
      data: {
        logs: logsResult.status >= 200 && logsResult.status < 300 ? logsResult.data : [],
        users: usersResult.status >= 200 && usersResult.status < 300 ? usersResult.data : [],
      },
    };
  } catch (e) {
    return { ok: false, data: (e as Error).message };
  }
}

/** Verify admin password */
export function verifyAdminPassword(password: string): boolean {
  const hash = crypto.createHash('sha256').update(password).digest('hex');
  return hash === ADMIN_PASSWORD_HASH;
}

// ---------------------------------------------------------------------------
// Cleanup — stop flush timer
// ---------------------------------------------------------------------------
export function stopTelemetry(): void {
  if (_flushTimer) {
    clearInterval(_flushTimer);
    _flushTimer = null;
  }
}
