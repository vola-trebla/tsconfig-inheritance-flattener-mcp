export interface FlattenedConfig {
  configPath: string;
  inheritanceChain: string[];
  compilerOptions: Record<string, unknown>;
  include: string[];
  exclude: string[];
  files?: string[];
}

export interface ResolvedAlias {
  alias: string;
  physicalPaths: string[];
  baseUrl: string | null;
  configPath: string;
}

export interface ProjectReference {
  path: string;
  prepend?: boolean;
  resolvedConfigPath: string;
  exists: boolean;
}

export interface ProjectReferencesResult {
  configPath: string;
  references: ProjectReference[];
  violations: ReferenceViolation[];
}

export interface ReferenceViolation {
  importingFile: string;
  importedPath: string;
  reason: string;
}

export interface OverlappingFile {
  file: string;
  configs: Array<{
    configPath: string;
    keyOptions: Record<string, unknown>;
  }>;
}

export interface ConfigOverlapResult {
  configsAnalyzed: string[];
  overlapCount: number;
  overlappingFiles: OverlappingFile[];
}

export interface ModuleResolutionResult {
  moduleName: string;
  containingFile: string;
  configPath: string;
  resolutionMode: string;
  resolvedFile: string | null;
  failedLookups: string[];
  isExternalLibraryImport: boolean;
}

export interface EmissionEntry {
  source: string;
  compiled_js: string;
  declaration: string | null;
  source_map: string | null;
}

export interface EmissionStructureResult {
  configPath: string;
  rootDir: string;
  outDir: string;
  declaration: boolean;
  sourceMap: boolean;
  emissionTree: EmissionEntry[];
  commonRootIssues: string[];
}
