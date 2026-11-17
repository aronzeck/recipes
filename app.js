// My Recipes — a small offline-first recipe book.
const $app = document.getElementById('app');
const $title = document.getElementById('pageTitle');
const $back = document.getElementById('backBtn');
const $actions = document.getElementById('topActions');

let objectUrls = [];
let wakeLock = null;
let searchTerm = '';
let activeTag = '';

// ---------- helpers ----------
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const h = html => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content; };

function showToast(msg, ms = 3200) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function trackUrl(blob) {
  const u = URL.createObjectURL(blob);
  objectUrls.push(u);
  return u;
}
function releaseUrls() {
  objectUrls.forEach(u => URL.revokeObjectURL(u));
  objectUrls = [];
}

function setHeader(title, { back = false, actions = [] } = {}) {
  $title.textContent = title;
  document.title = title === 'My Recipes' ? title : `${title} · My Recipes`;
  $back.hidden = !back;
  $actions.innerHTML = '';
  actions.forEach(a => {
    const b = document.createElement('button');
    b.className = a.primary ? 'btn primary small' : 'icon-btn';
    b.textContent = a.label;
    if (a.aria) b.setAttribute('aria-label', a.aria);
    b.onclick = a.onClick;
    $actions.appendChild(b);
  });
}

let leaveGuard = null; // returns true if it's OK to leave the current screen
$back.onclick = () => {
  if (leaveGuard && !leaveGuard()) return;
  Dictation.stop();
  if (history.length > 1) history.back(); else location.hash = '';
};

// Resize photos so they don't fill up the device. Videos are stored as-is.
async function prepareFile(file) {
  if (file.type.startsWith('image/') && file.type !== 'image/gif') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const max = 1600;
      const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
      if (blob) return { id: uid(), blob, type: 'image/jpeg' };
    } catch (_) { /* fall through and keep the original */ }
  }
  if (file.type.startsWith('video/') && file.size > 150 * 1024 * 1024) {
    showToast('That video is large (' + Math.round(file.size / 1048576) + ' MB). Shorter clips save space.', 5000);
  }
  return { id: uid(), blob: file, type: file.type || 'application/octet-stream' };
}

function mediaEl(m, { controls = true } = {}) {
  const url = trackUrl(m.blob);
  if (m.type.startsWith('video/')) {
    return `<video src="${url}#t=0.1" ${controls ? 'controls' : 'muted'} playsinline preload="metadata"></video>`;
  }
  return `<img src="${url}" alt="" loading="lazy">`;
}

async function loadMediaMap(ids) {
  const map = {};
  await Promise.all(ids.map(async id => { const m = await DB.getMedia(id); if (m) map[id] = m; }));
  return map;
}

function fmtTime(min) {
  if (!min) return '';
  const n = Number(min);
  if (!n) return String(min);
  return n >= 60 ? `${Math.floor(n / 60)} h${n % 60 ? ' ' + (n % 60) + ' min' : ''}` : `${n} min`;
}

