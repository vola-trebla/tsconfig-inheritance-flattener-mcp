# ROADMAP — tsconfig-inheritance-flattener-mcp

## The core problem

Agent reads `tsconfig.json` and sees:

```json
{ "extends": "@tsconfig/strictest", "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }
```

It hallucinates the rest. It doesn't know that `@tsconfig/strictest` sets `strict: true`,
`noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`. It doesn't know
that `baseUrl` is set two levels up in a monorepo base config. It gives wrong answers.

TypeScript compiler API already resolves this — we just need to expose it via MCP.

---

## Tool 1: `get_effective_compiler_options`

### What it returns

```
Effective TypeScript Configuration
  Config:            /project/apps/web/tsconfig.json
  Inheritance chain: /project/apps/web/tsconfig.json
                     → /project/tsconfig.base.json
                     → node_modules/@tsconfig/strictest/tsconfig.json

Compiler Options (merged):
  target: "ES2022"
  module: "NodeNext"
  moduleResolution: "NodeNext"
  strict: true
  noUncheckedIndexedAccess: true
  exactOptionalPropertyTypes: true
  baseUrl: "/project"
  paths: { "@/*": ["apps/web/src/*"], "@shared/*": ["packages/shared/src/*"] }
  outDir: "dist"
  rootDir: "src"

Include patterns: src/**/*
Exclude patterns: node_modules, dist
```

### Implementation

```typescript
import ts from 'typescript';
import path from 'path';

function flattenTsConfig(configPath: string): FlattenedConfig {
  // Step 1: collect inheritance chain by following `extends` manually
  const chain: string[] = [];
  let current = configPath;
  while (current) {
    chain.push(current);
    const raw = ts.readConfigFile(current, ts.sys.readFile);
    // raw.config.extends is a string (relative path or package name)
    const ext = raw.config?.extends;
    if (!ext) break;
    current = resolveExtends(ext, path.dirname(current));
  }

  // Step 2: let TypeScript do the actual merge
  const raw = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(
    raw.config,
    ts.sys,
    path.dirname(configPath),
    {},
    configPath,
  );

  // parsed.options = fully merged CompilerOptions
  // Convert ts.CompilerOptions (enum numbers) → human-readable strings
  // e.g. ModuleKind.NodeNext = 199 → "NodeNext"
  // Use ts.ModuleKind[parsed.options.module!] to reverse the enum

  return {
    configPath,
    inheritanceChain: chain,
    compilerOptions: serializeCompilerOptions(parsed.options),
    include: parsed.raw?.include ?? [],
    exclude: parsed.raw?.exclude ?? [],
    files: parsed.raw?.files,
  };
}
```

### Enum serialization — the tricky part

`ts.CompilerOptions` stores enum values as numbers. Must reverse-map them:

```typescript
function serializeCompilerOptions(opts: ts.CompilerOptions): Record<string, unknown> {
  return {
    ...opts,
    target: opts.target !== undefined ? ts.ScriptTarget[opts.target] : undefined,
    module: opts.module !== undefined ? ts.ModuleKind[opts.module] : undefined,
    moduleResolution:
      opts.moduleResolution !== undefined
        ? ts.ModuleResolutionKind[opts.moduleResolution]
        : undefined,
    jsx: opts.jsx !== undefined ? ts.JsxEmit[opts.jsx] : undefined,
    // lib is string[] already
    // paths is Record<string, string[]> already
  };
}
```

### Edge cases

- `extends` can be a **package name** (`@tsconfig/strictest`) → resolve via Node module resolution
  from `node_modules/@tsconfig/strictest/tsconfig.json`
- `extends` can be an **array** (TypeScript 5.0+): `"extends": ["./base.json", "@tsconfig/node20"]`
  → iterate array, merge left-to-right
- Circular `extends` → detect with visited Set, throw with clear message
- `configPath` doesn't exist → throw "Config file not found: ..."
- `paths` without `baseUrl` in TS < 5.0 → warn, still return paths

---

## Tool 2: `resolve_module_alias`

### What it returns

```
Alias Resolution: @/hooks/useAuth
  Config:   /project/apps/web/tsconfig.json
  Base URL: /project

Resolved physical paths:
  /project/apps/web/src/hooks/useAuth.ts      ✓ exists
  /project/apps/web/src/hooks/useAuth/index.ts ✓ exists
```

### Implementation

```typescript
function resolveAlias(alias: string, configPath: string): ResolvedAlias {
  const { compilerOptions } = flattenTsConfig(configPath);
  const paths = compilerOptions.paths as Record<string, string[]> | undefined;
  const baseUrl = compilerOptions.baseUrl as string | undefined;

  if (!paths) throw new Error('No paths configured in tsconfig');

  // Match alias against patterns (support wildcards)
  // Pattern: "@/*" matches "@/hooks/useAuth" → capture = "hooks/useAuth"
  for (const [pattern, targets] of Object.entries(paths)) {
    const capture = matchPattern(pattern, alias);
    if (capture === null) continue;

    const physicalPaths: string[] = [];
    for (const target of targets) {
      // Replace "*" with captured segment
      const resolved = target.replace('*', capture);
      const base = baseUrl ?? path.dirname(configPath);
      const abs = path.resolve(base, resolved);

      // Try: exact path, .ts, .tsx, /index.ts, /index.tsx
      for (const suffix of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
        const candidate = abs + suffix;
        if (fs.existsSync(candidate)) physicalPaths.push(candidate);
      }
    }

    return { alias, physicalPaths, baseUrl: baseUrl ?? null, configPath };
  }

  throw new Error(`No path pattern in tsconfig matches alias: ${alias}`);
}

function matchPattern(pattern: string, alias: string): string | null {
  if (!pattern.includes('*')) {
    return pattern === alias ? '' : null;
  }
  const [prefix, suffix] = pattern.split('*');
  if (alias.startsWith(prefix) && alias.endsWith(suffix)) {
    return alias.slice(prefix.length, alias.length - suffix.length);
  }
  return null;
}
```

