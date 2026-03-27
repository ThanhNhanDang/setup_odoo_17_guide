# Skill: Add/Update Translations

Use this skill when adding new translatable text or updating existing translations.

## Adding New Keys

### 1. Determine the namespace

| Namespace | Use for |
|-----------|---------|
| `nav.*` | Navigation tabs |
| `settings.*` | Settings modal labels |
| `dashboard.*` | Dashboard stats, filters |
| `install.*` | Install step names/descriptions |
| `project.*` | Project actions, tags |
| `modal.*` | Modal titles, form labels, notes |
| `toast.*` | Toast notifications, error messages |
| `update.*` | Auto-updater messages |
| `help.*` | Help panel |
| `tour.*` | Tour buttons |
| `status.*` | Status labels (OK, Missing) |
| `td.tour.*` | Tour step content |
| `td.doc.*` | Documentation content |
| `td.ts.*` | Troubleshooting content |

### 2. Add to ALL THREE locale files

```bash
# Files to edit:
src/renderer/locales/en.json   # English (required — fallback)
src/renderer/locales/vi.json   # Vietnamese
src/renderer/locales/ko.json   # Korean
```

### 3. Use in HTML (static text)

```html
<!-- Text content -->
<span data-i18n="namespace.key">English fallback</span>

<!-- HTML content (with tags) -->
<p data-i18n-html="namespace.key">Fallback with <strong>HTML</strong></p>

<!-- Placeholder -->
<input data-i18n-placeholder="namespace.key" placeholder="Fallback">

<!-- Title attribute -->
<button data-i18n-title="namespace.key" title="Fallback">...</button>
```

### 4. Use in JavaScript (dynamic text)

```javascript
// Simple
t('namespace.key')

// With parameters
t('toast.projectCreating', { name: 'my_project' })
// Locale: "Creating project \"{name}\"..."

// Backend error translation
tMsg(res.msg)  // Maps error codes via _backendMsgMap
```

### 5. Backend error codes

```javascript
// In app.js _backendMsgMap:
const _backendMsgMap = {
  'MY_ERROR_CODE': 'toast.myErrorKey',
  // ...
};
```

## Sync Check

After editing, verify all 3 files have the same keys:
- Compare key structure (not values) between en.json and vi.json/ko.json
- The `td.*` namespace is optional in en.json (docs are in English by default)
