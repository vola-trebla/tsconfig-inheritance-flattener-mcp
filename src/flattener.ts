import ts from 'typescript';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import type {
  FlattenedConfig,
  ResolvedAlias,
  ProjectReferencesResult,
  ProjectReference,
  EmissionEntry,
  EmissionStructureResult,
  ModuleResolutionResult,
  OverlappingFile,
  ConfigOverlapResult,
} from './types.js';

const require = createRequire(import.meta.url);

function resolveExtendsPath(ext: string, fromDir: string): string {
  if (ext.startsWith('.')) {
    const resolved = path.resolve(fromDir, ext);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
    const withJson = resolved.endsWith('.json') ? resolved : resolved + '.json';
    return withJson;
  }
  // Package name — resolve via node_modules
  try {
    // Try <package>/tsconfig.json for scoped packages like @tsconfig/strictest
    const pkgMain = require.resolve(ext, { paths: [fromDir] });
    return pkgMain;
  } catch {
    // require.resolve may fail for .json; try manual node_modules lookup
    const candidate = path.resolve(fromDir, 'node_modules', ext);
    if (fs.existsSync(candidate + '.json')) return candidate + '.json';
    const withTsconfig = path.join(candidate, 'tsconfig.json');
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
    throw new Error(`Error parsing ${abs}: ${typeof msg === 'string' ? msg : msg.messageText}`);
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
  if (!pattern.includes('*')) {
    return pattern === alias ? '' : null;
  }
  const starIdx = pattern.indexOf('*');
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

  if (!paths) throw new Error('No paths configured in tsconfig');

  for (const [pattern, targets] of Object.entries(paths)) {
    const capture = matchPattern(pattern, alias);
    if (capture === null) continue;

    const physicalPaths: string[] = [];
    const base = baseUrl ?? path.dirname(path.resolve(configPath));

    for (const target of targets) {
      const resolved = target.includes('*') ? target.replace('*', capture) : target;
      const abs = path.resolve(base, resolved);

      for (const suffix of ['', '.ts', '.tsx', '.js', '/index.ts', '/index.tsx']) {
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
      resolvedConfigPath = path.join(refPath, 'tsconfig.json');
    } else if (!refPath.endsWith('.json')) {
      resolvedConfigPath = refPath + '/tsconfig.json';
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
        reason: 'Project references itself',
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

function computeCommonRootDir(fileNames: string[]): string {
  if (fileNames.length === 0) return path.sep;
  const dirs = fileNames.map((f) => path.dirname(f));
  let common = dirs[0].split(path.sep);
  for (const dir of dirs.slice(1)) {
    const parts = dir.split(path.sep);
    let i = 0;
    while (i < common.length && i < parts.length && common[i] === parts[i]) i++;
    common = common.slice(0, i);
  }
  return common.join(path.sep) || path.sep;
}

export function explainEmissionStructure(configPath: string): EmissionStructureResult {
  const abs = path.resolve(configPath);
  if (!fs.existsSync(abs)) throw new Error(`Config file not found: ${abs}`);

  const configDir = path.dirname(abs);
  const raw = ts.readConfigFile(abs, ts.sys.readFile);
  if (raw.error) throw new Error(`Error reading ${abs}: ${raw.error.messageText}`);

  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, configDir, {}, abs);

  const outDir = parsed.options.outDir ?? configDir;
  const rootDir = parsed.options.rootDir ?? computeCommonRootDir(parsed.fileNames);
  const declaration = parsed.options.declaration ?? false;
  const sourceMap = parsed.options.sourceMap ?? false;

  const emissionTree: EmissionEntry[] = [];
  const commonRootIssues: string[] = [];

  for (const sourceFile of parsed.fileNames) {
    const rel = path.relative(rootDir, sourceFile);
    if (rel.startsWith('..')) commonRootIssues.push(sourceFile);

    const outputFiles = ts.getOutputFileNames(
      parsed,
      sourceFile,
      !ts.sys.useCaseSensitiveFileNames,
    );

    let compiled_js = '';
    let declaration_file: string | null = null;
    let source_map: string | null = null;

    for (const f of outputFiles) {
      if (f.endsWith('.d.ts')) declaration_file = f;
      else if (f.endsWith('.js.map')) source_map = f;
      else if (f.endsWith('.js')) compiled_js = f;
    }

    emissionTree.push({
      source: sourceFile,
      compiled_js,
      declaration: declaration_file,
      source_map,
    });
  }

  return {
    configPath: abs,
    rootDir,
    outDir,
    declaration,
    sourceMap,
    emissionTree,
    commonRootIssues,
  };
}

export function simulateModuleResolution(params: {
  moduleName: string;
  containingFile: string;
  configPath: string;
}): ModuleResolutionResult {
  const abs = path.resolve(params.configPath);
  if (!fs.existsSync(abs)) throw new Error(`Config file not found: ${abs}`);

  const configDir = path.dirname(abs);
  const raw = ts.readConfigFile(abs, ts.sys.readFile);
  if (raw.error) throw new Error(`Error reading ${abs}: ${raw.error.messageText}`);

  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, configDir, {}, abs);
  const compilerOptions = parsed.options;

  const host = ts.createCompilerHost(compilerOptions);
  const result = ts.resolveModuleName(
    params.moduleName,
    params.containingFile,
    compilerOptions,
    host,
  );

  const resolutionKind = compilerOptions.moduleResolution ?? ts.ModuleResolutionKind.Node10;
  const resolutionMode =
    (ts.ModuleResolutionKind as Record<number, string>)[resolutionKind] ?? String(resolutionKind);

  return {
    moduleName: params.moduleName,
    containingFile: params.containingFile,
    configPath: abs,
    resolutionMode,
    resolvedFile: result.resolvedModule?.resolvedFileName ?? null,
    failedLookups:
      ((result as unknown as Record<string, unknown>).failedLookupLocations as
        | string[]
        | undefined) ?? [],
    isExternalLibraryImport: result.resolvedModule?.isExternalLibraryImport ?? false,
  };
}

const KEY_OPTIONS = [
  'strict',
  'target',
  'module',
  'moduleResolution',
  'jsx',
  'skipLibCheck',
  'noImplicitAny',
  'strictNullChecks',
] as const;

export function detectConfigOverlaps(params: { configPaths: string[] }): ConfigOverlapResult {
  const { configPaths } = params;
  const fileToConfigs = new Map<string, string[]>();

  for (const configPath of configPaths) {
    const abs = path.resolve(configPath);
    if (!fs.existsSync(abs)) throw new Error(`Config file not found: ${abs}`);

    const raw = ts.readConfigFile(abs, ts.sys.readFile);
    if (raw.error) throw new Error(`Error reading ${abs}: ${raw.error.messageText}`);

    const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, path.dirname(abs), {}, abs);

    for (const file of parsed.fileNames) {
      const existing = fileToConfigs.get(file);
      if (existing) {
        existing.push(abs);
      } else {
        fileToConfigs.set(file, [abs]);
      }
    }
  }

  const overlappingFiles: OverlappingFile[] = [];

  for (const [file, configs] of fileToConfigs) {
    if (configs.length < 2) continue;

    const configEntries = configs.map((configPath) => {
      const raw = ts.readConfigFile(configPath, ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(
        raw.config,
        ts.sys,
        path.dirname(configPath),
        {},
        configPath,
      );
      const opts = serializeCompilerOptions(parsed.options);
      const keyOptions: Record<string, unknown> = {};
      for (const key of KEY_OPTIONS) {
        if (opts[key] !== undefined) keyOptions[key] = opts[key];
      }
      return { configPath, keyOptions };
    });

    overlappingFiles.push({ file, configs: configEntries });
  }

  return {
    configsAnalyzed: configPaths.map((p) => path.resolve(p)),
    overlapCount: overlappingFiles.length,
    overlappingFiles,
  };
}
