// Builds dist/cda-website.zip: only the files Netlify needs (no node_modules, sources or secrets).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

// Optional: npm run zip -- --domain=https://caribbeandawah.tt  (sets the link-preview tags)
const domainArg = process.argv.find((a) => a.startsWith('--domain='));
const domain = domainArg ? domainArg.slice(9).replace(/\/+$/, '') : '';
if (domain && !/^https:\/\/[a-z0-9.-]+$/i.test(domain)) throw new Error('--domain must look like https://example.tt');

const INCLUDE = [
  'index.html', '404.html', 'robots.txt', 'netlify.toml', 'README.md',
  'assets', 'content', 'uploads', 'admin', 'netlify/functions', 'netlify/lib'
];
for (const p of INCLUDE) if (!existsSync(p)) throw new Error('Missing ' + p);

execFileSync('node', ['scripts/build-functions.mjs'], { stdio: 'inherit' });
mkdirSync('dist', { recursive: true });
rmSync('dist/cda-website', { recursive: true, force: true });
rmSync('dist/cda-website.zip', { force: true });
mkdirSync('dist/cda-website/netlify', { recursive: true });
for (const p of INCLUDE) {
  execFileSync('cp', ['-R', p, 'dist/cda-website/' + (p.startsWith('netlify/') ? 'netlify/' : '')]);
}
execFileSync('find', ['dist/cda-website', '-name', '.DS_Store', '-delete']);

// Link previews (WhatsApp, Facebook) must not point at the GitHub preview.
const indexPath = 'dist/cda-website/index.html';
let html = readFileSync(indexPath, 'utf8');
const ghBase = 'https://samisayyed1.github.io/caribbean-dawah-association/';
html = domain
  ? html.split(ghBase).join(domain + '/')
  : html.replace(/\s*<meta property="og:url"[^>]*>/, '').split(ghBase + 'assets/').join('/assets/');
if (html.includes('github.io')) throw new Error('index.html still references github.io');
writeFileSync(indexPath, html);
execFileSync('zip', ['-qr', 'cda-website.zip', 'cda-website'], { cwd: 'dist' });
console.log('Created dist/cda-website.zip' + (domain ? ' for ' + domain : ' (no domain set: preview image uses a relative link)'));
