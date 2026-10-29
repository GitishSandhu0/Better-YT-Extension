#!/usr/bin/env node
/*
 * Repository sanity checks for Better YouTube.
 *
 * Run with: npm run check
 *
 * This does not launch a browser. It validates the manifest, referenced files,
 * DNR rule shape, JS syntax and CSS brace balance.
 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import process from "node:process";

const root = process.cwd();
const errors = [];
const checkedFiles = new Set();

function fail(message) {
  errors.push(message);
}

function readJson(relativePath) {
  const absolute = path.join(root, relativePath);
  try {
    const source = fs.readFileSync(absolute, "utf8");
    return JSON.parse(source);
  } catch (error) {
    fail(`${relativePath}: ${error.message}`);
    return null;
  }
}

function checkExists(relativePath, label) {
  const absolute = path.join(root, relativePath);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    fail(`${label}: missing file ${relativePath}`);
    return false;
  }
  checkedFiles.add(relativePath);
  return true;
}

function walk(directory) {
  const absolute = path.join(root, directory);
  if (!fs.existsSync(absolute)) return [];

  const files = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

function checkJavaScript(relativePath) {
  const absolute = path.join(root, relativePath);
  const source = fs.readFileSync(absolute, "utf8");

  try {
    new vm.Script(source, { filename: relativePath });
  } catch (error) {
    fail(`${relativePath}: JavaScript syntax error: ${error.message}`);
  }
}

function checkCss(relativePath) {
  const absolute = path.join(root, relativePath);
  const source = fs.readFileSync(absolute, "utf8");

  let depth = 0;
  for (const character of source) {
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
    if (depth < 0) break;
  }

  if (depth !== 0) {
    fail(`${relativePath}: unbalanced CSS braces (depth ${depth})`);
  }
}

function checkPng(relativePath) {
  const absolute = path.join(root, relativePath);
  const buffer = fs.readFileSync(absolute);

  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buffer.subarray(0, 8).equals(pngMagic)) {
    fail(`${relativePath}: not a valid PNG`);
  }
}

function checkHtml(relativePath) {
  const absolute = path.join(root, relativePath);
  const source = fs.readFileSync(absolute, "utf8");
  const base = path.dirname(relativePath);

  const scriptPattern = /<script\s+[^>]*src=["']([^"']+)["'][^>]*>/gi;
  const linkPattern = /<link\s+[^>]*href=["']([^"']+)["'][^>]*>/gi;

  for (const match of source.matchAll(scriptPattern)) {
    const src = match[1];
    if (/^(?:https?:|data:|chrome-extension:)/i.test(src)) continue;
    checkExists(path.join(base, src), `${relativePath} script`);
  }

  for (const match of source.matchAll(linkPattern)) {
    const href = match[1];
    if (/^(?:https?:|data:|chrome-extension:)/i.test(href)) continue;
    checkExists(path.join(base, href), `${relativePath} stylesheet`);
  }
}

function checkRuleFile(relativePath) {
  const rules = readJson(relativePath);
  if (!Array.isArray(rules)) {
    fail(`${relativePath}: ruleset must be a JSON array`);
    return;
  }

  const ids = new Set();

  for (const [index, rule] of rules.entries()) {
    const where = `${relativePath}[${index}]`;

    if (!Number.isInteger(rule.id) || rule.id <= 0) {
      fail(`${where}: id must be a positive integer`);
    } else if (ids.has(rule.id)) {
      fail(`${where}: duplicate id ${rule.id}`);
    } else {
      ids.add(rule.id);
    }

    if (!rule.action || typeof rule.action.type !== "string") {
      fail(`${where}: missing action.type`);
    }

    if (!rule.condition || typeof rule.condition !== "object") {
      fail(`${where}: missing condition`);
      continue;
    }

    if (rule.condition.regexFilter) {
      try {
        new RegExp(rule.condition.regexFilter);
      } catch (error) {
        fail(`${where}: invalid regexFilter: ${error.message}`);
      }
    }

    if (
      rule.action &&
      rule.action.type === "redirect" &&
      (!rule.action.redirect ||
        typeof rule.action.redirect.regexSubstitution !== "string")
    ) {
      fail(`${where}: redirect action needs regexSubstitution`);
    }
  }
}

const manifest = readJson("manifest.json");

if (manifest) {
  if (manifest.manifest_version !== 3) {
    fail("manifest.json: manifest_version must be 3");
  }

  if (!manifest.name || !manifest.version) {
    fail("manifest.json: name and version are required");
  }

  if (!manifest.permissions || !manifest.permissions.includes("storage")) {
    fail("manifest.json: storage permission is required");
  }

  if (
    !manifest.permissions ||
    !manifest.permissions.includes("declarativeNetRequest")
  ) {
    fail("manifest.json: declarativeNetRequest permission is required");
  }

  for (const [size, iconPath] of Object.entries(manifest.icons || {})) {
    if (checkExists(iconPath, `icon ${size}`)) checkPng(iconPath);
  }

  for (const [size, iconPath] of Object.entries(
    (manifest.action && manifest.action.default_icon) || {}
  )) {
    if (checkExists(iconPath, `action icon ${size}`)) checkPng(iconPath);
  }

  if (manifest.action && manifest.action.default_popup) {
    checkExists(manifest.action.default_popup, "popup");
  }

  if (manifest.options_ui && manifest.options_ui.page) {
    checkExists(manifest.options_ui.page, "options page");
  }

  if (manifest.background && manifest.background.service_worker) {
    checkExists(manifest.background.service_worker, "service worker");
  }

  for (const script of manifest.content_scripts || []) {
    if (script.world && !["MAIN", "ISOLATED"].includes(script.world)) {
      fail(`manifest.json: invalid content script world ${script.world}`);
    }

    for (const file of script.js || []) {
      checkExists(file, "content script");
    }

    for (const file of script.css || []) {
      checkExists(file, "content stylesheet");
    }
  }

  for (const resource of
    (manifest.declarative_net_request &&
      manifest.declarative_net_request.rule_resources) ||
    []) {
    if (checkExists(resource.path, `ruleset ${resource.id}`)) {
      checkRuleFile(resource.path);
    }
  }
}

for (const directory of ["lib", "src", "popup", "options", "test"]) {
  for (const file of walk(directory)) {
    const extension = path.extname(file).toLowerCase();

    if (extension === ".js" || extension === ".mjs") checkJavaScript(file);
    if (extension === ".css") checkCss(file);
    if (extension === ".html") checkHtml(file);
  }
}

for (const file of ["manifest.json", "package.json"]) {
  if (fs.existsSync(path.join(root, file))) readJson(file);
}

if (errors.length > 0) {
  console.error(`\nBetter YouTube check failed with ${errors.length} error(s):\n`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(
  `Better YouTube check passed: ${checkedFiles.size} referenced files, all JS/CSS/HTML valid.`
);
