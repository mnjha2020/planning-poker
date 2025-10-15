// Duplicates index.html to 404.html so deep links work on GitHub Pages
import fs from 'fs';
import path from 'path';
const dist = path.resolve(process.cwd(), 'dist');
try {
  fs.copyFileSync(path.join(dist, 'index.html'), path.join(dist, '404.html'));
  console.log('Created dist/404.html for SPA fallback');
} catch (e) {
  console.log('spa-404: skip (dist not built yet)');
}