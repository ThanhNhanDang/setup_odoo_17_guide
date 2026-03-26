import * as fs from 'fs';
import * as path from 'path';
import { parseIni, stringifyIni, iniSet } from './ini-parser';
import { runCmd } from '../utils/shell';

// ---------------------------------------------------------------------------
// Project Management - CRUD operations
// Ports: read_project_config, save_project_config, delete_project,
//        duplicate_project
// ---------------------------------------------------------------------------

interface ProjectResult {
  readonly ok: boolean;
  readonly msg: string;
  readonly content?: string;
}

export function readProjectConfig(projectsDir: string, projectName: string): ProjectResult {
  const conf = path.join(projectsDir, projectName, 'odoo.conf');
  if (!fs.existsSync(conf)) {
    return { ok: false, msg: 'Config not found' };
  }
  const content = fs.readFileSync(conf, 'utf8');
  return { ok: true, msg: 'OK', content };
}

export function saveProjectConfig(projectsDir: string, projectName: string, content: string): ProjectResult {
  const conf = path.join(projectsDir, projectName, 'odoo.conf');
  if (!fs.existsSync(conf)) {
    return { ok: false, msg: 'Config not found' };
  }
  // Validate INI format
  try {
    parseIni(content);
  } catch (e) {
    return { ok: false, msg: `Invalid config: ${e}` };
  }
  fs.writeFileSync(conf, content, 'utf8');
  return { ok: true, msg: 'Saved' };
}

export function deleteProject(projectsDir: string, projectName: string): ProjectResult {
  const proj = path.join(projectsDir, projectName);
  const conf = path.join(proj, 'odoo.conf');
  if (!fs.existsSync(proj) || !fs.statSync(proj).isDirectory() || !fs.existsSync(conf)) {
    return { ok: false, msg: 'Project not found' };
  }
  try {
    fs.rmSync(proj, { recursive: true, force: true });
    return { ok: true, msg: 'Deleted' };
  } catch (e) {
    return { ok: false, msg: String(e) };
  }
}

export async function duplicateProject(
  baseDir: string,
  projectsDir: string,
  projectName: string,
  newName: string,
  newHttpPort: string,
): Promise<ProjectResult> {
  const src = path.join(projectsDir, projectName);
  const dst = path.join(projectsDir, newName);

  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
    return { ok: false, msg: 'Source project not found' };
  }
  if (fs.existsSync(dst)) {
    return { ok: false, msg: `Project '${newName}' already exists` };
  }

  try {
    fs.mkdirSync(dst, { recursive: true });

    // Copy all files except the junction link
    for (const item of fs.readdirSync(src)) {
      const srcItem = path.join(src, item);
      const dstItem = path.join(dst, item);
      const stat = fs.lstatSync(srcItem);

      if (item === 'odoo' && stat.isDirectory()) {
        // Recreate junction link
        await runCmd(`cmd /c mklink /J "${dstItem}" "${path.join(baseDir, 'odoo')}"`);
      } else if (stat.isDirectory()) {
        fs.cpSync(srcItem, dstItem, { recursive: true });
      } else {
        fs.copyFileSync(srcItem, dstItem);
      }
    }

    // Update ports in config
    const conf = path.join(dst, 'odoo.conf');
    if (fs.existsSync(conf)) {
      const content = fs.readFileSync(conf, 'utf8');
      let ini = parseIni(content);
      if (ini.options) {
        ini = iniSet(ini, 'options', 'http_port', newHttpPort);
        const lpPort = parseInt(newHttpPort, 10);
        if (!isNaN(lpPort)) {
          ini = iniSet(ini, 'options', 'longpolling_port', String(lpPort + 3));
        }
        fs.writeFileSync(conf, stringifyIni(ini), 'utf8');
      }
    }

    return { ok: true, msg: dst };
  } catch (e) {
    return { ok: false, msg: String(e) };
  }
}
