# Skill: Add New Odoo Version Support

Use this skill when adding support for a new Odoo version (e.g. Odoo 21).

## Steps

### 1. Version Registry (`src/main/services/odoo-versions.ts`)

Add entry to `ODOO_VERSIONS`:

```typescript
'21': {
  key: '21',
  label: 'Odoo 21',
  branch: '21.0',            // or 'master' if branch not created yet
  pythonVersion: 'Python 3.13',
  pythonUrl: 'https://www.python.org/ftp/python/3.13.x/python-3.13.x-amd64.exe',
  pythonVersionPrefix: '3.13',
  pythonDirName: 'Python313',
  postgresVersion: '17',
  postgresUrl: 'https://get.enterprisedb.com/postgresql/postgresql-17.x-1-windows-x64.exe',
  postgresDockerImage: 'postgres:17',
  pgvector: true,            // if needed
  baseDirSuffix: 'odoo_21_base',
  defaultProjectsSubdir: 'odoo21',
  color: '#....',            // unique badge color
  extraPipPackages: [...COMMON_EXTRA_PACKAGES],
},
```

Update `OdooVersionKey` type and `ALL_VERSIONS` array.

### 2. Frontend — Install Version Selector

In `index.html`, add `<option>` to the install version select:
```html
<option value="21">Odoo 21</option>
```

### 3. Frontend — New Project Modal

The version selector in the new project modal is dynamically generated from the `odoo-versions` IPC channel — no change needed if using dynamic rendering.

### 4. Version Labels (`app.js`)

Update `VERSION_LABELS` object:
```javascript
'21': { python: 'Python 3.13', postgres: 'PostgreSQL 17', clone: 'Clone Odoo 21' },
```

### 5. Test

- [ ] Install page shows new version
- [ ] Correct Python/PG versions detected
- [ ] Clone uses correct branch
- [ ] Project creation works with new version
- [ ] Version badge color renders correctly
