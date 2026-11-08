import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const docsDir = resolve(__dirname, '../docs');

const EXPECTED_HTML_FILES = [
  'index.html',
  'code-guide/01-js-ts-react-syntax-in-codebase.html',
  'code-guide/02-shared-preload-and-signaling-code.html',
  'code-guide/03-main-process-and-p2p-engine-code.html',
  'code-guide/04-renderer-ui-and-inquiry-qa.html',
  'user-guide/00-js-ts-npm-fundamentals.html',
  'user-guide/01-getting-started.html',
  'user-guide/02-network-and-groups.html',
  'user-guide/03-library-and-sharing.html',
  'user-guide/04-search-and-discovery.html',
  'user-guide/05-transfers-and-downloads.html',
  'user-guide/06-signaling-and-ops.html',
  'user-guide/07-troubleshooting-and-faq.html',
  'theory/01-distributed-topology.html',
  'theory/02-election-and-consistent-hashing.html',
  'theory/03-virtual-overlays-and-consensus.html',
  'theory/04-nat-traversal-and-webrtc.html',
  'theory/05-flow-control-and-integrity.html',
  'theory/06-security-and-threat-model.html',
  'architecture/01-system-overview.html',
  'architecture/02-peer-engine-lifecycle.html',
  'architecture/03-wire-protocol-specification.html',
  'architecture/04-storage-and-persistence.html',
  'operations/01-cloud-deployment.html',
  'operations/02-testing-and-verification.html',
];

console.log('[Verify] Starting HTML Documentation Suite Verification...');

let errors = [];
let checkedLinks = 0;
let checkedImages = 0;
let checkedScripts = 0;

// 1. Check all expected files exist
for (const relFile of EXPECTED_HTML_FILES) {
  const fullPath = join(docsDir, relFile);
  if (!existsSync(fullPath)) {
    errors.push(`Missing expected HTML file: ${relFile}`);
  }
}

// 2. Validate links, images, scripts, and anchor targets in each file
for (const relFile of EXPECTED_HTML_FILES) {
  const filePath = join(docsDir, relFile);
  if (!existsSync(filePath)) continue;

  const content = readFileSync(filePath, 'utf-8');
  const fileDir = dirname(filePath);

  // Collect all IDs on this page
  const ids = new Set();
  const idRegex = /\bid=["']([^"']+)["']/g;
  let match;
  while ((match = idRegex.exec(content)) !== null) {
    ids.add(match[1]);
  }

  // Validate <a> hrefs
  const aRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>/gi;
  while ((match = aRegex.exec(content)) !== null) {
    const href = match[1];
    checkedLinks++;

    // External or mailto link
    if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:')) {
      continue;
    }

    // Local anchor
    if (href.startsWith('#')) {
      const anchorId = href.slice(1);
      if (!ids.has(anchorId)) {
        errors.push(`[${relFile}] Broken local anchor: ${href} (id "${anchorId}" not found)`);
      }
      continue;
    }

    // Relative link, possibly with anchor
    const [pathPart, anchorPart] = href.split('#');
    const targetPath = resolve(fileDir, pathPart);

    if (!existsSync(targetPath)) {
      errors.push(`[${relFile}] Broken link: ${href} -> resolved to ${targetPath} (not found)`);
    } else if (anchorPart && targetPath.endsWith('.html')) {
      const targetContent = readFileSync(targetPath, 'utf-8');
      const targetHasId = new RegExp(`\\bid=["']${anchorPart}["']`).test(targetContent);
      if (!targetHasId) {
        errors.push(`[${relFile}] Broken anchor target: ${href} (id "${anchorPart}" not in ${pathPart})`);
      }
    }
  }

  // Validate <img src="...">
  const imgRegex = /<img\s+[^>]*src=["']([^"']+)["'][^>]*>/gi;
  while ((match = imgRegex.exec(content)) !== null) {
    const src = match[1];
    checkedImages++;

    if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) {
      continue;
    }

    const targetPath = resolve(fileDir, src);
    if (!existsSync(targetPath)) {
      errors.push(`[${relFile}] Broken image: ${src} -> resolved to ${targetPath} (not found)`);
    }
  }

  // Validate <link href="...">
  const linkRegex = /<link\s+[^>]*href=["']([^"']+)["'][^>]*>/gi;
  while ((match = linkRegex.exec(content)) !== null) {
    const href = match[1];
    if (href.startsWith('http://') || href.startsWith('https://')) continue;

    const targetPath = resolve(fileDir, href);
    if (!existsSync(targetPath)) {
      errors.push(`[${relFile}] Broken stylesheet link: ${href} -> resolved to ${targetPath} (not found)`);
    }
  }

  // Validate <script src="...">
  const scriptRegex = /<script\s+[^>]*src=["']([^"']+)["'][^>]*>/gi;
  while ((match = scriptRegex.exec(content)) !== null) {
    const src = match[1];
    checkedScripts++;

    if (src.startsWith('http://') || src.startsWith('https://')) continue;

    const targetPath = resolve(fileDir, src);
    if (!existsSync(targetPath)) {
      errors.push(`[${relFile}] Broken script src: ${src} -> resolved to ${targetPath} (not found)`);
    }
  }
}

console.log(`[Verify] Scanned ${EXPECTED_HTML_FILES.length} HTML files.`);
console.log(`[Verify] Checked ${checkedLinks} links, ${checkedImages} images, ${checkedScripts} scripts.`);

if (errors.length > 0) {
  console.error(`\n[Verify] FAILED with ${errors.length} error(s):`);
  errors.forEach((err) => console.error(`  - ${err}`));
  process.exit(1);
} else {
  console.log('[Verify] All HTML documentation files, links, anchors, and assets verified successfully! (PASS)');
}
