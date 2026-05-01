#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createZipArchive } = require('../utils.js');

const projectRoot = path.resolve(__dirname, '..');
const distDir = path.join(projectRoot, 'dist');

const runtimeFiles = [
  'manifest.json',
  'utils.js',
  'background.js',
  'content.js',
  'content.css',
  'popup.html',
  'popup.js',
  'popup.css',
  'offscreen.html',
  'offscreen.js',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
  'icons/icon.svg'
];

function main() {
  const manifest = readManifest();
  validateRuntimeFiles();
  validateManifestReferences(manifest);

  fs.mkdirSync(distDir, { recursive: true });

  const zipName = `naver-report-extension-v${manifest.version}.zip`;
  const zipPath = path.join(distDir, zipName);
  const entries = runtimeFiles.map((filePath) => ({
    path: filePath,
    data: fs.readFileSync(path.join(projectRoot, filePath))
  }));
  const zipBytes = createZipArchive(entries);

  fs.writeFileSync(zipPath, Buffer.from(zipBytes));

  const sizeKb = Math.ceil(fs.statSync(zipPath).size / 1024);
  console.log(`Created ${path.relative(projectRoot, zipPath)} (${sizeKb} KB)`);
  console.log(`Included ${entries.length} runtime files.`);
}

function readManifest() {
  const manifestPath = path.join(projectRoot, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  if (manifest.manifest_version !== 3) {
    throw new Error('Chrome Web Store build requires manifest_version 3.');
  }
  if (!manifest.version) {
    throw new Error('manifest.json must include a version.');
  }

  return manifest;
}

function validateRuntimeFiles() {
  for (const filePath of runtimeFiles) {
    const absolutePath = path.join(projectRoot, filePath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Missing runtime file: ${filePath}`);
    }
    if (!fs.statSync(absolutePath).isFile()) {
      throw new Error(`Runtime entry is not a file: ${filePath}`);
    }
  }
}

function validateManifestReferences(manifest) {
  const requiredFiles = new Set();

  if (manifest.background && manifest.background.service_worker) {
    requiredFiles.add(manifest.background.service_worker);
  }

  if (manifest.action) {
    if (manifest.action.default_popup) {
      requiredFiles.add(manifest.action.default_popup);
    }
    collectIconFiles(manifest.action.default_icon, requiredFiles);
  }

  collectIconFiles(manifest.icons, requiredFiles);

  for (const script of manifest.content_scripts || []) {
    for (const jsFile of script.js || []) {
      requiredFiles.add(jsFile);
    }
    for (const cssFile of script.css || []) {
      requiredFiles.add(cssFile);
    }
  }

  for (const htmlFile of ['popup.html', 'offscreen.html']) {
    requiredFiles.add(htmlFile);
  }

  for (const filePath of requiredFiles) {
    if (!runtimeFiles.includes(filePath)) {
      throw new Error(`Manifest references a file missing from build list: ${filePath}`);
    }
  }
}

function collectIconFiles(iconConfig, targetSet) {
  if (!iconConfig) {
    return;
  }

  if (typeof iconConfig === 'string') {
    targetSet.add(iconConfig);
    return;
  }

  for (const filePath of Object.values(iconConfig)) {
    targetSet.add(filePath);
  }
}

main();
