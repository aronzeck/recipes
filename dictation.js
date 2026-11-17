// Voice dictation using the browser's built-in speech recognition
// (Safari on iPhone/iPad, Chrome on Android/desktop).
//
// Say "next step", "next ingredient", "next line" or "new line" to start a new line.
const Dictation = (() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let active = null; // { rec, field, button, base, onDone }

  const supported = !!SR;

  // Turn spoken commands into punctuation / line breaks.
  function process(text) {
    return text
      .replace(/\s*\b(next step|next ingredient|next item|next line|new line|newline)\b[.,]?\s*/gi, '\n')
      .replace(/\s*\bcomma\b\s*/gi, ', ')
      .replace(/\s*\bperiod\b\s*/gi, '. ')
      .replace(/\n{2,}/g, '\n')
      .replace(/^\n+/, '');
  }

  function capitalizeLines(text) {
    return text.split('\n').map(l => {
      const t = l.trim();
      return t ? t[0].toUpperCase() + t.slice(1) : t;
    }).join('\n');
  }

  function stop() {
    if (!active) return;
    const a = active;
    active = null;
    try { a.rec.stop(); } catch (_) {}
    finish(a);
  }

  function finish(a) {
    a.button.classList.remove('listening');
    a.button.setAttribute('aria-pressed', 'false');
    a.field.value = capitalizeLines(a.field.value).replace(/[ \t]+\n/g, '\n').trimEnd();
    a.field.dispatchEvent(new Event('input', { bubbles: true }));
    if (a.onDone) a.onDone(a.field, a.usedNext);
  }

  function start(field, button, onDone) {
    if (active) {
      const same = active.field === field;
      stop();
      if (same) return;
    }
    if (!supported) {
      field.focus();
      showToast('Tap the 🎤 on your keyboard to dictate.');
      return;
    }
    const rec = new SR();
    rec.lang = navigator.language || 'en-US';
    rec.continuous = true;
    rec.interimResults = true;

    const base = field.value.trimEnd();
    const sep = base && !base.endsWith('\n') ? (field.dataset.multiline === 'true' ? '\n' : ' ') : '';
    const state = { rec, field, button, base: base + sep, onDone, usedNext: false };
    active = state;

    rec.onresult = e => {
      let finalText = '', interim = '';
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript + ' ';
        else interim += r[0].transcript;
      }
      const raw = (finalText + interim).trim();
      if (/\b(next (step|ingredient|item|line)|new ?line)\b/i.test(raw)) state.usedNext = true;
      let processed = process(raw);
      if (field.dataset.multiline !== 'true') processed = processed.replace(/\n/g, ' ');
      field.value = state.base + processed;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    };
    rec.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        showToast('Microphone access was blocked. Check Settings › Safari › Microphone, or use the keyboard 🎤.');
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        showToast('Dictation error: ' + e.error);
      }
    };
    rec.onend = () => { if (active === state) { active = null; finish(state); } };

    try {
      rec.start();
      button.classList.add('listening');
      button.setAttribute('aria-pressed', 'true');
    } catch (err) {
      active = null;
      showToast('Could not start dictation. Use the keyboard 🎤 instead.');
    }
  }

  return { supported, start, stop, isActive: () => !!active };
})();
