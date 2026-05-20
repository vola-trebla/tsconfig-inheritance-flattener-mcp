import { describe, it, expect } from 'vitest';
import path from 'path';
import { flattenTsConfig, resolveAlias, analyzeProjectReferences } from '../src/flattener.js';

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

  it('resolves @scope/preset extends from local node_modules', () => {
    const result = flattenTsConfig(fix('external-extends/tsconfig.json'));
    expect(result.inheritanceChain).toHaveLength(2);
    expect(result.compilerOptions.strict).toBe(true);
    expect(result.compilerOptions.target).toBe('ES2022');
    expect(result.compilerOptions.module).toBe('NodeNext');
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
