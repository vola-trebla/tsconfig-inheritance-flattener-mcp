import ts from "typescript";
import path from "path";
import fs from "fs";
import { createRequire } from "module";
import type {
  FlattenedConfig,
  ResolvedAlias,
  ProjectReferencesResult,
  ProjectReference,
} from "./types.js";

const require = createRequire(import.meta.url);

function resolveExtendsPath(ext: string, fromDir: string): string {
  if (ext.startsWith(".")) {
    const resolved = path.resolve(fromDir, ext);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
    const withJson = resolved.endsWith(".json") ? resolved : resolved + ".json";
    return withJson;
  }
  // Package name — resolve via node_modules
  try {
    // Try <package>/tsconfig.json for scoped packages like @tsconfig/strictest
    const pkgMain = require.resolve(ext, { paths: [fromDir] });
    return pkgMain;
  } catch {
    // require.resolve may fail for .json; try manual node_modules lookup
    const candidate = path.resolve(fromDir, "node_modules", ext);
    if (fs.existsSync(candidate + ".json")) return candidate + ".json";
    const withTsconfig = path.join(candidate, "tsconfig.json");
    if (fs.existsSync(withTsconfig)) return withTsconfig;
    throw new Error(`Cannot resolve extends: "${ext}" from ${fromDir}`);
  }
}

function collectChain(configPath: string): string[] {
  const chain: string[] = [];
  const visited = new Set<string>();
  let current: string | undefined = configPath;

  while (current) {
    const abs = path.resolve(current);
    if (visited.has(abs)) throw new Error(`Circular extends detected: ${abs}`);
    visited.add(abs);
    chain.push(abs);

    if (!fs.existsSync(abs)) throw new Error(`Config file not found: ${abs}`);
    const raw = ts.readConfigFile(abs, ts.sys.readFile);
    if (raw.error) throw new Error(`Error reading ${abs}: ${raw.error.messageText}`);

    const ext = raw.config?.extends;
    if (!ext) break;

    const dir = path.dirname(abs);
    if (Array.isArray(ext)) {
      // TS 5.0+ array extends — collect all branches
      for (const e of ext) {
        const sub = resolveExtendsPath(e, dir);
        const subChain = collectChain(sub);
        // Add sub-chain entries not already in chain
        for (const s of subChain) {
          if (!visited.has(s)) {
            chain.push(s);
            visited.add(s);
          }
        }
      }
      break;
    } else {
      current = resolveExtendsPath(ext as string, dir);
    }
  }

  return chain;
}

function serializeCompilerOptions(opts: ts.CompilerOptions): Record<string, unknown> {
  const result: Record<string, unknown> = { ...opts };

  if (opts.target !== undefined) result.target = ts.ScriptTarget[opts.target];
  if (opts.module !== undefined) result.module = ts.ModuleKind[opts.module];
  if (opts.moduleResolution !== undefined)
    result.moduleResolution = ts.ModuleResolutionKind[opts.moduleResolution];
  if (opts.jsx !== undefined) result.jsx = ts.JsxEmit[opts.jsx];
  if (opts.moduleDetection !== undefined)
    result.moduleDetection = ts.ModuleDetectionKind[opts.moduleDetection];

  // Remove internal numeric fields that have been replaced with string versions
  // (TypeScript stores them as numbers under the same key, we already overrode above)

  // Remove undefined values
  for (const key of Object.keys(result)) {
    if (result[key] === undefined) delete result[key];
  }

  return result;
}

export function flattenTsConfig(configPath: string): FlattenedConfig {
  const abs = path.resolve(configPath);
  if (!fs.existsSync(abs)) throw new Error(`Config file not found: ${abs}`);

  const chain = collectChain(abs);

  const raw = ts.readConfigFile(abs, ts.sys.readFile);
  if (raw.error) throw new Error(`Error reading ${abs}: ${raw.error.messageText}`);

  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, path.dirname(abs), {}, abs);

  // TS18003 = "No inputs were found" — harmless when reading options only, not compiling
  const realErrors = parsed.errors.filter((e) => e.code !== 18003);
  if (realErrors.length > 0) {
    const msg = realErrors[0].messageText;
    throw new Error(`Error parsing ${abs}: ${typeof msg === "string" ? msg : msg.messageText}`);
  }

  return {
    configPath: abs,
    inheritanceChain: chain,
    compilerOptions: serializeCompilerOptions(parsed.options),
    include: (parsed.raw?.include as string[]) ?? [],
    exclude: (parsed.raw?.exclude as string[]) ?? [],
    files: parsed.raw?.files as string[] | undefined,
  };
}

