import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import path from 'path';
import {
  flattenTsConfig,
  resolveAlias,
  analyzeProjectReferences,
  explainEmissionStructure,
  simulateModuleResolution,
} from '../src/flattener.js';

const fixtures = path.resolve(import.meta.dirname, 'fixtures');
const fix = (p: string) => path.join(fixtures, p);

describe('flattenTsConfig', () => {
  it('simple: returns correct options, chain length 1', () => {
    const result = flattenTsConfig(fix('simple/tsconfig.json'));
    expect(result.inheritanceChain).toHaveLength(1);
    expect(result.compilerOptions.strict).toBe(true);
    expect(result.compilerOptions.target).toBe('ES2022');
  });

  it('extended: merges options, chain length 2, child overrides base', () => {
    const result = flattenTsConfig(fix('extended/tsconfig.json'));
    expect(result.inheritanceChain).toHaveLength(2);
    expect(result.compilerOptions.strict).toBe(true);
    expect(result.compilerOptions.noImplicitAny).toBe(true);
    expect(result.compilerOptions.target).toBe('ES2022');
  });

  it('chain-of-3: chain length 3, all options merged correctly', () => {
    const result = flattenTsConfig(fix('chain-of-3/tsconfig.json'));
    expect(result.inheritanceChain).toHaveLength(3);
    expect(result.compilerOptions.strict).toBe(true);
    expect(result.compilerOptions.target).toBe('ES2020');
    expect(result.compilerOptions.module).toBe('NodeNext');
  });

  it('throws on missing config file', () => {
    expect(() => flattenTsConfig('/nonexistent/tsconfig.json')).toThrow('Config file not found');
  });

  it('returns configPath as absolute path', () => {
    const result = flattenTsConfig(fix('simple/tsconfig.json'));
    expect(path.isAbsolute(result.configPath)).toBe(true);
  });

  it('enum values are serialized as strings, not numbers', () => {
    const result = flattenTsConfig(fix('chain-of-3/tsconfig.json'));
    expect(typeof result.compilerOptions.target).toBe('string');
    expect(typeof result.compilerOptions.module).toBe('string');
  });
});

describe('external @scope/preset extends resolution', () => {
  let externalDir: string;

  beforeAll(() => {
    externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsconfig-ext-test-'));
    const presetDir = path.join(externalDir, 'node_modules', '@my-scope', 'strict-preset');
    fs.mkdirSync(presetDir, { recursive: true });
    fs.writeFileSync(
      path.join(presetDir, 'package.json'),
      JSON.stringify({ name: '@my-scope/strict-preset', version: '1.0.0', main: 'tsconfig.json' }),
    );
    fs.writeFileSync(
      path.join(presetDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
        },
      }),
    );
    fs.writeFileSync(
      path.join(externalDir, 'tsconfig.json'),
      JSON.stringify({ extends: '@my-scope/strict-preset', compilerOptions: { outDir: './dist' } }),
    );
  });

  afterAll(() => {
    fs.rmSync(externalDir, { recursive: true, force: true });
  });

  it('resolves @scope/preset extends from local node_modules', () => {
    const result = flattenTsConfig(path.join(externalDir, 'tsconfig.json'));
    expect(result.inheritanceChain).toHaveLength(2);
    expect(result.compilerOptions.strict).toBe(true);
    expect(result.compilerOptions.target).toBe('ES2022');
    expect(result.compilerOptions.module).toBe('NodeNext');
  });
});

describe('resolveAlias', () => {
  it('resolves @/* alias to physical file', () => {
    const result = resolveAlias('@/hooks/useAuth', fix('with-paths/tsconfig.json'));
    expect(result.physicalPaths).toHaveLength(1);
    expect(result.physicalPaths[0]).toContain('useAuth.ts');
  });

  it('throws for non-matching alias', () => {
    expect(() => resolveAlias('~nonexistent/foo', fix('with-paths/tsconfig.json'))).toThrow(
      'No path pattern in tsconfig matches alias',
    );
  });

  it('throws when no paths configured', () => {
    expect(() => resolveAlias('@/foo', fix('simple/tsconfig.json'))).toThrow(
      'No paths configured in tsconfig',
    );
  });

  it('returns baseUrl from tsconfig', () => {
    const result = resolveAlias('@/hooks/useAuth', fix('with-paths/tsconfig.json'));
    expect(result.baseUrl).toBeTruthy();
  });
});