### Edge cases

- Multiple matching patterns → return first match (TypeScript behavior)
- No `*` in pattern (exact match like `"@app": ["./src/app.ts"]`)
- `baseUrl` not set → use `path.dirname(configPath)` as base
- Alias resolves to 0 physical files → return empty array with warning, don't throw

---

## Tool 3: `analyze_project_references`

### What it returns

```
Project References Analysis
  Config: /project/tsconfig.json
  References found: 3

  [✓] packages/shared
    → /project/packages/shared/tsconfig.json
  [✓] packages/ui
    → /project/packages/ui/tsconfig.json
  [✗ NOT FOUND] packages/deprecated
    → /project/packages/deprecated/tsconfig.json

Violations:
  ✗ packages/shared is referenced but does not have composite: true
    Fix: add "composite": true to packages/shared/tsconfig.json
```

### Implementation

```typescript
function analyzeProjectReferences(configPath: string): ProjectReferencesResult {
  const raw = ts.readConfigFile(configPath, ts.sys.readFile);
  const refs: ts.ProjectReference[] = raw.config?.references ?? [];

  const references: ProjectReference[] = refs.map((ref) => {
    const resolved = path.resolve(path.dirname(configPath), ref.path, 'tsconfig.json');
    return {
      path: ref.path,
      prepend: ref.prepend,
      resolvedConfigPath: resolved,
      exists: fs.existsSync(resolved),
    };
  });

  const violations: ReferenceViolation[] = [];
  for (const ref of references) {
    if (!ref.exists) continue;
    const refRaw = ts.readConfigFile(ref.resolvedConfigPath, ts.sys.readFile);
    const refParsed = ts.parseJsonConfigFileContent(
      refRaw.config,
      ts.sys,
      path.dirname(ref.resolvedConfigPath),
    );
    if (!refParsed.options.composite) {
      violations.push({
        importingFile: configPath,
        importedPath: ref.resolvedConfigPath,
        reason: `Referenced package must have composite: true. Add it to ${ref.resolvedConfigPath}`,
      });
    }
  }

  return { configPath, references, violations };
}
```

### Edge cases

- Reference points to a directory without `tsconfig.json` → mark as NOT FOUND
- Reference path is absolute → handle both relative and absolute
- Self-reference (project references itself) → flag as violation

---

## Tests to write

### `test/flattener.test.ts`

Use real fixture tsconfigs in `test/fixtures/`:

```
test/fixtures/
  simple/
    tsconfig.json          { "compilerOptions": { "strict": true, "target": "ES2022" } }

  extended/
    tsconfig.base.json     { "compilerOptions": { "strict": true, "noImplicitAny": true } }
    tsconfig.json          { "extends": "./tsconfig.base.json", "compilerOptions": { "target": "ES2022" } }

  with-paths/
    tsconfig.json          { "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }
    src/
      hooks/
        useAuth.ts         (empty file, just needs to exist)

  monorepo/
    tsconfig.json          { "references": [{ "path": "packages/shared" }] }
    packages/
      shared/
        tsconfig.json      { "compilerOptions": { "composite": true } }

  chain-of-3/
    base.json              { "compilerOptions": { "strict": true } }
    middle.json            { "extends": "./base.json", "compilerOptions": { "target": "ES2020" } }
    tsconfig.json          { "extends": "./middle.json", "compilerOptions": { "module": "NodeNext" } }
```

**Test cases:**

- `flattenTsConfig` on `simple/` → correct options, chain length 1
- `flattenTsConfig` on `extended/` → merged options, chain length 2 (child overrides base)
- `flattenTsConfig` on `chain-of-3/` → chain length 3, all options merged correctly
- `resolveAlias` on `with-paths/` with `@/hooks/useAuth` → finds `src/hooks/useAuth.ts`
- `resolveAlias` with non-matching alias → throws
- `analyzeProjectReferences` on `monorepo/` → 1 reference, 0 violations
- `analyzeProjectReferences` on monorepo without `composite: true` → 1 violation

---

## Notes on TypeScript compiler API

- `typescript` is already a devDependency. For runtime use, add it to `dependencies`.
- Import as: `import ts from "typescript"` (default export in CJS mode, needs `esModuleInterop`)
- For ESM with NodeNext: `import ts from "typescript"` works because typescript ships CJS with a default export
- `ts.sys` provides the filesystem abstraction (uses real `fs` under the hood)
- `ts.parseJsonConfigFileContent` handles `extends`, `include`/`exclude` expansion, path normalization — let it do the work, don't reimplement

## What to add to dependencies

```bash
npm install typescript  # move from devDep to dep — needed at runtime
```
