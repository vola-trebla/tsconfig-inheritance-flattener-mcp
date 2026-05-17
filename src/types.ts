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
