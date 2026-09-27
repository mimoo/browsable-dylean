// DOM-level behavior tests; no browser or network service required.
const {test, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const root = path.resolve(__dirname, '..');
const dom = new JSDOM(fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8'), {url:'https://example.test/subpath/', runScripts:'outside-only', pretendToBeVisual:true});
const w = dom.window;
w.URL.createObjectURL = () => 'blob:test'; w.URL.revokeObjectURL = () => {};
w.matchMedia = () => ({matches:false});
w.HTMLDialogElement.prototype.showModal = function () {this.setAttribute('open', '');};
w.HTMLDialogElement.prototype.close = function () {this.removeAttribute('open');};
w.eval(fs.readFileSync(path.join(root, 'dist/data.js'), 'utf8'));
w.eval(fs.readFileSync(path.join(root, 'dist/app.js'), 'utf8'));
const $ = s => w.document.querySelector(s);
const wait = (ms = 130) => new Promise(resolve => setTimeout(resolve, ms));
const D = w.DYLEAN_DATA;
after(() => w.close());

test('definition links use compiler locations; Back and Forward restore source position', async () => {
  await wait();
  const origin = w.location.hash;
  const trace = Object.values(D.symbols).find(s => s.name === 'DY.Trace');
  const a = [...w.document.querySelectorAll('#code a.symbol-link')].find(a => JSON.parse(a.dataset.targets).includes(trace.id) && !a.classList.contains('definition'));
  assert.ok(a);
  $('#code').scrollTop = 432;
  a.click(); await wait();
  assert.equal(new w.URLSearchParams(w.location.hash.slice(1)).get('symbol'), trace.id);
  assert.equal($('.symbol-name').textContent, 'DY.Trace');
  assert.ok($('#L' + (trace.range[0] + 1)).classList.contains('target'));
  $('#back').click(); await wait();
  assert.equal(w.location.hash, origin);
  assert.equal($('#code').scrollTop, 432);
  assert.equal($('#forward').disabled, false);
  $('#forward').click(); await wait();
  assert.equal($('.symbol-name').textContent, 'DY.Trace');
});

test('callers hierarchy expands lazily and references navigate to exact use sites', async () => {
  const expand = $('#inspect-content .tree-toggle:not([disabled])');
  assert.ok(expand); expand.click();
  assert.equal(expand.getAttribute('aria-expanded'), 'true');
  assert.ok(expand.closest('li').querySelector(':scope > .tree'));
  expand.click(); assert.equal(expand.getAttribute('aria-expanded'), 'false');
  $('[data-tab="references"]').click();
  const a = $('#inspect-content a'); assert.ok(a);
  const hash = a.hash; a.click(); await wait();
  assert.equal(w.location.hash, hash);
  assert.ok($('.line.target'));
});

test('mobile views, source wrapping, search modes, and file imports are usable', async () => {
  $('.mobile-nav [data-view="files"]').click();
  assert.equal($('.workspace').dataset.view, 'files');
  $('#file-filter').value = 'SignedDH/Specification'; $('#file-filter').dispatchEvent(new w.Event('input'));
  assert.equal(w.document.querySelectorAll('#file-list a').length, 1);
  $('#file-list a').click(); await wait();
  assert.equal($('.workspace').dataset.view, 'code');
  assert.equal($('#filename').textContent, 'Examples/SignedDH/Specification.lean');
  $('#wrap').click(); assert.equal($('#code').classList.contains('wrap'), false);
  $('#wrap').click(); assert.equal($('#code').classList.contains('wrap'), true);
  $('.mobile-nav [data-view="inspect"]').click(); $('[data-tab="imports"]').click();
  assert.ok($('#inspect-content a')); assert.equal($('.workspace').dataset.view, 'inspect');
  $('#search-open').click(); assert.ok($('#search-dialog').open);
  $('#search-input').value = 'DY.Trace.length'; $('#search-input').dispatchEvent(new w.Event('input')); await wait();
  assert.ok($('#search-results a').textContent.includes('DY.Trace.length'));
  $('#search-input').value = 'Trace.length';
  $('[data-mode="text"]').click(); assert.ok($('#search-results a'));
  $('#search-results a').click(); await wait();
  assert.equal($('#search-dialog').open, false);
  assert.equal($('.workspace').dataset.view, 'code');
});

test('every file renders source text faithfully, including Unicode and nested comments', async () => {
  for (const file of Object.values(D.files)) {
    const a = w.document.createElement('a');
    a.href = '#' + new w.URLSearchParams({file:file.path,line:'1'});
    w.document.body.append(a); a.click(); a.remove();
    const rendered = [...w.document.querySelectorAll('#code .line-text')].map(el => el.textContent === '\n' ? '' : el.textContent).join('\n');
    assert.equal(rendered, file.text, file.path);
  }
  await wait();
});

test('recursive declarations terminate hierarchy cycles', async () => {
  const s = Object.values(D.symbols).find(s => s.name === 'DY.Trace.length');
  assert.ok(s.callees.includes(s.id));
  const a = w.document.createElement('a');
  a.href = '#' + new w.URLSearchParams({file:s.file,line:String(s.range[0] + 1),symbol:s.id});
  w.document.body.append(a); a.click(); a.remove();
  $('[data-tab="callees"]').click();
  const cycle = [...w.document.querySelectorAll('#inspect-content [data-node]')].find(b => b.dataset.node === s.id);
  assert.ok(cycle); assert.equal(cycle.disabled, true); assert.equal(cycle.textContent, '↻');
  await wait();
});

test('standalone file:// export supports definition jumps and Back', async () => {
  const offline = new JSDOM(fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8'), {url:'file:///tmp/dylean/index.html',runScripts:'outside-only',pretendToBeVisual:true});
  const v = offline.window;
  v.URL.createObjectURL = () => 'blob:offline'; v.URL.revokeObjectURL = () => {};
  v.matchMedia = () => ({matches:false});
  try {
    v.eval(fs.readFileSync(path.join(root, 'dist/data.js'), 'utf8'));
    v.eval(fs.readFileSync(path.join(root, 'dist/app.js'), 'utf8'));
    await wait();
    const initial = v.location.hash;
    v.document.querySelector('#code').scrollTop = 123;
    v.document.querySelector('#code a.symbol-link').click(); await wait();
    assert.ok(v.location.hash.includes('symbol='));
    v.document.querySelector('#back').click(); await wait();
    assert.equal(v.location.hash, initial);
    assert.equal(v.document.querySelector('#code').scrollTop, 123);
  } finally {v.close();}
});
