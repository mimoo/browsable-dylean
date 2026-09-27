'use strict';
(() => {
  const D = window.DYLEAN_DATA;
  const $ = (s, parent = document) => parent.querySelector(s);
  const $$ = (s, parent = document) => [...parent.querySelectorAll(s)];
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const files = Object.values(D.files), symbols = Object.values(D.symbols);
  let current, selected, tab = 'callers', mode = 'symbols', rawURL, searchTimer;
  let historyIndex = history.state?.dyIndex || 0, historyMax = historyIndex;
  const codeCache = new Map();
  const loadingFiles = new Map();
  function ensureFile(file) {
    if (typeof file.text === 'string') return Promise.resolve();
    if (loadingFiles.has(file.path)) return loadingFiles.get(file.path);
    const task = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = file.asset;
      script.onload = () => {script.remove(); typeof file.text === 'string' ? resolve() : reject(new Error('Empty library source'));};
      script.onerror = () => {script.remove(); reject(new Error('Library source could not be loaded'));};
      document.head.append(script);
    }).finally(() => loadingFiles.delete(file.path));
    loadingFiles.set(file.path, task);
    return task;
  }
  function href(file, line = 1, symbol = '') {
    const q = new URLSearchParams({file, line: String(line)});
    if (symbol) q.set('symbol', symbol);
    return '#' + q.toString();
  }
  const symbolHref = id => {const s = D.symbols[id]; return href(s.file, s.range[0] + 1, id);};
  function link(id, extra = '') {
    const s = D.symbols[id];
    return `<a class="item" href="${esc(symbolHref(id))}">${esc(s.name)}${extra}</a>`;
  }
  function setView(view) {
    $('.workspace').dataset.view = view;
    $$('.mobile-nav button').forEach(b => {b.classList.toggle('active', b.dataset.view === view); b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false');});
  }
  function updateHistory(state, hash, replace = false) {
    // file:// browsers may reject URL changes through the History API.
    if (location.protocol === 'file:') {
      if (replace) location.replace(hash); else location.hash = hash;
      history.replaceState(state, '');
    } else history[replace ? 'replaceState' : 'pushState'](state, '', hash);
  }
  function savePosition() {
    history.replaceState({...history.state, dyIndex: historyIndex, scroll: $('#code').scrollTop, left: $('#code').scrollLeft}, '');
  }
  function navigate(hash) {
    savePosition();
    if (hash !== location.hash) {
      historyIndex++; historyMax = historyIndex;
      updateHistory({dyIndex: historyIndex}, hash);
    }
    renderRoute(false);
  }
  function renderFiles() {
    const q = $('#file-filter').value.toLowerCase();
    const groups = new Map();
    files.filter(f => f.path.toLowerCase().includes(q)).forEach(f => {
      const group = f.path.includes('/') ? f.path.split('/')[0] : 'Repository';
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(f);
    });
    $('#file-list').innerHTML = [...groups].map(([group, list]) => `<details class="file-group" ${group !== 'Library' || current?.startsWith('Library/') || q ? 'open' : ''}><summary>${esc(group)} <small>(${list.length})</small></summary>${list.map(f => `<a class="item file-item ${f.path === current ? 'active' : ''}" ${f.path === current ? 'aria-current="page"' : ''} href="${esc(href(f.path))}">${esc(group === 'Repository' ? f.path : f.path.slice(group.length + 1))}</a>`).join('')}</details>`).join('') || '<p class="hint">No matching files.</p>';
  }
  const keywords = new Set('module import public private protected meta noncomputable namespace end section variable universe open export def theorem lemma abbrev inductive structure class instance opaque axiom where deriving by do let have show from exact apply intro intros cases induction match with if then else return fun for in unless try catch simp grind constructor repeat sorry set_option syntax macro macro_rules elab example attribute local extends mutual partial termination_by decreasing_by'.split(' '));
  function lexicalRanges(text) {
    const ranges = []; let i = 0;
    while (i < text.length) {
      const start = i;
      if (text.startsWith('--', i)) {
        i = text.indexOf('\n', i); if (i < 0) i = text.length;
        ranges.push([start, i, 'comment']);
      } else if (text.startsWith('/-', i)) {
        let depth = 1; i += 2;
        while (i < text.length && depth) {
          if (text.startsWith('/-', i)) {depth++; i += 2;}
          else if (text.startsWith('-/', i)) {depth--; i += 2;} else i++;
        }
        ranges.push([start, i, 'comment']);
      } else if (text[i] === '"') {
        i++;
        while (i < text.length) {if (text[i] === '\\') i += 2; else if (text[i++] === '"') break;}
        ranges.push([start, i, 'string']);
      } else if (/[\p{L}_]/u.test(text[i])) {
        i++;
        while (i < text.length && /[\p{L}\p{N}_'?!]/u.test(text[i])) i++;
        if (keywords.has(text.slice(start, i))) ranges.push([start, i, 'kw']);
      } else if (/[0-9]/.test(text[i])) {
        while (i < text.length && /[0-9]/.test(text[i])) i++;
        ranges.push([start, i, 'number']);
      } else i++;
    }
    return ranges;
  }
  function renderSource(file) {
    if (codeCache.has(file.path)) return codeCache.get(file.path);
    const lines = file.text.split('\n');
    const offsets = []; let offset = 0;
    lines.forEach(line => {offsets.push(offset); offset += line.length + 1;});
    const syntax = Array.from({length: lines.length}, () => []);
    for (const [start, end, kind] of lexicalRanges(file.text)) {
      // Positions and JS string offsets are both UTF-16, as in Lean's LSP index.
      let lo = 0, hi = offsets.length;
      while (lo + 1 < hi) {const mid = (lo + hi) >> 1; if (offsets[mid] <= start) lo = mid; else hi = mid;}
      for (let l = lo; l < lines.length && offsets[l] < end; l++) syntax[l].push([Math.max(0, start - offsets[l]), Math.min(lines[l].length, end - offsets[l]), kind]);
    }
    const refs = Array.from({length: lines.length}, () => []);
    for (const r of file.refs) {
      for (let l = r[0]; l <= r[2] && l < lines.length; l++) {
        const a = l === r[0] ? r[1] : 0, b = l === r[2] ? r[3] : lines[l].length;
        if (b > a) refs[l].push([a, b, r[4], r[5]]);
      }
    }
    lines.forEach((line, l) => {
      const prefix = line.match(/^\s*(?:(?:public|private|meta|all)\s+)*import\s+/);
      if (!prefix) return;
      const tail = line.slice(prefix[0].length).split('--')[0];
      for (const match of tail.matchAll(/[A-Za-z_][A-Za-z0-9_'.]*/g)) {
        if (D.modules[match[0]]) refs[l].push([prefix[0].length + match.index, prefix[0].length + match.index + match[0].length, '@module:' + D.modules[match[0]], false]);
      }
    });
    const html = lines.map((line, l) => {
      const boundaries = [...new Set([0, line.length, ...syntax[l].flatMap(r => r.slice(0, 2)), ...refs[l].flatMap(r => r.slice(0, 2))])].sort((a, b) => a - b);
      let content = '';
      for (let n = 0; n < boundaries.length - 1; n++) {
        const a = boundaries[n], b = boundaries[n + 1];
        const style = syntax[l].find(r => r[0] <= a && r[1] >= b)?.[2];
        let value = esc(line.slice(a, b));
        if (style) value = `<span class="${style}">${value}</span>`;
        const matches = refs[l].filter(r => r[0] <= a && r[1] >= b).sort((x, y) => (x[1] - x[0]) - (y[1] - y[0]) || Number(y[3]) - Number(x[3]));
        if (matches.length) {
          const shortest = matches[0][1] - matches[0][0];
          const ids = [...new Set(matches.filter(r => r[1] - r[0] === shortest).map(r => r[2]))];
          if (ids[0].startsWith('@module:')) {
            const path = ids[0].slice(8);
            content += `<a class="symbol-link module-link" href="${esc(href(path))}" title="Open module ${esc(path)}">${value}</a>`;
            continue;
          }
          const symbol = D.symbols[ids[0]];
          value = `<a class="symbol-link ${matches[0][3] ? 'definition' : ''}" href="${esc(symbolHref(ids[0]))}" data-targets="${esc(JSON.stringify(ids))}" title="${esc(symbol.name)} · ${esc(symbol.kind)} · ${esc(symbol.file)}:${symbol.range[0] + 1}">${value}</a>`;
        }
        content += value;
      }
      return `<div class="line" id="L${l + 1}"><a class="line-number" href="${esc(href(file.path, l + 1))}" aria-label="Line ${l + 1}">${l + 1}</a><span class="line-text">${content || '\n'}</span></div>`;
    }).join('');
    codeCache.set(file.path, html);
    // Keep mobile memory bounded when browsing large modules.
    if (codeCache.size > 5) codeCache.delete(codeCache.keys().next().value);
    return html;
  }
  function inferSymbol(file, line) {
    return file.symbols.filter(id => !D.symbols[id].local).filter(id => {const s = D.symbols[id]; return s.span[0] <= line && s.span[2] >= line;})
      .sort((a, b) => (D.symbols[a].span[2] - D.symbols[a].span[0]) - (D.symbols[b].span[2] - D.symbols[b].span[0]))[0];
  }
  function renderRoute(restore) {
    historyIndex = history.state?.dyIndex || 0;
    $('#back').disabled = historyIndex <= 0;
    $('#forward').disabled = historyIndex >= historyMax;
    const q = new URLSearchParams(location.hash.slice(1));
    const requested = q.get('file');
    const file = D.files[requested] || D.files['DY/Trace/Basic.lean'] || files[0];
    if (typeof file.text !== 'string') {
      const requestedHash = location.hash;
      current = null;
      selected = undefined;
      $('#file-meta').textContent = 'Library source';
      $('#download').removeAttribute('href');
      renderInspector();
      $('#filename').textContent = file.path;
      $('#module-name').textContent = file.module;
      $('#code').innerHTML = '<p class="hint loading-source" role="status">Loading library source…</p>';
      setView('code');
      ensureFile(file).then(() => {if (location.hash === requestedHash) renderRoute(restore);}).catch(() => {
        if (location.hash === requestedHash) $('#code').innerHTML = '<p class="hint loading-source">Unable to load this library file. <button id="retry-source">Retry</button></p>';
      });
      return;
    }
    const line = Math.max(1, Math.min(file.text.split('\n').length, Number(q.get('line')) || 1));
    selected = D.symbols[q.get('symbol')]?.file === file.path ? q.get('symbol') : inferSymbol(file, line - 1);
    if (selected && D.symbols[selected].local) tab = 'references';
    if (current !== file.path) {
      current = file.path;
      $('#module-name').textContent = file.module;
      $('#filename').textContent = file.path;
      $('#file-meta').textContent = `${file.text.split('\n').length.toLocaleString()} lines · ${file.symbols.filter(id => !D.symbols[id].local).length} declarations`;
      $('#code').innerHTML = renderSource(file);
      if (rawURL) URL.revokeObjectURL(rawURL);
      rawURL = URL.createObjectURL(new Blob([file.text], {type:'text/plain;charset=utf-8'}));
      $('#download').href = rawURL; $('#download').download = file.path.split('/').pop();
      $('#outline').innerHTML = file.symbols.filter(id => !D.symbols[id].generated && !D.symbols[id].local).map(id => `<a class="item outline-item" href="${esc(symbolHref(id))}">${esc(D.symbols[id].name)}<small>${esc(D.symbols[id].kind)} · L${D.symbols[id].range[0] + 1}</small></a>`).join('') || '<p class="hint">No declarations in this file.</p>';
      renderFiles();
    }
    $$('.line.target').forEach(el => el.classList.remove('target'));
    const target = document.getElementById('L' + line);
    target?.classList.add('target');
    $('#location-status').textContent = selected ? D.symbols[selected].name + ' · L' + line : file.module + ' · L' + line;
    document.title = `${file.path} · DyLean`;
    renderInspector(); setView('code');
    historyIndex = history.state?.dyIndex || 0;
    $('#back').disabled = historyIndex <= 0;
    $('#forward').disabled = historyIndex >= historyMax;
    requestAnimationFrame(() => {
      if (restore && history.state?.scroll != null) {$('#code').scrollTop = history.state.scroll; $('#code').scrollLeft = history.state.left || 0;}
      else if (target) $('#code').scrollTop = target.offsetTop - $('#code').offsetTop - 70;
    });
    if (requested && !D.files[requested]) toast('File not found. Showing the trace module.');
  }
  function treeRows(ids, ancestry) {
    return `<ul class="tree">${ids.map(id => {
      const cycle = ancestry.includes(id), s = D.symbols[id], children = s[tab];
      return `<li><div class="tree-row"><button class="tree-toggle" ${cycle || !children.length ? 'disabled' : ''} data-node="${esc(id)}" data-ancestors="${esc(JSON.stringify(ancestry))}" aria-expanded="false" aria-label="Expand ${esc(s.name)}">${cycle ? '↻' : children.length ? '▸' : '·'}</button>${link(id, `<small>${children.length} ${tab}${cycle ? ' · cycle' : ''}</small>`)}</div></li>`;
    }).join('')}</ul>`;
  }
  function renderInspector() {
    if (!D.files[current]) {
      $('#symbol-heading').textContent = 'Loading source…';
      $('#inspect-content').textContent = 'Symbol details will appear when the source loads.';
      return;
    }
    const s = D.symbols[selected];
    $('#symbol-heading').innerHTML = s ? `<span class="badge">${esc(s.kind)}</span><h2 class="symbol-name">${esc(s.name)}</h2><div class="symbol-location"><a href="${esc(symbolHref(selected))}">${esc(s.file)}:${s.range[0] + 1}</a><br>${s.uses.length} references · ${s.callers.length} callers</div>` : '<h2 class="symbol-name">Explore this file</h2><p class="hint">Tap a symbol in the code or choose one from the file outline.</p>';
    $$('.inspect-tabs button').forEach(b => {b.setAttribute('aria-selected', b.dataset.tab === tab); b.tabIndex = b.dataset.tab === tab ? 0 : -1;});
    const pane = $('#inspect-content');
    if (tab === 'imports') {
      const f = D.files[current], importedBy = files.filter(x => x.imports.includes(f.module));
      const moduleLink = m => D.modules[m] ? `<a class="item" href="${esc(href(D.modules[m]))}">${esc(m)}</a>` : `<div class="item">${esc(m)}<small>External library · not bundled</small></div>`;
      pane.innerHTML = `<p class="section-label">IMPORTS · ${f.imports.length}</p>${f.imports.map(moduleLink).join('') || '<p class="hint">No direct imports.</p>'}<p class="section-label">IMPORTED BY · ${importedBy.length}</p>${importedBy.map(x => moduleLink(x.module)).join('') || '<p class="hint">No importing modules in this repository.</p>'}`;
    } else if (!s) pane.innerHTML = '<p class="hint">Select a declaration to see its dependencies. The Imports tab is available for every file.</p>';
    else if (tab === 'references') {
      pane.innerHTML = `<p class="hint">${s.uses.length} resolved source references</p>` + (s.uses.map(([path, line, , , , owner]) => `<a class="item" href="${esc(href(path, line + 1, owner || ''))}">${esc(path)}:${line + 1}<small>${esc(owner ? D.symbols[owner].name : 'Module-level reference')}</small><span class="ref-code">${esc(D.files[path].text?.split('\n')[line]?.trim() || 'Open reference in library source')}</span></a>`).join('') || '<p class="hint">No recorded references in this repository.</p>');
    } else {
      pane.innerHTML = `<p class="hint">${tab === 'callers' ? 'Declarations that use this symbol.' : 'Symbols used by this declaration.'} Includes types and proofs. Expand branches to explore.</p>` + (s[tab].length ? treeRows(s[tab], [selected]) : `<p class="hint">No recorded ${tab} in this repository.</p>`);
    }
  }
  function search() {
    const q = $('#search-input').value.trim().toLowerCase();
    const tokens = q.split(/\s+/).filter(Boolean);
    let results = [], total = 0;
    const matches = str => tokens.every(t => str.toLowerCase().includes(t));
    if (mode === 'symbols') {
      const found = symbols.filter(s => !s.generated && !s.local && matches(s.name + ' ' + s.file)).sort((a, b) => Number(b.name.toLowerCase().endsWith(q)) - Number(a.name.toLowerCase().endsWith(q)) || a.name.localeCompare(b.name));
      total = found.length;
      results = found.slice(0, 100).map(s => link(s.id, `<small>${esc(s.kind)} · ${esc(s.file)}:${s.range[0] + 1}</small>`));
    } else if (mode === 'files') {
      const found = files.filter(f => matches(f.path)); total = found.length;
      results = found.slice(0, 100).map(f => `<a class="item" href="${esc(href(f.path))}">${esc(f.path)}<small>${esc(f.module)}</small></a>`);
    } else if (q) {
      for (const f of files.filter(f => !f.external)) f.text.split('\n').forEach((text, i) => {
        if (matches(text)) {total++; if (results.length < 100) results.push(`<a class="item" href="${esc(href(f.path, i + 1))}">${esc(f.path)}:${i + 1}<span class="ref-code">${esc(text.trim())}</span></a>`);}
      });
    }
    $('#search-results').innerHTML = `<div class="result-count">${total.toLocaleString()} results${total > 100 ? ' · showing first 100; refine your search' : ''}</div>` + results.join('') + (!total ? `<p class="hint">${mode === 'text' && !q ? 'Enter source text to search the repository.' : 'No matches. Try a shorter query or another scope.'}</p>` : '');
  }
  function openSearch() {$('#search-dialog').showModal(); search(); $('#search-input').focus();}
  function toast(text) {$('#toast').textContent = text; $('#toast').style.display = 'block'; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').style.display = 'none', 2500);}
  document.addEventListener('click', e => {
    if (e.target.closest('#retry-source')) {renderRoute(false); return;}
    const a = e.target.closest('a[href^="#"]');
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0 || a.classList.contains('skip')) return;
    e.preventDefault();
    const targets = a.dataset.targets ? JSON.parse(a.dataset.targets) : [];
    if (targets.length > 1) {$('#choices').innerHTML = targets.map(id => link(id, `<small>${esc(D.symbols[id].file)}</small>`)).join(''); $('#choose-dialog').showModal(); return;}
    $$('dialog[open]').forEach(d => d.close());
    navigate(a.getAttribute('href') === '#' ? href('DY/Trace/Basic.lean') : a.getAttribute('href'));
  });
  $('#inspect-content').addEventListener('click', e => {
    const button = e.target.closest('[data-node]'); if (!button || button.disabled) return;
    const li = button.closest('li');
    if (button.getAttribute('aria-expanded') === 'true') {li.querySelector(':scope > .tree')?.remove(); button.setAttribute('aria-expanded', 'false'); button.textContent = '▸';}
    else {li.insertAdjacentHTML('beforeend', treeRows(D.symbols[button.dataset.node][tab], [...JSON.parse(button.dataset.ancestors), button.dataset.node])); button.setAttribute('aria-expanded', 'true'); button.textContent = '▾';}
  });
  $$('.inspect-tabs button').forEach(b => b.addEventListener('click', () => {tab = b.dataset.tab; renderInspector();}));
  $('.inspect-tabs').addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault(); const buttons = $$('.inspect-tabs button'); let i = buttons.indexOf(document.activeElement);
    i = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length;
    buttons[i].click(); buttons[i].focus();
  });
  $$('.mobile-nav button').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  $('#inspect-current').addEventListener('click', () => {setView('inspect'); if (matchMedia('(min-width:851px)').matches) $('.inspect-tabs button[aria-selected=true]').focus();});
  $('#file-filter').addEventListener('input', renderFiles);
  $('#search-open').addEventListener('click', openSearch);
  $('#help-open').addEventListener('click', () => $('#help-dialog').showModal());
  $$('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
  $('#search-input').addEventListener('input', () => {clearTimeout(searchTimer); searchTimer = setTimeout(search, 100);});
  $$('.search-modes button').forEach(b => b.addEventListener('click', () => {mode = b.dataset.mode; $$('.search-modes button').forEach(x => x.setAttribute('aria-pressed', x === b)); search(); $('#search-input').focus();}));
  $('#search-input').addEventListener('keydown', e => {if (e.key === 'ArrowDown') {e.preventDefault(); $('#search-results a')?.focus();} if (e.key === 'Enter') $('#search-results a')?.click();});
  $('#back').addEventListener('click', () => {savePosition(); history.back();});
  $('#forward').addEventListener('click', () => {savePosition(); history.forward();});
  window.addEventListener('popstate', () => renderRoute(true));
  // Save continuously so native browser back/forward gestures also restore scroll.
  let scrollTimer;
  $('#code').addEventListener('scroll', () => {clearTimeout(scrollTimer); scrollTimer = setTimeout(savePosition, 80);}, {passive:true});
  $('#wrap').addEventListener('click', () => {const wrap = $('#code').classList.toggle('wrap'); $('#wrap').setAttribute('aria-pressed', wrap); try {localStorage.setItem('dylean-wrap', String(wrap));} catch {}});
  try {if (localStorage.getItem('dylean-wrap') === 'false') {$('#code').classList.remove('wrap'); $('#wrap').setAttribute('aria-pressed', 'false');}} catch {}
  $('#copy-link').addEventListener('click', async () => {
    try {await navigator.clipboard.writeText(location.href); toast('Link copied');}
    catch {window.prompt('Copy this link:', location.href);}
  });
  document.addEventListener('keydown', e => {
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.target.matches('input,textarea,[contenteditable]') && !$('dialog[open]')) {e.preventDefault(); openSearch();}
  });
  $('#file-count').textContent = D.meta.files + ' + library';
  $('#repo-info').textContent = `${D.meta.symbols.toLocaleString()} symbols · ${D.meta.references.toLocaleString()} references · ${D.meta.revision || 'working tree'}`;
  if (!location.hash) updateHistory({dyIndex: 0}, href('DY/Trace/Basic.lean'), true);
  renderRoute(true);
})();
