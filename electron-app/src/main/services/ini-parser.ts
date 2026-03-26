import * as fs from 'fs';

// ---------------------------------------------------------------------------
// INI Parser - replaces Python configparser.RawConfigParser
// Minimal implementation for odoo.conf [options] section
// ---------------------------------------------------------------------------

export interface IniData {
  readonly [section: string]: Readonly<Record<string, string>>;
}

/**
 * Parse an INI file content string.
 * Supports: [section] headers, key = value pairs, comments (# and ;).
 */
export function parseIni(content: string): IniData {
  const result: Record<string, Record<string, string>> = {};
  let currentSection = '';

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();

    // Skip empty lines and comments
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;

    // Section header
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      if (!result[currentSection]) {
        result[currentSection] = {};
      }
      continue;
    }

    // Key = value (only within a section)
    if (currentSection && line.includes('=')) {
      const eqIndex = line.indexOf('=');
      const key = line.substring(0, eqIndex).trim();
      const value = line.substring(eqIndex + 1).trim();
      result[currentSection][key] = value;
    }
  }

  return result;
}

/**
 * Parse an INI file from disk.
 */
export function parseIniFile(filePath: string): IniData {
  const content = fs.readFileSync(filePath, 'utf8');
  return parseIni(content);
}

/**
 * Stringify INI data back to file format.
 */
export function stringifyIni(data: IniData): string {
  const lines: string[] = [];
  for (const [section, pairs] of Object.entries(data)) {
    lines.push(`[${section}]`);
    for (const [key, value] of Object.entries(pairs)) {
      lines.push(`${key} = ${value}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Get a value from an INI data object.
 */
export function iniGet(data: IniData, section: string, key: string, defaultValue: string = ''): string {
  return data[section]?.[key] ?? defaultValue;
}

/**
 * Set a value in a mutable copy of INI data.
 * Returns a new IniData object (immutable pattern).
 */
export function iniSet(data: IniData, section: string, key: string, value: string): IniData {
  const sectionData = { ...(data[section] || {}), [key]: value };
  return { ...data, [section]: sectionData };
}
