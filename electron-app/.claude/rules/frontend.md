# Frontend Rules

## No UI Frameworks

Renderer uses vanilla HTML/CSS/JS. Do NOT introduce React, Vue, or any framework.

## i18n Required for All User-Facing Text

Every visible string must be translatable:

- **Static HTML**: Use `data-i18n="key"` (text), `data-i18n-html="key"` (HTML), `data-i18n-placeholder="key"`
- **Dynamic JS**: Use `t('key')` or `t('key', { param: value })`
- **Backend errors**: Return error codes (e.g. `INVALID_NAME`), map in `_backendMsgMap`, display via `tMsg()`

When adding new text:
1. Add English key to `locales/en.json`
2. Add Vietnamese translation to `locales/vi.json`
3. Add Korean translation to `locales/ko.json`

## Theme Compatibility

All colors must use CSS custom properties (e.g. `var(--accent)`, `var(--bg-surface)`).
NEVER hardcode colors except in theme preset definitions in `main.css`.

## Modal Pattern

All modals follow this structure:
```html
<div class="modal-overlay" id="modalName">
  <div class="modal">
    <div class="modal-header">...</div>
    <div class="modal-body">...</div>
  </div>
</div>
```

Show/hide via `showModal('modalName')` / `hideModal('modalName')`.

## Project Name Validation

Regex: `^[a-z_][a-z0-9_\-]*$`
- Validate on both frontend (`isValidProjectName()`) and backend (`isValidName()`)
- Show realtime hint via `validateProjectNameInput(input)` with `.input-hint` span
- Port uniqueness: check against `_status.projects` for `http_port` and `longpolling_port`

## Button Pending State

Start/Stop buttons use `renderActionBtn(project, size, extraOnclick)`:
- Shows spinner + translated "Starting..."/"Stopping..." when pending
- Pending state persists through `refreshStatus()` re-renders
- Uses `_pendingProjects` Map (name → 'starting' | 'stopping')