describe('analyzeProjectReferences', () => {
  it('valid monorepo: 1 reference, 0 violations', () => {
    const result = analyzeProjectReferences(fix('monorepo/tsconfig.json'));
    expect(result.references).toHaveLength(1);
    expect(result.references[0].exists).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('missing composite: flags 1 violation', () => {
    const result = analyzeProjectReferences(fix('monorepo-no-composite/tsconfig.json'));
    expect(result.references).toHaveLength(1);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].reason).toContain('composite: true');
  });

  it('no references: returns empty arrays', () => {
    const result = analyzeProjectReferences(fix('simple/tsconfig.json'));
    expect(result.references).toHaveLength(0);
    expect(result.violations).toHaveLength(0);
  });

  it('throws on missing config file', () => {
    expect(() => analyzeProjectReferences('/nonexistent/tsconfig.json')).toThrow(
      'Config file not found',
    );
  });
});

describe('explainEmissionStructure', () => {
  it('returns emission tree with js and dts paths', () => {
    const result = explainEmissionStructure(fix('emit-structure/tsconfig.json'));
    expect(result.emissionTree.length).toBeGreaterThan(0);
    expect(result.emissionTree[0].compiled_js).toContain('dist/');
    expect(result.emissionTree[0].declaration).toContain('.d.ts');
  });

  it('emission tree covers both source files', () => {
    const result = explainEmissionStructure(fix('emit-structure/tsconfig.json'));
    expect(result.emissionTree).toHaveLength(2);
    const sources = result.emissionTree.map((e) => e.source);
    expect(sources.some((s) => s.endsWith('index.ts'))).toBe(true);
    expect(sources.some((s) => s.endsWith('helper.ts'))).toBe(true);
  });

  it('reports correct rootDir and outDir', () => {
    const result = explainEmissionStructure(fix('emit-structure/tsconfig.json'));
    expect(result.rootDir).toContain('src');
    expect(result.outDir).toContain('dist');
    expect(result.declaration).toBe(true);
    expect(result.sourceMap).toBe(false);
  });

  it('no commonRootIssues for well-structured config', () => {
    const result = explainEmissionStructure(fix('emit-structure/tsconfig.json'));
    expect(result.commonRootIssues).toHaveLength(0);
  });

  it('throws on missing config file', () => {
    expect(() => explainEmissionStructure('/nonexistent/tsconfig.json')).toThrow(
      'Config file not found',
    );
  });
});

describe('simulateModuleResolution', () => {
  const containingFile = fix('with-paths/src/index.ts');
  const configPath = fix('with-paths/tsconfig.json');

  it('resolves an existing relative module to its file', () => {
    const result = simulateModuleResolution({
      moduleName: './hooks/useAuth',
      containingFile,
      configPath,
    });
    expect(result.resolvedFile).not.toBeNull();
    expect(result.resolvedFile).toContain('useAuth.ts');
  });

  it('returns null for an unresolvable module', () => {
    const result = simulateModuleResolution({
      moduleName: './nonexistent-module',
      containingFile,
      configPath,
    });
    expect(result.resolvedFile).toBeNull();
    expect(result.failedLookups.length).toBeGreaterThan(0);
  });

  it('reports resolutionMode as a string', () => {
    const result = simulateModuleResolution({
      moduleName: './hooks/useAuth',
      containingFile,
      configPath,
    });
    expect(typeof result.resolutionMode).toBe('string');
    expect(result.resolutionMode.length).toBeGreaterThan(0);
  });

  it('throws on missing config file', () => {
    expect(() =>
      simulateModuleResolution({
        moduleName: './foo',
        containingFile,
        configPath: '/nonexistent/tsconfig.json',
      }),
    ).toThrow('Config file not found');
  });
});
