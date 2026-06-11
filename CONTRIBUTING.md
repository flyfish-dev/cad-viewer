# Contributing

Thank you for improving Lightweight CAD Viewer.

## Local setup

```bash
npm install
npm run dev
npm run typecheck
```

## Pull request checklist

- Keep format-specific parsing inside `src/loaders/*`.
- Normalize all parser output to `CadDocument` and `CadEntity`.
- Add warnings for partial support instead of silently dropping unsupported content.
- Avoid adding framework dependencies to the core viewer.
- Do not commit `dist`, `dist-demo`, `node_modules` or temporary CAD samples.

## Adding a loader

1. Implement the `CadLoader` interface.
2. Add detection logic in `accepts()`.
3. Return a normalized `CadDocument`.
4. Register it through `createDefaultLoaderRegistry()` or `viewer.registerLoader()`.
