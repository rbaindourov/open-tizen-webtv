/**
 * Open WebTV - TypeScript to Samsung Tizen 2.4+ ES5-Compatible JS Transpiler
 *
 * Strips strict TypeScript type annotations and transforms ES module imports/exports
 * into Tizen-compatible UMD/IIFE browser scripts (`src/*.js`, `dev-server/public/*.js`)
 * or CommonJS service modules (`src/service/*.js`) for `.wgt` packaging and HTTP serving.
 */

import fs from 'node:fs';
import module from 'node:module';

export function transpileTsToTizenBrowserJs(tsCode: string): string {
  const stripped = module.stripTypeScriptTypes(tsCode, { mode: 'strip' });

  const withoutExports = stripped
    .replace(/^\s*export\s+\{[^}]*\};?\s*$/gm, '')
    .replace(/^\s*export\s+default\s+.*$/gm, '')
    .replace(/^\s*export\s+(var|let|const|function)\b/gm, '$1');

  return `(function () {\n'use strict';\n${withoutExports}\n})();\n`;
}

export function transpileTsToTizenServiceJs(tsCode: string): string {
  const withCommonJsImports = tsCode
    .replace(
      /^\s*import\s+\*\s+as\s+([A-Za-z0-9_$]+)\s+from\s+['"](\.\/[^'"]+?)(?:\.ts)?['"];?\s*$/gm,
      "var $1 = require('$2');"
    )
    .replace(
      /^\s*import\s+([A-Za-z0-9_$]+)\s+from\s+['"](\.\/[^'"]+?\.json)['"](?:\s+with\s+\{\s*type:\s*['"]json['"]\s*\})?;?\s*$/gm,
      "var $1 = require('$2');"
    )
    .replace(
      /^\s*import\s+([A-Za-z0-9_$]+)\s+from\s+['"]node:([a-z0-9_]+)['"];?\s*$/gm,
      "var $1 = require('$2');"
    );

  const stripped = module.stripTypeScriptTypes(withCommonJsImports, { mode: 'strip' });
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
    .replace(/^\s*export\s+\{([^}]*)\};?\s*$/gm, (_match, rawList: string) => {
      const names = rawList
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
      for (const n of names) {
        exportedNames.add(n);
      }
      return '';
    });

  const exportPairs = Array.from(exportedNames).map((name) => `${name}: ${name}`);
  const footer =
    exportPairs.length > 0
      ? `\nmodule.exports = {\n  ${exportPairs.join(',\n  ')}\n};\n`
      : '\n';

  return `'use strict';\n${withoutInlineExport}${footer}`;
}

export function transpileFileForTizenBrowser(tsFilePath: string): string {
  const source = fs.readFileSync(tsFilePath, 'utf8');
  return transpileTsToTizenBrowserJs(source);
}

export function transpileFileForTizenService(tsFilePath: string): string {
  const source = fs.readFileSync(tsFilePath, 'utf8');
  return transpileTsToTizenServiceJs(source);
}
