# Architecture Rules

## Three-Process Boundary

Code changes must respect Electron's process isolation:

1. **Main process** (`src/main/`) — Node.js APIs, file system, shell commands, IPC handlers
2. **Preload** (`src/preload/`) — Context bridge only, minimal code
3. **Renderer** (`src/renderer/`) — DOM, vanilla JS, CSS. NO Node.js APIs.

## IPC-First Communication

- All renderer ↔ main communication goes through IPC channels
- New channels MUST be added to the whitelist in `src/preload/index.ts`
- Handler registration goes in `ipc-handlers.ts`, NOT in `index.ts`
- Business logic goes in `services/`, NOT in IPC handlers

## Service Layer Pattern

```
ipc-handlers.ts → services/*.ts → utils/*.ts
```

- IPC handlers: parse data, call service, return result
- Services: business logic, validation, orchestration
- Utils: pure helpers (shell, download, file ops)

## Version Registry

All Odoo version-specific config lives in `services/odoo-versions.ts`:
- Python/PostgreSQL versions and download URLs
- Git branches
- Docker images
- Base directory suffixes

NEVER hardcode version-specific values elsewhere. Use `getVersionConfig(version)`.

## INI Parser Immutability

`iniSet()` returns a NEW object. NEVER mutate the parsed INI directly:

```typescript
// CORRECT
ini = iniSet(ini, 'options', 'http_port', '8069');

// WRONG — mutation
ini.options.http_port = '8069';
```
