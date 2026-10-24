// Static discovery/route contract. Runs with Node only; no build or dependency.
import assert from 'node:assert/strict';
import {readFileSync, existsSync, statSync} from 'node:fs';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const origin='https://heldnote.app';
const pages=[
 ['/', 'index.html','en'], ['/tr/','tr/index.html','tr'],
 ['/about','about.html','en'],
 ['/guides/browser-note-storage','guides/browser-note-storage.html','en'],
 ['/guides/history-sync-backup','guides/history-sync-backup.html','en'],
 ['/sponsorship','sponsorship.html','en'],
];
function targetFor(path){
 const base=join(root,decodeURIComponent(path).split(/[?#]/)[0]);
 if(existsSync(base)&&statSync(base).isDirectory())return join(base,'index.html');
 if(existsSync(base))return base;
 return base+'.html';
}
const sitemap=readFileSync(join(root,'sitemap.xml'),'utf8');
for(const [path,file,lang] of pages){
 const html=readFileSync(join(root,file),'utf8');
 assert.match(html,new RegExp('<html lang="'+lang+'">'),file+' language');
 assert.ok(html.includes('rel="canonical" href="'+origin+path+'"'),file+' canonical');
 assert.match(html,/<meta name="description" content="[^"]{50,}">/,file+' description');
 assert.equal((html.match(/<h1(?:\s|>)/g)||[]).length,1,file+' needs one visible H1');
 assert.match(html,/<main id="main"/,file+' landmark');
 assert.ok(!html.includes('src="app.js"'),file+' must not boot the editor');
 assert.ok(sitemap.includes('<loc>'+origin+path+'</loc>'),file+' in sitemap');
 for(const match of html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)){
  const data=JSON.parse(match[1]);
  assert.equal(data['@context'],'https://schema.org');
 }
 for(const [,attr,value] of html.matchAll(/\s(href|src)="([^"]+)"/g)){
  if(!value.startsWith('/'))continue;
  assert.ok(!value.startsWith('//'),file+' should not load protocol-relative resources');
  assert.ok(existsSync(targetFor(value)),file+' missing '+attr+' target '+value);
 }
 for(const [,url] of html.matchAll(/<script\b[^>]*src="([^"]+)"/g)){
  assert.ok(url.startsWith('/'),file+' must not load remote scripts');
 }
}
for(const [,file] of pages.slice(0,2)){
 const html=readFileSync(join(root,file),'utf8');
 for(const [lang,path] of [['en','/'],['tr','/tr/'],['x-default','/']]){
  assert.ok(html.includes('hreflang="'+lang+'" href="'+origin+path+'"'),file+' reciprocal alternate '+lang);
 }
}
const app=readFileSync(join(root,'app.html'),'utf8');
assert.match(app,/<meta name="robots" content="noindex,follow">/);
assert.match(app,/<script type="module" src="app.js"><\/script>/);
assert.ok(!sitemap.includes('<loc>'+origin+'/app</loc>'),'editor is excluded from sitemap');
const manifest=JSON.parse(readFileSync(join(root,'manifest.webmanifest'),'utf8'));
assert.equal(manifest.id,'/','preserve the existing installed identity');
assert.equal(manifest.start_url,'/','preserve the installed launch URL');
const publicCode=readFileSync(join(root,'public.js'),'utf8');
assert.ok(!/indexedDB|localStorage|fetch\s*\(/.test(publicCode),'public demo must not access note storage or services');
const robots=readFileSync(join(root,'robots.txt'),'utf8');
assert.equal((robots.match(/^User-agent:/gm)||[]).length,1,'all crawlers inherit test exclusions');
assert.ok(robots.includes('Disallow: /tests/'));
const png=readFileSync(join(root,'social-card.png'));
assert.equal(png.readUInt32BE(16),1200);
assert.equal(png.readUInt32BE(20),630);
const preview=readFileSync(join(root,'preview/premium/index.html'),'utf8');
assert.match(preview,/<meta name="robots" content="noindex,nofollow">/);
assert.ok(preview.includes("connect-src 'none'"),'prototype blocks network service requests');
assert.ok(!sitemap.includes('/preview/'),'prototype stays out of the sitemap');
for(const [,file] of pages){
 assert.ok(!readFileSync(join(root,file),'utf8').includes('/preview/'),'public pages must not promote the prototype');
}
for(const file of ['preview/premium/model.js','preview/premium/preview.js']){
 const code=readFileSync(join(root,file),'utf8');
 assert.ok(!/indexedDB|localStorage|sessionStorage|fetch\s*\(|\.\.\//.test(code),file+' must not access storage, services or production modules');
}
console.log('public-pages: OK (6 public pages, metadata, links, schema, PWA identity and storage boundary)');
