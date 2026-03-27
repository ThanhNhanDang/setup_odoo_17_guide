# Backend Rules

## Error Codes, Not Messages

Backend functions return error CODES, not human-readable messages:

```typescript
// CORRECT
return { ok: false, msg: 'INVALID_NAME' };
return { ok: false, msg: 'PROJECT_EXISTS' };

// WRONG
return { ok: false, msg: 'Invalid project name' };
return { ok: false, msg: `Project '${name}' already exists` };
```

Error codes are translated on the frontend via `_backendMsgMap` in `app.js`.

When adding a new error code:
1. Return the code from the service function
2. Add mapping in `app.js`: `_backendMsgMap`
3. Add `toast.yourKey` to all 3 locale files

## Path Safety

Always validate paths to prevent traversal:
- Use `isValidName()` for project names
- Check `path.resolve(target).startsWith(path.resolve(parent) + path.sep)`
- Never pass user input directly to shell commands without validation

## Shell Command Safety

Use parameterized commands. Quote all paths:
```typescript
// CORRECT
await runCmd(`cmd /c mklink /J "${dstPath}" "${srcPath}"`);

// WRONG — injection risk
await runCmd(`cmd /c mklink /J ${dstPath} ${srcPath}`);
```

## Progress Events

Long-running operations should emit progress events:

```typescript
// In service function
type ProgressFn = (step: string, done: boolean) => void;

export async function myOperation(onProgress?: ProgressFn) {
  const emit = (step: string, done: boolean) => { if (onProgress) onProgress(step, done); };
  emit('step_name', false);  // starting
  // ... do work ...
  emit('step_name', true);   // done
}

// In IPC handler
const onProgress = (step: string, done: boolean) => {
  mainWindow.webContents.send('my-progress', { step, done });
};
```

## Windows-Only Patterns

- Junction links: `cmd /c mklink /J "dest" "src"` (requires admin)
- Process spawning: Use `CREATE_NEW_CONSOLE` for Odoo processes
- PostgreSQL auth: Pass `PGPASSWORD` as env var to avoid interactive prompt
- Hosts file: `C:\Windows\System32\drivers\etc\hosts` (requires admin)
