#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v4';
import {
  flattenTsConfig,
  resolveAlias,
  analyzeProjectReferences,
  explainEmissionStructure,
} from './flattener.js';

const server = new McpServer({
  name: 'tsconfig-inheritance-flattener-mcp',
  version: '0.1.0',
});

server.tool(
  'get_effective_compiler_options',
  'Resolve the full tsconfig.json inheritance chain and return the final merged compiler options that actually apply — including options inherited from extended base configs in node_modules or monorepo packages. Eliminates agent hallucinations about strict mode, moduleResolution, paths, and target.',
  {
    configPath: z
      .string()
      .describe('Absolute path to the tsconfig.json file to resolve, e.g. /project/tsconfig.json'),
    includeRaw: z
      .boolean()
      .optional()
      .describe('If true, also return the raw per-file options before merging. Default false.'),
  },
  async (args) => {
    const result = flattenTsConfig(args.configPath);
    const lines = [
      `Effective TypeScript Configuration`,
      `  Config:            ${result.configPath}`,
      `  Inheritance chain: ${result.inheritanceChain.join(' → ')}`,
      ``,
      `Compiler Options (merged):`,
      ...Object.entries(result.compilerOptions).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`),
      ``,
      `Include patterns: ${result.include.join(', ') || '(none)'}`,
      `Exclude patterns: ${result.exclude.join(', ') || '(none)'}`,
    ];
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

server.tool(
  'resolve_module_alias',
  'Map a TypeScript path alias (e.g. @/components/Button or @utils/format) to its physical file location on disk, using the paths and baseUrl from the resolved tsconfig. Useful when an agent needs to navigate to the actual file behind an import.',
  {
    alias: z.string().describe('The import alias to resolve, e.g. @/hooks/useAuth or ~lib/helpers'),
    configPath: z
      .string()
      .describe('Absolute path to the tsconfig.json whose paths config should be used'),
  },
  async (args) => {
    const result = resolveAlias(args.alias, args.configPath);
    const lines = [
      `Alias Resolution: ${result.alias}`,
      `  Config:   ${result.configPath}`,
      `  Base URL: ${result.baseUrl ?? '(not set)'}`,
      ``,
      `Resolved physical paths:`,
      ...result.physicalPaths.map((p) => `  ${p}`),
    ];
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

server.tool(
  'analyze_project_references',
  "Inspect a tsconfig.json's project references array and validate that each referenced package has composite:true enabled. Detects missing or broken cross-package references in TypeScript monorepos that would cause silent build failures.",
  {
    configPath: z
      .string()
      .describe('Absolute path to the tsconfig.json to analyze for project references'),
  },
  async (args) => {
    const result = analyzeProjectReferences(args.configPath);
    const lines = [
      `Project References Analysis`,
      `  Config: ${result.configPath}`,
      `  References found: ${result.references.length}`,
      ``,
    ];
    for (const ref of result.references) {
      const status = ref.exists ? '✓' : '✗ NOT FOUND';
      lines.push(`  [${status}] ${ref.path}`);
      lines.push(`    → ${ref.resolvedConfigPath}`);
    }
    if (result.violations.length > 0) {
      lines.push(``, `Violations:`);
      for (const v of result.violations) {
        lines.push(`  ✗ ${v.importingFile} → ${v.importedPath}`);
        lines.push(`    ${v.reason}`);
      }
    } else {
      lines.push(``, `No violations found.`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

server.tool(
  'explain_emission_structure',
  'Build a virtual tree of what TypeScript will emit for each source file — compiled JS, declaration (.d.ts), and source map paths — without running the compiler. Useful when an agent needs to predict where output files will land or debug rootDir/outDir misconfigurations.',
  {
    configPath: z
      .string()
      .describe('Absolute path to the tsconfig.json to analyze for emission structure'),
  },
  async (args) => {
    const result = explainEmissionStructure(args.configPath);
    const lines = [
      `Emission Structure`,
      `  Config:      ${result.configPath}`,
      `  rootDir:     ${result.rootDir}`,
      `  outDir:      ${result.outDir}`,
      `  declaration: ${result.declaration}`,
      `  sourceMap:   ${result.sourceMap}`,
      ``,
      `  Source → Output:`,
      `  ${'─'.repeat(53)}`,
    ];
    for (const entry of result.emissionTree) {
      lines.push(`  ${entry.source}`);
      lines.push(`    js:  ${entry.compiled_js}`);
      if (entry.declaration) lines.push(`    dts: ${entry.declaration}`);
      if (entry.source_map) lines.push(`    map: ${entry.source_map}`);
    }
    if (result.commonRootIssues.length > 0) {
      lines.push(``, `  ⚠ Files outside rootDir (will cause TS errors):`);
      for (const f of result.commonRootIssues) lines.push(`    ${f}`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
