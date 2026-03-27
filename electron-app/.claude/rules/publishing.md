# Publishing & Versioning Rules

## Semantic Versioning

- `patch` (default): Bug fixes, translations, small UI tweaks
- `minor`: New features (e.g. new Odoo version support, new settings)
- `major`: Breaking changes requiring user action (e.g. config format change, data migration)

## Publish Flow

```cmd
publish.bat [patch|minor|major]
```

Steps (automated):
1. Bump version in `package.json`
2. Clean `release/` directory
3. TypeScript build (`tsc`)
4. `electron-builder --publish always` → uploads to GitHub Releases
5. `gh release edit` → publish draft release
6. Git commit + tag + push

## Pre-Publish Checklist

- [ ] `npm run build` passes (no TypeScript errors)
- [ ] All 3 locale files synced (en.json, vi.json, ko.json)
- [ ] New IPC channels added to preload whitelist
- [ ] Backend error codes mapped in `_backendMsgMap`
- [ ] No hardcoded secrets or paths
