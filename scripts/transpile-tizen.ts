/**
 * Open WebTV - TypeScript to Samsung Tizen 2.4+ ES5-Compatible JS Transpiler
 *
 * Strips strict TypeScript type annotations, cleans type-stripping whitespace artifacts,
 * downlevels ES2015–ES2020+ syntax (`const`/`let`, optional chaining `?.`, nullish
 * coalescing `??`, template literals, arrow functions, `Object.assign` polyfill), and
 * transforms ES module imports/exports into:
 * - Tizen-compatible UMD/IIFE browser scripts (`src/*.js`, `dev-server/public/*.js`)
 * - CommonJS background service modules (`src/service/*.js`)
 */

import fs from 'node:fs';
import module from 'node:module';

const OBJECT_ASSIGN_POLYFILL =
  "var __assign = Object.assign || function (t) { for (var s, i = 1, n = arguments.length; i < n; i++) { s = arguments[i]; for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p)) t[p] = s[p]; } return t; };\n";

interface ProtectedSegment {
  readonly placeholder: string;
  readonly raw: string;
  readonly isTemplate: boolean;
}

/**
 * Converts a template literal (`hello ${name}!`) into ES5 string concatenation.
 */
function convertTemplateLiteralToEs5(rawTemplate: string): string {
  const inner = rawTemplate.slice(1, -1);
  const parts: string[] = [];
  let cursor = 0;

  while (cursor < inner.length) {
    const exprStart = inner.indexOf('${', cursor);
    if (exprStart === -1) {
      const tail = inner.slice(cursor);
      if (tail.length > 0 || parts.length === 0) {
        parts.push(JSON.stringify(tail));
      }
      break;
    }

    if (exprStart > cursor && inner[exprStart - 1] === '\\') {
      cursor = exprStart + 2;
      continue;
    }

    const staticChunk = inner.slice(cursor, exprStart);
    if (staticChunk.length > 0) {
      parts.push(JSON.stringify(staticChunk));
    }

    let depth = 1;
    let i = exprStart + 2;
    while (i < inner.length && depth > 0) {
      const ch = inner[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }

    const exprBody = inner.slice(exprStart + 2, i - 1).trim();
    parts.push('(' + exprBody + ')');
    cursor = i;
  }

  return parts.length === 0 ? "''" : parts.join(' + ');
}

/**
 * Protects string literals, regex/comments, and converts template literals so syntax
 * downleveling only mutates executable code tokens.
 */
function downlevelEs6ToEs5(code: string): string {
  const segments: ProtectedSegment[] = [];
  let idx = 0;

  const tokenized = code.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g,
    (match) => {
      const isTemplate = match.startsWith('`');
      const placeholder = `__TIZEN_SEG_${idx++}__`;
      segments.push({ placeholder, raw: match, isTemplate });
      return placeholder;
    }
  );

  let transformed = tokenized
    // Optional chaining: a.b?.c -> (a.b == null ? void 0 : a.b.c)
    .replace(
      /([A-Za-z0-9_$]+(?:\.[A-Za-z0-9_$]+)*)\?\.\s*([A-Za-z0-9_$]+)/g,
      '($1 == null ? void 0 : $1.$2)'
    )
    // Nullish coalescing: a ?? b -> (a != null ? a : b)
    .replace(
      /(\([^()\n]+\)|[A-Za-z0-9_$]+(?:\.[A-Za-z0-9_$]+)*)\s*\?\?\s*([A-Za-z0-9_$'"([]+)/g,
      '($1 != null ? $1 : $2)'
    )
    // Block-scoped declarations -> ES5 var
    .replace(/\b(const|let)\b/g, 'var')
    // Parenthesized arrow functions with block body: (a, b) => { ... }
    .replace(/\(([^()]*)\)\s*=>\s*\{/g, 'function ($1) {')
    // Single-identifier arrow functions with block body: a => { ... }
    .replace(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*=>\s*\{/g, 'function ($1) {')
    // Parenthesized arrow functions with expression body: (a, b) => expr
    .replace(
      /\(([^()]*)\)\s*=>\s*([^;\n{}]+?)(?=[,);\n])/g,
      'function ($1) { return $2; }'
    )
    // Single-identifier arrow functions with expression body: a => expr
    .replace(
      /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*=>\s*([^;\n{}]+?)(?=[,);\n])/g,
      'function ($1) { return $2; }'
    );

  // Restore protected literals & comments (converting template literals to ES5 concatenation)
  for (const seg of segments) {
    const replacement = seg.isTemplate
      ? convertTemplateLiteralToEs5(seg.raw)
      : seg.raw;
    transformed = transformed.replace(seg.placeholder, () => replacement);
  }

  // Normalize excessive blank whitespace left by stripTypeScriptTypes
  transformed = transformed
    .replace(/[ \t]+(?=[,);{])/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n');

  if (/\bObject\.assign\b/.test(transformed)) {
    transformed =
      OBJECT_ASSIGN_POLYFILL + transformed.replace(/\bObject\.assign\b/g, '__assign');
  }

  return transformed;
}

export function transpileTsToTizenBrowserJs(tsCode: string): string {
  // Remove multi-line or single-line `export type { ... }` before stripping
  const preCleaned = tsCode.replace(/^\s*export\s+type\s+\{[\s\S]*?\};?\s*$/gm, '');
  const stripped = module.stripTypeScriptTypes(preCleaned, { mode: 'strip' });

  const withoutExports = stripped
    .replace(/^\s*export\s+\{[\s\S]*?\};?\s*$/gm, '')
    .replace(/^\s*export\s+default\s+.*$/gm, '')
    .replace(/^\s*export\s+(var|let|const|function)\b/gm, '$1');

  const es5Code = downlevelEs6ToEs5(withoutExports);
  return `(function () {\n'use strict';\n${es5Code.trim()}\n})();\n`;
}

export function transpileTsToTizenServiceJs(tsCode: string): string {
  let reqCounter = 0;

  // 1. Strip pure type-only imports/exports first (single or multi-line)
  const withoutTypeImports = tsCode
    .replace(/^\s*import\s+type\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^\s*export\s+type\s+\{[\s\S]*?\};?\s*$/gm, '');

  // 2. Transform value imports to CommonJS require()
  const withCommonJsImports = withoutTypeImports
    .replace(
      /^\s*import\s+\*\s+as\s+([A-Za-z0-9_$]+)\s+from\s+['"](\.\/[^'"]+?)(?:\.ts)?['"];?\s*$/gm,
      "var $1 = require('$2');"
    )
    .replace(
      /^\s*import\s+([A-Za-z0-9_$]+)\s+from\s+['"](\.\/[^'"]+?\.json)['"](?:\s+with\s+\{\s*type:\s*['"]json['"]\s*\})?;?\s*$/gm,
      "var $1 = require('$2');"
    )
    .replace(
      /^\s*import\s+([A-Za-z0-9_$]+)\s+from\s+['"](?:node:)?([a-z0-9_./-]+?)(?:\.ts)?['"];?\s*$/gm,
      "var $1 = require('$2');"
    )
    .replace(
      /^\s*import\s+\{([\s\S]*?)\}\s*from\s+['"](?:node:)?([^'"]+?)(?:\.ts)?['"];?\s*$/gm,
      (_match, rawSpecifiers: string, modPath: string) => {
        const specs = rawSpecifiers
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0 && !/^type\s+/.test(s));
        if (specs.length === 0) {
          return '';
        }
        const tmpVar = `__cjs_dep_${++reqCounter}`;
        const lines = [`var ${tmpVar} = require('${modPath}');`];
        for (const spec of specs) {
          const asMatch = spec.match(/^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/);
          if (asMatch?.[1] && asMatch[2]) {
            lines.push(`var ${asMatch[2]} = ${tmpVar}.${asMatch[1]};`);
          } else {
            lines.push(`var ${spec} = ${tmpVar}.${spec};`);
          }
        }
        return lines.join('\n');
      }
    );

  // 3. Strip inline `type X` inside `export { a, type B }` before stripTypeScriptTypes
  const preCleanedExports = withCommonJsImports.replace(
    /^\s*export\s+\{([\s\S]*?)\};?\s*$/gm,
    (_m, inner: string) => {
      const valueSpecs = inner
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !/^type\s+/.test(s));
      return valueSpecs.length > 0 ? `export { ${valueSpecs.join(', ')} };` : '';
    }
  );

  const stripped = module.stripTypeScriptTypes(preCleanedExports, { mode: 'strip' });
  const exportedNames = new Set<string>();

  const withoutInlineExport = stripped
    .replace(
      /^\s*export\s+function\s+([A-Za-z0-9_$]+)\b/gm,
      (_match, fnName: string) => {
        exportedNames.add(fnName);
        return `function ${fnName}`;
      }
    )
    .replace(
      /^\s*export\s+(var|let|const)\s+([A-Za-z0-9_$]+)\b/gm,
      (_match, declKind: string, varName: string) => {
        exportedNames.add(varName);
        return `${declKind} ${varName}`;
      }
    )
    .replace(/^\s*export\s+\{([\s\S]*?)\};?\s*$/gm, (_match, rawList: string) => {
      const names = rawList
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
      for (const n of names) {
        exportedNames.add(n);
      }
      return '';
    });

  const es5Body = downlevelEs6ToEs5(withoutInlineExport).trim();
  const exportPairs = Array.from(exportedNames).map((name) => `${name}: ${name}`);
  const footer =
    exportPairs.length > 0
      ? `\n\nmodule.exports = {\n  ${exportPairs.join(',\n  ')}\n};\n`
      : '\n';

  return `'use strict';\n${es5Body}${footer}`;
}

export function transpileFileForTizenBrowser(tsFilePath: string): string {
  const source = fs.readFileSync(tsFilePath, 'utf8');
  return transpileTsToTizenBrowserJs(source);
}

export function transpileFileForTizenService(tsFilePath: string): string {
  const source = fs.readFileSync(tsFilePath, 'utf8');
  return transpileTsToTizenServiceJs(source);
}
