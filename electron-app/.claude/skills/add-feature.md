# Skill: Add Feature to Odoo Installer

Use this skill when adding a new feature to the Electron Odoo Installer app.

## Checklist

### 1. Backend (if needed)

- [ ] Add service function in `src/main/services/` (e.g. `projects.ts`, `installer.ts`)
- [ ] Return error CODES, not messages (add to `_backendMsgMap` later)
- [ ] Add IPC handler in `src/main/ipc-handlers.ts`
- [ ] Add channel to whitelist in `src/preload/index.ts`
- [ ] For long operations: add progress callback + push events

### 2. Frontend

- [ ] Add UI elements in `src/renderer/index.html`
- [ ] All visible text uses `data-i18n` attributes
- [ ] Add logic in `src/renderer/scripts/app.js`
- [ ] Dynamic text uses `t('key')` function
- [ ] Backend errors displayed via `tMsg(res.msg)`

### 3. Translations (ALL THREE required)

- [ ] `src/renderer/locales/en.json` — English
- [ ] `src/renderer/locales/vi.json` — Vietnamese
- [ ] `src/renderer/locales/ko.json` — Korean

### 4. Theme

- [ ] All colors use CSS variables (`var(--accent)`, etc.)
- [ ] Tested with dark mode (default)

### 5. Verify

- [ ] `npm run build` passes
- [ ] New IPC channels in preload whitelist
- [ ] Error codes mapped in `_backendMsgMap`

## Common Patterns

### Add a new modal
```html
<!-- index.html -->
<div class="modal-overlay" id="modalMyFeature">
  <div class="modal">
    <div class="modal-header">
      <h3 data-i18n="modal.myFeatureTitle">Title</h3>
      <button class="btn-close-modal" onclick="hideModal('modalMyFeature')">&#10005;</button>
    </div>
    <div class="modal-body">...</div>
  </div>
</div>
```

### Add a new IPC channel
```typescript
// 1. ipc-handlers.ts
ipcMain.handle('my_channel', async (_event, data) => { ... });

// 2. preload/index.ts — add to validChannels array
'my_channel',

// 3. app.js
const res = await api('my_channel', { ... });
```

### Add a new backend error
```typescript
// 1. Service returns code
return { ok: false, msg: 'MY_ERROR' };

// 2. app.js — add to _backendMsgMap
'MY_ERROR': 'toast.myError',

// 3. All 3 locale files
"myError": "Human readable message"
```
