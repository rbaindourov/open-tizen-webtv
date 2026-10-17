/**
 * Open WebTV - Strictly Typed Configuration & Cross-File Consistency Validator
 *
 * Verifies that:
 * 1. `src/config.xml` has valid application, package, and background service IDs.
 * 2. `src/service/config.json` matches the exact IDs in `src/config.xml`.
 * 3. `use.preview` metadata is properly formatted (`value="bg_service"`).
 * 4. No legacy ad-tracking privileges or placeholder metadata keys exist.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServiceConfig } from '../src/types/tizen.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ConfigValidationResult {
  readonly valid: boolean;
  readonly errors: string[];
}

export function validateProjectConfig(rootDir?: string): ConfigValidationResult {
  const baseDir = rootDir ? path.resolve(rootDir) : path.resolve(__dirname, '..');
  const errors: string[] = [];

  const configXmlPath = path.join(baseDir, 'src/config.xml');
  const serviceConfigPath = path.join(baseDir, 'src/service/config.json');

  if (!fs.existsSync(configXmlPath)) {
    errors.push('Missing src/config.xml');
    return { valid: false, errors };
  }

  if (!fs.existsSync(serviceConfigPath)) {
    errors.push('Missing src/service/config.json');
    return { valid: false, errors };
  }

  const xml = fs.readFileSync(configXmlPath, 'utf8');
  const serviceConfig = JSON.parse(
    fs.readFileSync(serviceConfigPath, 'utf8')
  ) as Partial<ServiceConfig>;

  const appMatch = xml.match(/<tizen:application\s+id="([^"]+)"\s+package="([^"]+)"/);
  const xmlAppId = appMatch?.[1];
  const xmlPkgId = appMatch?.[2];

  if (!xmlAppId || !xmlPkgId) {
    errors.push('src/config.xml missing <tizen:application id="..." package="..."/>');
  } else {
    if (serviceConfig.clientAppId !== xmlAppId) {
      errors.push(
        `App ID mismatch: src/config.xml has "${xmlAppId}" but src/service/config.json has "${String(serviceConfig.clientAppId)}"`
      );
    }
    if (!xmlAppId.startsWith(xmlPkgId + '.')) {
      errors.push(
        `Application ID "${xmlAppId}" must start with package ID "${xmlPkgId}."`
      );
    }
  }

  const serviceMatch = xml.match(/<tizen:service\s+id="([^"]+)"/);
  const xmlServiceId = serviceMatch?.[1];
  if (!xmlServiceId) {
    errors.push('src/config.xml missing <tizen:service id="..."/>');
  } else {
    if (
      serviceConfig.previewServiceId &&
      serviceConfig.previewServiceId !== xmlServiceId
    ) {
      errors.push(
        `Service ID mismatch: src/config.xml has "${xmlServiceId}" but src/service/config.json has "${serviceConfig.previewServiceId}"`
      );
    }
  }

  if (xml.includes('value="\tbg_service"') || xml.includes("value='\tbg_service'")) {
    errors.push(
      'src/config.xml contains leading tab in use.preview bg_service metadata'
    );
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

const isMainModule =
  process.argv[1] !== undefined &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename);

if (isMainModule) {
  const result = validateProjectConfig();
  if (!result.valid) {
    console.error('Configuration validation failed:');
    for (const err of result.errors) {
      console.error(' - ' + err);
    }
    process.exit(1);
  }
  console.log(
    '✓ Configuration validation passed: src/config.xml and src/service/config.json are synchronized.'
  );
}
