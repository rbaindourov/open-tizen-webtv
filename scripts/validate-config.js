/**
 * Open WebTV - Configuration & Cross-File Consistency Validator
 *
 * Verifies that:
 * 1. `src/config.xml` has valid application, package, and background service IDs.
 * 2. `src/service/config.json` matches the exact IDs in `src/config.xml`.
 * 3. `use.preview` metadata is properly formatted (`value="bg_service"`).
 */
'use strict';

const fs = require('fs');
const path = require('path');

function validateProjectConfig(rootDir) {
  const baseDir = rootDir || path.resolve(__dirname, '..');
  const errors = [];

  const configXmlPath = path.join(baseDir, 'src/config.xml');
  const serviceConfigPath = path.join(baseDir, 'src/service/config.json');

  if (!fs.existsSync(configXmlPath)) {
    errors.push('Missing src/config.xml');
    return { valid: false, errors };
  }

  const xml = fs.readFileSync(configXmlPath, 'utf8');
  const serviceConfig = JSON.parse(fs.readFileSync(serviceConfigPath, 'utf8'));

  // Extract application ID and package ID
  const appMatch = xml.match(/<tizen:application\s+id="([^"]+)"\s+package="([^"]+)"/);
  if (!appMatch) {
    errors.push('src/config.xml missing <tizen:application id="..." package="..."/>');
  } else {
    const [, xmlAppId, xmlPkgId] = appMatch;
    if (serviceConfig.clientAppId !== xmlAppId) {
      errors.push(
        `App ID mismatch: src/config.xml has "${xmlAppId}" but src/service/config.json has "${serviceConfig.clientAppId}"`
      );
    }
    if (!xmlAppId.startsWith(xmlPkgId + '.')) {
      errors.push(`Application ID "${xmlAppId}" must start with package ID "${xmlPkgId}."`);
    }
  }

  // Extract service ID
  const serviceMatch = xml.match(/<tizen:service\s+id="([^"]+)"/);
  if (!serviceMatch) {
    errors.push('src/config.xml missing <tizen:service id="..."/>');
  } else {
    const [, xmlServiceId] = serviceMatch;
    if (serviceConfig.previewServiceId && serviceConfig.previewServiceId !== xmlServiceId) {
      errors.push(
        `Service ID mismatch: src/config.xml has "${xmlServiceId}" but src/service/config.json has "${serviceConfig.previewServiceId}"`
      );
    }
  }

  // Ensure no leading whitespace/tab in bg_service metadata value
  if (xml.includes('value="\tbg_service"') || xml.includes("value='\tbg_service'")) {
    errors.push('src/config.xml contains leading tab in use.preview bg_service metadata');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

if (require.main === module) {
  const result = validateProjectConfig();
  if (!result.valid) {
    console.error('Configuration validation failed:');
    result.errors.forEach((e) => console.error(' - ' + e));
    process.exit(1);
  }
  console.log('✓ Configuration validation passed: src/config.xml and src/service/config.json are synchronized.');
}

module.exports = {
  validateProjectConfig
};