// ---------- router ----------
async function route() {
  Dictation.stop();
  leaveGuard = null;
  releaseUrls();
  releaseWakeLock();
  const [view, id] = location.hash.replace(/^#\/?/, '').split('/');
  window.scrollTo(0, 0);
  try {
    if (view === 'new') return renderEdit(null);
    if (view === 'edit' && id) return renderEdit(id);
    if (view === 'recipe' && id) return renderDetail(id);
    if (view === 'settings') return renderSettings();
    return renderList();
  } catch (err) {
    console.error(err);
    $app.innerHTML = `<p class="empty">Something went wrong: ${esc(err.message)}</p>`;
  }
}
window.addEventListener('hashchange', route);

// ---------- list ----------
async function renderList() {
  setHeader('My Recipes', {
    actions: [
      { label: '⚙︎', aria: 'Settings & backup', onClick: () => (location.hash = '#/settings') },
      { label: '+ New', primary: true, onClick: () => (location.hash = '#/new') },
    ],
  });
  const recipes = (await DB.allRecipes()).sort((a, b) => (b.updated || 0) - (a.updated || 0));
  const tags = [...new Set(recipes.flatMap(r => r.tags || []))].sort((a, b) => a.localeCompare(b));

  $app.innerHTML = '';
  if (!recipes.length) {
    $app.appendChild(h(`
      <div class="empty">
        <div class="empty-icon">🍳</div>
        <h2>No recipes yet</h2>
        <p>Tap <b>+ New</b> to add your first one. You can type or use the 🎤 to dictate ingredients and steps.</p>
        <a class="btn primary" href="#/new">Add a recipe</a>
      </div>`));
    return;
  }

  const frag = h(`
    <div class="search-row">
      <input type="search" id="search" placeholder="Search recipes or ingredients" value="${esc(searchTerm)}" autocomplete="off">
    </div>
    ${tags.length ? `<div class="chips" id="tags">
      <button class="chip ${activeTag ? '' : 'active'}" data-tag="">All</button>
      ${tags.map(t => `<button class="chip ${t === activeTag ? 'active' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}
    </div>` : ''}
    <div class="grid" id="grid"></div>`);
  $app.appendChild(frag);

  const covers = await loadMediaMap(recipes.map(coverId).filter(Boolean));
  const grid = document.getElementById('grid');

  function draw() {
    const q = searchTerm.trim().toLowerCase();
    const list = recipes.filter(r => {
      if (activeTag && !(r.tags || []).includes(activeTag)) return false;
      if (!q) return true;
      return [r.title, ...(r.ingredients || []), ...(r.tags || []), r.notes].join(' ').toLowerCase().includes(q);
    });
    grid.innerHTML = list.length ? list.map(r => {
      const c = covers[coverId(r)];
      const meta = [fmtTime(r.time), r.servings ? `Serves ${r.servings}` : ''].filter(Boolean).join(' · ');
      return `<a class="card" href="#/recipe/${r.id}">
        <div class="card-media">${c ? mediaEl(c, { controls: false }) : '<span class="placeholder">🍽️</span>'}</div>
        <div class="card-body"><h3>${esc(r.title || 'Untitled')}</h3>${meta ? `<p>${esc(meta)}</p>` : ''}</div>
      </a>`;
    }).join('') : '<p class="empty small">No matching recipes.</p>';
  }
  draw();

  document.getElementById('search').addEventListener('input', e => { searchTerm = e.target.value; draw(); });
  const tagRow = document.getElementById('tags');
  if (tagRow) tagRow.addEventListener('click', e => {
    const b = e.target.closest('.chip');
    if (!b) return;
    activeTag = b.dataset.tag;
    tagRow.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === b));
    draw();
  });
}

function coverId(r) {
  return r.cover || (r.media || [])[0] || (r.steps || []).flatMap(s => s.media || []).slice(-1)[0];
}

// ---------- detail ----------
async function renderDetail(id) {
  const r = await DB.getRecipe(id);
  if (!r) { location.hash = ''; return; }
  setHeader(r.title || 'Untitled', {
    back: true,
    actions: [
      { label: '⤴︎', aria: 'Share', onClick: () => shareRecipe(r) },
      { label: 'Edit', primary: true, onClick: () => (location.hash = `#/edit/${r.id}`) },
    ],
  });
  const media = await loadMediaMap(mediaIdsOf(r));
  const finished = (r.media || []).map(m => media[m]).filter(Boolean);
  const meta = [
    r.time ? `⏱ ${fmtTime(r.time)}` : '',
    r.servings ? `🍽 Serves ${esc(r.servings)}` : '',
  ].filter(Boolean);

  $app.innerHTML = '';
  $app.appendChild(h(`
    <article class="detail">
      ${finished.length ? `<div class="hero ${finished.length > 1 ? 'scroller' : ''}">${finished.map(m => `<figure>${mediaEl(m)}</figure>`).join('')}</div>` : ''}
      <h2 class="detail-title">${esc(r.title || 'Untitled')}</h2>
      ${meta.length ? `<p class="meta">${meta.join('<span class="dot">·</span>')}</p>` : ''}
      ${(r.tags || []).length ? `<div class="chips static">${r.tags.map(t => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}

      <label class="cook-toggle"><input type="checkbox" id="cookMode"> <span>Cook mode <small>(keep screen awake)</small></span></label>

      <div class="detail-cols">
        <section class="ingredients">
          <h3>Ingredients</h3>
          ${(r.ingredients || []).length ? `<ul class="checklist">${r.ingredients.map((ing, i) => `
            <li><label><input type="checkbox" data-i="${i}"><span>${esc(ing)}</span></label></li>`).join('')}</ul>`
            : '<p class="muted">No ingredients listed.</p>'}
        </section>

        <section class="steps">
          <h3>Steps</h3>
          ${(r.steps || []).length ? `<ol class="step-list">${r.steps.map((s, i) => `
            <li class="step" data-i="${i}">
              <div class="step-num">${i + 1}</div>
              <div class="step-body">
                <p>${esc(s.text).replace(/\n/g, '<br>')}</p>
                ${(s.media || []).length ? `<div class="step-media">${s.media.map(mid => media[mid] ? `<figure>${mediaEl(media[mid])}</figure>` : '').join('')}</div>` : ''}
              </div>
            </li>`).join('')}</ol>` : '<p class="muted">No steps yet.</p>'}
        </section>
      </div>

      ${r.notes ? `<section class="notes"><h3>Notes</h3><p>${esc(r.notes).replace(/\n/g, '<br>')}</p></section>` : ''}
      <p class="muted small">Last updated ${new Date(r.updated || r.created).toLocaleDateString()}</p>
    </article>`));

  // tap a step to mark it done
  $app.querySelectorAll('.step').forEach(el => el.addEventListener('click', e => {
    if (e.target.closest('video, img')) return;
    el.classList.toggle('done');
  }));
  // tap a photo to view full screen
  $app.querySelectorAll('.detail img').forEach(img => img.addEventListener('click', () => openLightbox(img.src)));

  document.getElementById('cookMode').addEventListener('change', async e => {
    if (e.target.checked) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        showToast('Screen will stay on while this recipe is open.');
      } catch (_) {
        e.target.checked = false;
        showToast('Keep-awake isn\'t supported on this device/browser.');
      }
    } else releaseWakeLock();
  });
}

function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
document.addEventListener('visibilitychange', async () => {
  const cb = document.getElementById('cookMode');
  if (document.visibilityState === 'visible' && cb && cb.checked) {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
  }
});

function openLightbox(src) {
  const lb = h(`<div class="lightbox" role="dialog" aria-label="Photo"><img src="${src}" alt=""></div>`).firstElementChild;
  lb.onclick = () => lb.remove();
  document.body.appendChild(lb);
}

function recipeAsText(r) {
  const lines = [r.title || 'Untitled', ''];
  const meta = [r.time ? `Time: ${fmtTime(r.time)}` : '', r.servings ? `Serves: ${r.servings}` : ''].filter(Boolean);
  if (meta.length) lines.push(meta.join('  |  '), '');
  if ((r.ingredients || []).length) lines.push('INGREDIENTS', ...r.ingredients.map(i => `• ${i}`), '');
  if ((r.steps || []).length) lines.push('STEPS', ...r.steps.map((s, i) => `${i + 1}. ${s.text}`), '');
  if (r.notes) lines.push('NOTES', r.notes);
  return lines.join('\n').trim();
}

async function shareRecipe(r) {
  const text = recipeAsText(r);
  if (navigator.share) {
    try { await navigator.share({ title: r.title, text }); } catch (_) {}
  } else {
    try { await navigator.clipboard.writeText(text); showToast('Recipe copied to clipboard.'); }
    catch (_) { showToast('Sharing not supported here.'); }
  }
}

// ---------- edit ----------
async function renderEdit(id) {
  const existing = id ? await DB.getRecipe(id) : null;
  if (id && !existing) { location.hash = ''; return; }

  // Working copy. Media entries carry their blob so we can preview before saving.
  const originalIds = existing ? mediaIdsOf(existing) : [];
  const mediaStore = await loadMediaMap(originalIds);
  const newMedia = {};
  const draft = {
    id: existing?.id || uid(),
    title: existing?.title || '',
    time: existing?.time || '',
    servings: existing?.servings || '',
    tags: (existing?.tags || []).join(', '),
    ingredients: (existing?.ingredients || []).join('\n'),
    notes: existing?.notes || '',
    steps: (existing?.steps || []).map(s => ({ key: uid(), text: s.text, media: [...(s.media || [])] })),
    media: [...(existing?.media || [])],
    created: existing?.created || Date.now(),
  };
  if (!draft.steps.length) draft.steps.push({ key: uid(), text: '', media: [] });

  let dirty = false;
  const getMedia = mid => newMedia[mid] || mediaStore[mid];

  setHeader(existing ? 'Edit recipe' : 'New recipe', {
    back: true,
    actions: [{ label: 'Save', primary: true, onClick: save }],
  });

  const mic = (target, label) => `<button type="button" class="mic" data-target="${target}" aria-label="Dictate ${label}" aria-pressed="false">🎤</button>`;

  $app.innerHTML = '';
  $app.appendChild(h(`
    <form class="editor" id="editor" autocomplete="off">
      ${!Dictation.supported ? `<p class="hint">Tip: tap the 🎤 on your keyboard to dictate into any field.</p>` : ''}
      <div class="field">
        <label for="f-title">Recipe name</label>
        <div class="with-mic">
          <input id="f-title" name="title" value="${esc(draft.title)}" placeholder="e.g. Sunday roast chicken" required>
          ${mic('f-title', 'recipe name')}
        </div>
      </div>

      <div class="row">
        <div class="field"><label for="f-time">Time (minutes)</label><input id="f-time" name="time" inputmode="numeric" value="${esc(draft.time)}" placeholder="45"></div>
        <div class="field"><label for="f-servings">Serves</label><input id="f-servings" name="servings" inputmode="numeric" value="${esc(draft.servings)}" placeholder="4"></div>
      </div>

      <div class="field">
        <label for="f-tags">Tags <small>(comma separated)</small></label>
        <input id="f-tags" name="tags" value="${esc(draft.tags)}" placeholder="dinner, chicken, weeknight">
      </div>

      <div class="field">
        <div class="label-row">
          <label for="f-ingredients">Ingredients <small>(one per line)</small></label>
          ${mic('f-ingredients', 'ingredients')}
        </div>
        <textarea id="f-ingredients" name="ingredients" data-multiline="true" rows="6" placeholder="2 chicken thighs&#10;1 lemon&#10;3 cloves garlic">${esc(draft.ingredients)}</textarea>
        ${Dictation.supported ? `<p class="hint">🎤 Say <b>“next ingredient”</b> or <b>“new line”</b> between items.</p>` : ''}
      </div>

      <div class="field">
        <div class="label-row"><label>Steps</label></div>
        ${Dictation.supported ? `<p class="hint">🎤 Say <b>“next step”</b> while dictating to start a new step automatically.</p>` : ''}
        <ol class="step-editor" id="stepEditor"></ol>
        <button type="button" class="btn ghost" id="addStep">+ Add step</button>
      </div>

      <div class="field">
        <label>Finished dish <small>(photos / videos, optional)</small></label>
        <div class="media-strip" id="finishedMedia"></div>
        <label class="btn ghost file-btn">📷 Add photo / video
          <input type="file" accept="image/*,video/*" multiple id="finishedInput" hidden>
        </label>
      </div>

      <div class="field">
        <div class="label-row">
          <label for="f-notes">Notes</label>
          ${mic('f-notes', 'notes')}
        </div>
        <textarea id="f-notes" name="notes" data-multiline="true" rows="3" placeholder="Variations, what worked, what to try next time…">${esc(draft.notes)}</textarea>
      </div>

      <div class="form-actions">
        <button type="submit" class="btn primary wide">Save recipe</button>
        ${existing ? `<button type="button" class="btn danger wide" id="deleteBtn">Delete recipe</button>` : ''}
      </div>
    </form>`));

  const form = document.getElementById('editor');
  const stepEditor = document.getElementById('stepEditor');

  form.addEventListener('input', () => { dirty = true; });
  form.addEventListener('submit', e => { e.preventDefault(); save(); });

  // mic buttons for static fields
  form.querySelectorAll('.mic[data-target]').forEach(b => b.addEventListener('click', () => {
    Dictation.start(document.getElementById(b.dataset.target), b);
  }));

  // ---- media strips ----
  function mediaThumbs(ids, onRemove) {
    return ids.map(mid => {
      const m = getMedia(mid);
      if (!m) return '';
      return `<div class="thumb">${mediaEl(m, { controls: false })}${m.type.startsWith('video/') ? '<span class="badge">▶</span>' : ''}
        <button type="button" class="remove" data-mid="${mid}" aria-label="Remove">✕</button></div>`;
    }).join('');
  }

  async function addFiles(files, list) {
    if (!files.length) return;
    showToast('Adding ' + files.length + (files.length > 1 ? ' files…' : ' file…'), 1500);
    for (const f of files) {
      const m = await prepareFile(f);
      newMedia[m.id] = m;
      list.push(m.id);
    }
    dirty = true;
  }

  function drawFinished() {
    const box = document.getElementById('finishedMedia');
    box.innerHTML = mediaThumbs(draft.media);
    box.querySelectorAll('.remove').forEach(b => b.onclick = () => {
      draft.media = draft.media.filter(x => x !== b.dataset.mid); dirty = true; drawFinished();
    });
  }
  document.getElementById('finishedInput').addEventListener('change', async e => {
    await addFiles([...e.target.files], draft.media);
    e.target.value = '';
    drawFinished();
  });

  // ---- steps ----
  function syncStepText() {
    stepEditor.querySelectorAll('textarea').forEach(t => {
      const s = draft.steps.find(x => x.key === t.dataset.key);
      if (s) s.text = t.value;
    });
  }

  function drawSteps(focusKey) {
    Dictation.stop();
    stepEditor.innerHTML = draft.steps.map((s, i) => `
      <li class="step-card" data-key="${s.key}">
        <div class="step-head">
          <span class="step-num">${i + 1}</span>
          <div class="step-tools">
            <button type="button" class="icon-btn sm" data-act="up" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
            <button type="button" class="icon-btn sm" data-act="down" ${i === draft.steps.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
            <button type="button" class="icon-btn sm" data-act="del" aria-label="Delete step">🗑</button>
          </div>
        </div>
        <div class="with-mic top">
          <textarea data-key="${s.key}" data-multiline="true" rows="3" placeholder="Describe this step…">${esc(s.text)}</textarea>
          <button type="button" class="mic" data-act="mic" aria-label="Dictate step ${i + 1}" aria-pressed="false">🎤</button>
        </div>
        <div class="media-strip">${mediaThumbs(s.media)}</div>
        <label class="btn ghost small file-btn">📷 Photo / video
          <input type="file" accept="image/*,video/*" multiple hidden>
        </label>
      </li>`).join('');

    stepEditor.querySelectorAll('.step-card').forEach(card => {
      const key = card.dataset.key;
      const step = draft.steps.find(s => s.key === key);
      const idx = () => draft.steps.indexOf(step);
      card.querySelector('[data-act="up"]').onclick = () => { syncStepText(); const i = idx(); [draft.steps[i - 1], draft.steps[i]] = [draft.steps[i], draft.steps[i - 1]]; dirty = true; drawSteps(); };
      card.querySelector('[data-act="down"]').onclick = () => { syncStepText(); const i = idx(); [draft.steps[i + 1], draft.steps[i]] = [draft.steps[i], draft.steps[i + 1]]; dirty = true; drawSteps(); };
      card.querySelector('[data-act="del"]').onclick = () => {
        syncStepText();
        if ((step.text.trim() || step.media.length) && !confirm('Delete this step?')) return;
        draft.steps.splice(idx(), 1);
        if (!draft.steps.length) draft.steps.push({ key: uid(), text: '', media: [] });
        dirty = true; drawSteps();
      };
      const ta = card.querySelector('textarea');
      ta.addEventListener('input', () => { step.text = ta.value; });
      card.querySelector('[data-act="mic"]').onclick = e => Dictation.start(ta, e.currentTarget, splitDictatedStep);
      card.querySelector('input[type="file"]').addEventListener('change', async e => {
        syncStepText();
        await addFiles([...e.target.files], step.media);
        drawSteps();
      });
      card.querySelectorAll('.remove').forEach(b => b.onclick = () => {
        syncStepText();
        step.media = step.media.filter(x => x !== b.dataset.mid); dirty = true; drawSteps();
      });
    });
    if (focusKey) {
      const t = stepEditor.querySelector(`textarea[data-key="${focusKey}"]`);
      if (t) { t.focus(); t.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    }
  }

  // After dictating "... next step ..." split the text into separate steps.
  function splitDictatedStep(ta, usedNext) {
    syncStepText();
    if (!usedNext) return;
    const step = draft.steps.find(s => s.key === ta.dataset.key);
    if (!step) return;
    const parts = step.text.split('\n').map(p => p.trim()).filter(Boolean);
    if (parts.length < 2) return;
    step.text = parts[0];
    const extra = parts.slice(1).map(text => ({ key: uid(), text, media: [] }));
    draft.steps.splice(draft.steps.indexOf(step) + 1, 0, ...extra);
    drawSteps(extra[extra.length - 1].key);
    showToast(`Split into ${parts.length} steps.`);
  }

  document.getElementById('addStep').onclick = () => {
    syncStepText();
    const s = { key: uid(), text: '', media: [] };
    draft.steps.push(s);
    drawSteps(s.key);
  };

  const del = document.getElementById('deleteBtn');
  if (del) del.onclick = async () => {
    if (!confirm(`Delete “${existing.title}”? This can't be undone.`)) return;
    await DB.deleteRecipe(existing);
    dirty = false;
    showToast('Recipe deleted.');
    location.replace('#/');
  };

  drawSteps();
  drawFinished();

  // warn before leaving with unsaved changes
  const guard = e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', guard);
  window.addEventListener('hashchange', () => window.removeEventListener('beforeunload', guard), { once: true });
  leaveGuard = () => !dirty || confirm('Discard unsaved changes?');

  async function save() {
    Dictation.stop();
    syncStepText();
    const fd = new FormData(form);
    const title = String(fd.get('title') || '').trim();
    if (!title) { showToast('Give your recipe a name.'); document.getElementById('f-title').focus(); return; }

    const steps = draft.steps
      .map(s => ({ text: s.text.trim(), media: s.media }))
      .filter(s => s.text || s.media.length);

    const recipe = {
      id: draft.id,
      title,
      time: String(fd.get('time') || '').trim(),
      servings: String(fd.get('servings') || '').trim(),
      tags: String(fd.get('tags') || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean),
      ingredients: String(fd.get('ingredients') || '').split('\n').map(l => l.replace(/^[-•*]\s*/, '').trim()).filter(Boolean),
      steps,
      media: draft.media,
      notes: String(fd.get('notes') || '').trim(),
      created: draft.created,
      updated: Date.now(),
    };

    const used = new Set(mediaIdsOf(recipe));
    const toAdd = Object.values(newMedia).filter(m => used.has(m.id));
    const toDelete = originalIds.filter(mid => !used.has(mid));

    try {
      await DB.saveRecipe(recipe, toAdd, toDelete);
      dirty = false;
      showToast('Saved ✓');
      location.replace(`#/recipe/${recipe.id}`);
    } catch (err) {
      console.error(err);
      showToast('Could not save: ' + (err.message || err) + '. The device may be out of storage.', 6000);
    }
  }
}

// ---------- settings / backup ----------
async function renderSettings() {
  setHeader('Settings & backup', { back: true });
  const recipes = await DB.allRecipes();
  let usage = '';
  if (navigator.storage?.estimate) {
    const { usage: u = 0 } = await navigator.storage.estimate();
    usage = `${(u / 1048576).toFixed(1)} MB used`;
  }
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;

  $app.innerHTML = '';
  $app.appendChild(h(`
    <div class="settings">
      <section class="panel">
        <h3>Your data</h3>
        <p>${recipes.length} recipe${recipes.length === 1 ? '' : 's'}${usage ? ' · ' + usage : ''}</p>
        <p class="muted small">Recipes, photos and videos are saved <b>only on this device</b>, inside this browser/app.
        ${persisted ? 'Storage is marked as persistent.' : ''}</p>
      </section>

      <section class="panel">
        <h3>Back up / move to another device</h3>
        <p class="muted small">Export everything into one file (save it to iCloud Drive / Files), then import it on your iPad or phone. Importing merges — recipes with the same ID are replaced with the imported copy.</p>
        <label class="check"><input type="checkbox" id="includeMedia" checked> Include photos &amp; videos</label>
        <div class="btn-row">
          <button class="btn primary" id="exportBtn">Export backup</button>
          <label class="btn ghost file-btn">Import backup<input type="file" id="importInput" accept=".json,application/json" hidden></label>
        </div>
      </section>

      <section class="panel">
        <h3>Install on iPhone / iPad</h3>
        <ol class="muted small">
          <li>Open this page in <b>Safari</b>.</li>
          <li>Tap the <b>Share</b> button, then <b>Add to Home Screen</b>.</li>
          <li>Open “Recipes” from your home screen — it works offline.</li>
        </ol>
        <p class="muted small">Note: the copy on your home screen keeps its own storage, separate from Safari's. Pick one and stick with it on each device.</p>
      </section>

      <section class="panel">
        <h3>Dictation</h3>
        <p class="muted small">${Dictation.supported
          ? 'In-app 🎤 dictation is available. Say “next ingredient”, “next step” or “new line” to split items.'
          : 'In-app dictation isn\'t available in this browser — use the 🎤 on your keyboard instead.'}
        You can always use the keyboard 🎤 on iPhone/iPad as well.</p>
      </section>
    </div>`));

  document.getElementById('exportBtn').onclick = () => exportBackup(document.getElementById('includeMedia').checked);
  document.getElementById('importInput').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) await importBackup(f);
  });
}

const blobToDataUrl = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
const dataUrlToBlob = async url => (await fetch(url)).blob();

async function exportBackup(includeMedia) {
  showToast('Preparing backup…');
  const recipes = await DB.allRecipes();
  const media = [];
  if (includeMedia) {
    for (const m of await DB.allMedia()) media.push({ id: m.id, type: m.type, data: await blobToDataUrl(m.blob) });
  }
  const payload = { app: 'my-recipes', version: 1, exported: new Date().toISOString(), recipes, media };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const name = `recipes-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([blob], name, { type: 'application/json' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Recipes backup' }); return; } catch (err) { if (err.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'my-recipes' || !Array.isArray(data.recipes)) throw new Error('Not a recipes backup file');
    showToast('Importing…');
    const media = [];
    for (const m of data.media || []) media.push({ id: m.id, type: m.type, blob: await dataUrlToBlob(m.data) });
    if (media.length) await DB.putMedia(media);
    await DB.putRecipes(data.recipes);
    showToast(`Imported ${data.recipes.length} recipe${data.recipes.length === 1 ? '' : 's'}.`);
    renderSettings();
  } catch (err) {
    showToast('Import failed: ' + err.message, 5000);
  }
}

// ---------- boot ----------
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
route();
