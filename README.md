# 🔍 tsconfig-inheritance-flattener-mcp

[![npm](https://img.shields.io/npm/v/tsconfig-inheritance-flattener-mcp)](https://www.npmjs.com/package/tsconfig-inheritance-flattener-mcp)
[![CI](https://github.com/vola-trebla/tsconfig-inheritance-flattener-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/vola-trebla/tsconfig-inheritance-flattener-mcp/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Your AI agent reads `tsconfig.json`. It has no idea what it actually means.**

MCP server that resolves the full TypeScript config inheritance chain and returns the **effective compiler options** that actually apply — including everything inherited from extended base configs, monorepo packages, and `node_modules` presets.

---

## 🤔 The problem

Your agent reads `tsconfig.json` and sees:

```json
{ "extends": "@tsconfig/strictest", "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }
```

It has no idea that `@tsconfig/strictest` sets `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`. It doesn't know that `baseUrl` is defined two levels up in your monorepo base config. So it:

- Suggests code that would fail `noUncheckedIndexedAccess`
- Gets confused about what `@/` resolves to
- Doesn't know your `target` is `ES2022`, not `ES5`
- Gives wrong answers about module resolution

The TypeScript compiler API already resolves all of this. This MCP just exposes it.

---

## 🛠️ Tools

### `get_effective_compiler_options`

Resolves the full `extends` chain and returns the merged compiler options that actually apply to a given `tsconfig.json`. Shows the inheritance chain, all merged options (with enums as readable strings, not magic numbers), and include/exclude patterns.

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
  paths: { "@/*": ["apps/web/src/*"] }
```

### `resolve_module_alias`

Maps a TypeScript path alias (e.g. `@/hooks/useAuth`) to its physical file location on disk, using the resolved `paths` and `baseUrl` from the tsconfig. Returns all existing candidates with extension probing.

```
Alias Resolution: @/hooks/useAuth
  Config:   /project/apps/web/tsconfig.json
  Base URL: /project

Resolved physical paths:
  /project/apps/web/src/hooks/useAuth.ts      ✓ exists
```

### `analyze_project_references`

Inspects the `references` array in a root `tsconfig.json` and validates that each referenced package has `composite: true`. Catches broken cross-package dependencies in TypeScript monorepos before they cause silent build failures.

```
Project References Analysis
  Config: /project/tsconfig.json
  References found: 2

  [✓] packages/shared → /project/packages/shared/tsconfig.json
  [✗ NOT FOUND] packages/deprecated → /project/packages/deprecated/tsconfig.json

Violations:
  ✗ packages/shared is referenced but does not have composite: true
    Fix: add "composite": true to packages/shared/tsconfig.json
```

---

## 🧪 What it looks like in practice

Agent is helping debug a TypeScript error and asks:

> "What compiler options are actually active in this project?"

Without this MCP, the agent guesses based on what it sees in `tsconfig.json`. With it:

```
get_effective_compiler_options("/project/apps/web/tsconfig.json")
→ strict: true, noUncheckedIndexedAccess: true, target: "ES2022", module: "NodeNext"
```

Now the agent knows exactly why `arr[0]` has type `string | undefined` and not just `string`. No more wrong suggestions.

---

## ⚡ Setup

```json
{
  "mcpServers": {
    "tsconfig-flattener": {
      "command": "npx",
      "args": ["-y", "tsconfig-inheritance-flattener-mcp"]
    }
  }
}
```

---

## 🚀 Usage

> "What compiler options actually apply to `/project/apps/web/tsconfig.json`? It extends a monorepo base and @tsconfig/strictest."

> "Where does `@/components/Button` resolve to on disk?"

> "Are the project references in my root tsconfig valid? Do all referenced packages have composite: true?"

Works great alongside:

- [ast-impact-mapper-mcp](https://www.npmjs.com/package/ast-impact-mapper-mcp) — for code→test correlation
- [release-readiness-triage-mcp](https://www.npmjs.com/package/release-readiness-triage-mcp) — for CI triage

---

## 📦 Links

- **npm:** [npmjs.com/package/tsconfig-inheritance-flattener-mcp](https://www.npmjs.com/package/tsconfig-inheritance-flattener-mcp)
- **GitHub:** [github.com/vola-trebla/tsconfig-inheritance-flattener-mcp](https://github.com/vola-trebla/tsconfig-inheritance-flattener-mcp)

## License

MIT