function matchPattern(pattern: string, alias: string): string | null {
  if (!pattern.includes("*")) {
    return pattern === alias ? "" : null;
  }
  const starIdx = pattern.indexOf("*");
  const prefix = pattern.slice(0, starIdx);
  const suffix = pattern.slice(starIdx + 1);
  if (
    alias.startsWith(prefix) &&
    alias.endsWith(suffix) &&
    alias.length >= prefix.length + suffix.length
  ) {
    return alias.slice(prefix.length, suffix.length > 0 ? alias.length - suffix.length : undefined);
  }
  return null;
}

export function resolveAlias(alias: string, configPath: string): ResolvedAlias {
  const { compilerOptions } = flattenTsConfig(configPath);
  const paths = compilerOptions.paths as Record<string, string[]> | undefined;
  const baseUrl = compilerOptions.baseUrl as string | undefined;

  if (!paths) throw new Error("No paths configured in tsconfig");

  for (const [pattern, targets] of Object.entries(paths)) {
    const capture = matchPattern(pattern, alias);
    if (capture === null) continue;

    const physicalPaths: string[] = [];
    const base = baseUrl ?? path.dirname(path.resolve(configPath));

    for (const target of targets) {
      const resolved = target.includes("*") ? target.replace("*", capture) : target;
      const abs = path.resolve(base, resolved);

      for (const suffix of ["", ".ts", ".tsx", ".js", "/index.ts", "/index.tsx"]) {
        const candidate = abs + suffix;
        if (fs.existsSync(candidate)) physicalPaths.push(candidate);
      }
    }

    return {
      alias,
      physicalPaths,
      baseUrl: baseUrl ?? null,
      configPath: path.resolve(configPath),
    };
  }

  throw new Error(`No path pattern in tsconfig matches alias: ${alias}`);
}

export function analyzeProjectReferences(configPath: string): ProjectReferencesResult {
  const abs = path.resolve(configPath);
  if (!fs.existsSync(abs)) throw new Error(`Config file not found: ${abs}`);

  const raw = ts.readConfigFile(abs, ts.sys.readFile);
  if (raw.error) throw new Error(`Error reading ${abs}: ${raw.error.messageText}`);

  const refs: ts.ProjectReference[] = raw.config?.references ?? [];

  const references: ProjectReference[] = refs.map((ref) => {
    const refPath = path.resolve(path.dirname(abs), ref.path);
    // If path points to a directory, append tsconfig.json
    let resolvedConfigPath = refPath;
    if (fs.existsSync(refPath) && fs.statSync(refPath).isDirectory()) {
      resolvedConfigPath = path.join(refPath, "tsconfig.json");
    } else if (!refPath.endsWith(".json")) {
      resolvedConfigPath = refPath + "/tsconfig.json";
    }
    return {
      path: ref.path,
      prepend: ref.prepend,
      resolvedConfigPath,
      exists: fs.existsSync(resolvedConfigPath),
    };
  });

  const violations = [];
  for (const ref of references) {
    // Self-reference check
    if (ref.resolvedConfigPath === abs) {
      violations.push({
        importingFile: abs,
        importedPath: ref.resolvedConfigPath,
        reason: "Project references itself",
      });
      continue;
    }
    if (!ref.exists) continue;

    const refRaw = ts.readConfigFile(ref.resolvedConfigPath, ts.sys.readFile);
    const refParsed = ts.parseJsonConfigFileContent(
      refRaw.config,
      ts.sys,
      path.dirname(ref.resolvedConfigPath),
    );
    if (!refParsed.options.composite) {
      violations.push({
        importingFile: abs,
        importedPath: ref.resolvedConfigPath,
        reason: `Referenced package must have composite: true. Add it to ${ref.resolvedConfigPath}`,
      });
    }
  }

  return { configPath: abs, references, violations };
}
