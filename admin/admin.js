/* Caribbean Dawah Association - site admin.
   Runs on Netlify: signs in with the admin password and saves through the site's
   own Netlify Functions (/api/*). Photos are stored with Netlify Blobs (/media/*). */
(function () {
  'use strict';

  var MAX_W = 1600;          // photos are resized to this width before upload
  var QUALITY = 0.82;
  var MAX_UPLOAD = 4 * 1024 * 1024;   // Netlify functions accept ~4.5 MB uploads
  var API = '../api/';

  /* ------------------------------------------------------------------ *
   * Small DOM helpers (no innerHTML with content: everything is built
   * with createElement/textContent so admin data can never inject HTML)
   * ------------------------------------------------------------------ */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
      else if (k in n && typeof v !== 'string') n[k] = v;
      else n.setAttribute(k, v === true ? '' : v);
    });
    (children || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function toast(msg, isError) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('is-error', !!isError);
    t.classList.add('is-visible');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('is-visible'); }, isError ? 7000 : 3200);
  }
  function busy(on, text) {
    $('#busy').hidden = !on;
    if (text) $('#busy-text').textContent = text;
  }
  function slugify(s) {
    return String(s || 'photo').toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'photo';
  }
  function move(arr, i, d) {
    var j = i + d;
    if (j < 0 || j >= arr.length) return;
    var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */
  var original = null;       // content as last loaded/published
  var content = null;        // working copy being edited
  var pending = {};          // path -> { blob, url } photos not yet uploaded
  var shown = {};            // path -> blob URL of photos uploaded in this session
  var activeSection = null;
  var baseVersion = '';      // version we started from (detects someone else publishing meanwhile)
  var publishing = false;

  function isDirty() { return JSON.stringify(original) !== JSON.stringify(content); }
  function markDirty() {
    var d = isDirty();
    $('#dirty-flag').hidden = !d;
    $('#publish-btn').disabled = !d || publishing;
  }
  window.addEventListener('beforeunload', function (e) {
    if (content && isDirty()) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ------------------------------------------------------------------ *
   * Server
   * ------------------------------------------------------------------ */
  function api(path, opts) {
    opts = opts || {};
    var headers = { 'X-CDA-Admin': '1', 'Accept': 'application/json' };
    var body = opts.body;
    if (body && !(body instanceof Blob)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
    if (body instanceof Blob) headers['Content-Type'] = body.type || 'application/octet-stream';
    return fetch(API + path, { method: opts.method || 'GET', headers: headers, body: body, credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) {
        var type = r.headers.get('content-type') || '';
        if (type.indexOf('application/json') === -1) {
          var e0 = new Error('The editor could not reach the website server.'); e0.offline = true; e0.status = r.status; throw e0;
        }
        return r.json().then(function (j) {
          if (!r.ok || !j.ok) { var e = new Error(j.error || ('Server error ' + r.status)); e.status = r.status; throw e; }
          return j;
        });
      });
  }

  /* ------------------------------------------------------------------ *
   * Photos: resize + compress in the browser before upload
   * ------------------------------------------------------------------ */
  function loadBitmap(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () { return loadViaImg(file); });
    }
    return loadViaImg(file);
  }
  function loadViaImg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('"' + file.name + '" could not be read as a photo. Please use JPG, PNG or WebP.')); };
      img.src = url;
    });
  }
  function encode(img, maxW, quality) {
    var scale = Math.min(1, maxW / img.width);
    var cw = Math.round(img.width * scale), ch = Math.round(img.height * scale);
    var canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cw, ch);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, cw, ch);
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error('Could not compress the photo.')); }, 'image/jpeg', quality);
    });
  }
  function processImage(file) {
    if (file.size > 40 * 1024 * 1024) return Promise.reject(new Error('"' + file.name + '" is larger than 40 MB.'));
    return loadBitmap(file).then(function (img) {
      if (!img.width || !img.height) throw new Error('"' + file.name + '" could not be read.');
      return encode(img, MAX_W, QUALITY).then(function (b) {
        return b.size <= MAX_UPLOAD ? b : encode(img, 1200, 0.72);
      }).then(function (b) {
        if (b.size > MAX_UPLOAD) throw new Error('"' + file.name + '" is too detailed to upload. Please try a smaller photo.');
        return b;
      });
    }).then(function (blob) {
      var stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      var path = 'media/' + slugify(file.name) + '-' + stamp + '.jpg';
      pending[path] = { blob: blob, url: URL.createObjectURL(blob) };
      return path;
    });
  }
  function previewSrc(path) {
    if (!path) return '';
    if (pending[path]) return pending[path].url;
    if (shown[path]) return shown[path];
    if (/^https:\/\//i.test(path)) return path;
    return '../' + String(path).replace(/^\/+/, '');
  }
  function pickFiles(multiple) {
    return new Promise(function (resolve) {
      var input = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/heic,image/heif', multiple: !!multiple, style: 'display:none' });
      input.addEventListener('change', function () { resolve(Array.prototype.slice.call(input.files || [])); input.remove(); });
      document.body.appendChild(input);
      input.click();
    });
  }
  function addPhotos(multiple, onEach) {
    return pickFiles(multiple).then(function (files) {
      if (!files.length) return 0;
      var done = 0, failed = [];
      busy(true, 'Preparing ' + files.length + ' photo' + (files.length > 1 ? 's' : '') + '…');
      return files.reduce(function (p, file) {
        return p.then(function () {
          return processImage(file).then(function (path) {
            onEach(path); done++;
            $('#busy-text').textContent = 'Prepared ' + done + ' of ' + files.length + '…';
          }, function (e) { failed.push(e.message); });
        });
      }, Promise.resolve()).then(function () {
        if (failed.length) toast(failed.join(' '), true);
        return done;
      });
    }).catch(function (e) { toast(e.message, true); return 0; }).then(function (n) { busy(false); return n; });
  }

  /* ------------------------------------------------------------------ *
   * Videos: same link rules as the public site
   * ------------------------------------------------------------------ */
  function videoInfo(url) {
    var u;
    try { u = new URL(String(url || '').trim()); } catch (e) { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    var host = u.hostname.replace(/^(www|m|mobile|web)\./, ''), m;
    if (host === 'youtu.be' || host === 'youtube.com' || host === 'youtube-nocookie.com') {
      var id = host === 'youtu.be' ? u.pathname.slice(1) : (u.searchParams.get('v') || ((m = u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{6,})/)) && m[1]));
      return id && /^[\w-]{6,}$/.test(id) ? { site: 'YouTube', thumb: 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg' } : null;
    }
    if (host === 'vimeo.com' && /^\/\d+/.test(u.pathname)) return { site: 'Vimeo' };
    if ((host === 'facebook.com' && /\/(reel|videos|watch|share\/[rv])(\/|$)|[?&]v=\d/.test(u.pathname + u.search)) || host === 'fb.watch') return { site: 'Facebook' };
    if (host === 'instagram.com' && /^\/(p|reel|tv)\/[\w-]+/.test(u.pathname)) return { site: 'Instagram' };
    if (host === 'tiktok.com' && /\/video\/\d+/.test(u.pathname)) return { site: 'TikTok' };
    if (/\.(mp4|webm|mov|m4v)$/i.test(u.pathname)) return { site: 'video file' };
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Editor schema: every editable part of the site
   * ------------------------------------------------------------------ */
  var ICONS = [['chat', 'Speech bubble'], ['question', 'Question mark'], ['book', 'Book'], ['bowl', 'Soup bowl'], ['basket', 'Basket'], ['home', 'House'], ['hands', 'Heart'], ['mosque', 'Masjid']];
  var STATUSES = [['upcoming', 'Upcoming'], ['ongoing', 'Ongoing'], ['planned', 'Planned / future goal'], ['past', 'Completed (shows under "Recent")']];

  var ACCOUNT_FIELDS = [
    { key: 'label', label: 'Account label (shown on the switch)', type: 'text', hint: 'For example "Zakat account" or "General donations & Sadaqah".' },
    { key: 'note', label: 'What this account is for', type: 'textarea', rows: 2 },
    { key: 'bankName', label: 'Bank', type: 'text' },
    { key: 'accountName', label: 'Account name', type: 'text' },
    { key: 'accountNumber', label: 'Account number', type: 'text', important: true },
    { key: 'accountType', label: 'Account type', type: 'text' },
    { key: 'swift', label: 'SWIFT / BIC code', type: 'text', hint: 'Lets people pay by online banking or international wire. Leave empty to hide.' },
    { key: 'currency', label: 'Currency (optional)', type: 'text', hint: 'For example TTD. Leave empty to hide.' }
  ];

  var SECTIONS = [
    {
      key: 'projects', title: 'Projects & events', desc: 'Upcoming events, ongoing projects and recent work. Upcoming items automatically move to "Recent" once their date has passed.',
      type: 'list', itemTitle: function (p) { return (p.title || 'Untitled project') + (p.dateLabel ? '  ·  ' + p.dateLabel : ''); },
      addLabel: 'Add a project or event',
      newItem: function () { return { status: 'upcoming', date: '', dateLabel: '', title: 'New project', location: '', summary: '', image: '', imageAlt: '', ctaLabel: 'Support this project', ctaLink: '#donate' }; },
      fields: [
        { key: 'title', label: 'Title', type: 'text' },
        { key: 'status', label: 'Status', type: 'select', options: STATUSES },
        { key: 'date', label: 'Date (used for ordering, optional)', type: 'date', hint: 'Leave empty for ongoing work.' },
        { key: 'dateLabel', label: 'Date as shown on the site', type: 'text', hint: 'For example "Saturday 14 November, 9am" or "Every week".' },
        { key: 'location', label: 'Location', type: 'text' },
        { key: 'summary', label: 'Description', type: 'textarea', rows: 4 },
        { key: 'image', label: 'Photo or flyer (optional)', type: 'image', altKey: 'imageAlt' },
        { key: 'ctaLabel', label: 'Button text (optional)', type: 'text' },
        { key: 'ctaLink', label: 'Button link', type: 'text', hint: 'Use #donate for the donation section, #gallery for the albums, #contact for contact details, or paste a full web address (https://…).' }
      ]
    },
    { key: 'albums', title: 'Albums (photos & videos)', desc: 'Each album is a folder for one project. Add photos straight from your phone, or paste links to videos you have posted on Facebook, YouTube, Instagram or TikTok.', type: 'albums' },
    {
      key: 'donate', title: 'Donations & bank details', desc: 'These details appear in the "Give" section. Double-check every account number before publishing.',
      type: 'object',
      fields: [
        { key: 'heading', label: 'Heading', type: 'text' },
        { key: 'intro', label: 'Intro text', type: 'textarea' },
        {
          key: 'accounts', label: 'Bank accounts', type: 'list', addLabel: 'Add an account',
          itemTitle: function (a) { return (a.label || 'Account') + (a.accountNumber ? '  ·  …' + String(a.accountNumber).slice(-4) : ''); },
          newItem: function () { return { label: 'New account', note: '', bankName: 'RBC Royal Bank', accountName: 'Caribbean Dawah Association', accountNumber: '', accountType: '', swift: 'RBTTTTPX', currency: '' }; },
          fields: ACCOUNT_FIELDS
        },
        { key: 'funds', label: '"Your gift can support" list', type: 'strings', addLabel: 'Add a line' },
        { key: 'referenceHint', label: 'Step 2: what to write in the transfer note', type: 'textarea', rows: 2 },
        { key: 'afterText', label: 'Step 3: what to do after sending', type: 'textarea', rows: 2 },
        { key: 'internationalText', label: 'Note for donors abroad', type: 'textarea', rows: 2 },
        { key: 'cardNote', label: 'Small note under the list', type: 'text' }
      ]
    },
    {
      key: 'stats', title: 'Impact numbers', desc: 'The four numbers under the main photo. Keep them honest and up to date.',
      type: 'list', itemTitle: function (s) { return (s.value || '?') + '  ' + (s.label || ''); }, addLabel: 'Add a number',
      newItem: function () { return { value: '', label: '' }; },
      fields: [
        { key: 'value', label: 'Number', type: 'text', hint: 'For example 20,000+ or 100%.' },
        { key: 'label', label: 'What it means', type: 'text' }
      ]
    },
    {
      key: 'hero', title: 'Top of page', desc: 'The first thing visitors see.', type: 'object',
      fields: [
        { key: 'eyebrow', label: 'Small label above the headline', type: 'text' },
        { key: 'headline', label: 'Headline', type: 'textarea', rows: 3, hint: 'Put each phrase on its own line. The last line is shown in blue italics.' },
        { key: 'text', label: 'Intro text', type: 'textarea' },
        { key: 'image', label: 'Background photo', type: 'image', altKey: 'imageAlt', required: true, hint: 'A wide, real photo works best.' }
      ]
    },
    {
      key: 'about', title: 'Who we are', type: 'object',
      fields: [
        { key: 'heading', label: 'Heading', type: 'text' },
        { key: 'statement', label: 'Highlighted statement', type: 'textarea', rows: 2 },
        { key: 'paragraphs', label: 'Paragraphs', type: 'strings', multiline: true, addLabel: 'Add a paragraph' },
        { key: 'image', label: 'Photo', type: 'image', altKey: 'imageAlt', hint: 'A tall (portrait) photo works best.' }
      ]
    },
    {
      key: 'programs', title: 'Our work', desc: 'The two columns of activities. Items with the same "Column" are grouped together.',
      type: 'list', itemTitle: function (p) { return (p.title || 'Untitled') + '  ·  ' + (p.pillar || ''); }, addLabel: 'Add an activity',
      newItem: function () { return { pillar: 'Serving our community', icon: 'hands', title: '', text: '' }; },
      fields: [
        { key: 'pillar', label: 'Column', type: 'select', options: [['Sharing Islam', 'Sharing Islam'], ['Serving our community', 'Serving our community']] },
        { key: 'title', label: 'Title', type: 'text' },
        { key: 'icon', label: 'Icon', type: 'select', options: ICONS },
        { key: 'text', label: 'Description', type: 'textarea', rows: 3 }
      ]
    },
    {
      key: 'story', title: 'Featured story', desc: 'The two-photo story section. Use real photos you have permission to share.', type: 'object',
      fields: [
        { key: 'eyebrow', label: 'Small label', type: 'text' },
        { key: 'heading', label: 'Heading', type: 'text' },
        { key: 'text', label: 'Story', type: 'textarea', rows: 5 },
        { key: 'before', label: 'Left photo', type: 'image', altKey: 'beforeAlt' },
        { key: 'beforeLabel', label: 'Left photo label', type: 'text' },
        { key: 'after', label: 'Right photo', type: 'image', altKey: 'afterAlt' },
        { key: 'afterLabel', label: 'Right photo label', type: 'text' },
        { key: 'ctaLabel', label: 'Button text', type: 'text' }
      ]
    },
    {
      key: 'reflection', title: 'Reflection quote', desc: 'One line on a navy band. Change it each week if you like.', type: 'object',
      fields: [
        { key: 'text', label: 'Quote', type: 'textarea', rows: 2 },
        { key: 'source', label: 'Source', type: 'text' }
      ]
    },
    {
      key: 'involved', title: 'Get involved', type: 'list', itemTitle: function (c) { return c.title || 'Untitled'; }, addLabel: 'Add a card',
      newItem: function () { return { icon: 'hands', title: '', text: '', ctaLabel: '', ctaLink: '' }; },
      fields: [
        { key: 'title', label: 'Title', type: 'text' },
        { key: 'icon', label: 'Icon', type: 'select', options: ICONS },
        { key: 'text', label: 'Description', type: 'textarea', rows: 3 },
        { key: 'ctaLabel', label: 'Link text', type: 'text' },
        { key: 'ctaLink', label: 'Link', type: 'text', hint: 'An email link (mailto:…), a phone link (tel:…), a web address, or a section like #donate.' }
      ]
    },
    {
      key: 'contact', title: 'Contact & social links', type: 'object',
      fields: [
        { key: 'phone', label: 'Phone', type: 'text' },
        { key: 'email', label: 'Email', type: 'text' },
        { key: 'address', label: 'Address', type: 'text' },
        { key: 'mapLink', label: 'Google Maps link', type: 'text' },
        { key: 'facebook', label: 'Facebook page', type: 'text' },
        { key: 'instagram', label: 'Instagram', type: 'text' },
        { key: 'youtube', label: 'YouTube (optional)', type: 'text' },
        { key: 'tiktok', label: 'TikTok (optional)', type: 'text' }
      ]
    },
    {
      key: 'meta', title: 'Search engines', desc: 'How the site appears in Google results and link previews.', type: 'object',
      fields: [
        { key: 'title', label: 'Page title', type: 'text' },
        { key: 'description', label: 'Description', type: 'textarea', rows: 3 }
      ]
    },
    { key: 'history', title: 'History & undo', desc: 'Every publish keeps a copy of the previous version. Restore one if something went wrong.', type: 'history' }
  ];

  /* ------------------------------------------------------------------ *
   * Field renderers
   * ------------------------------------------------------------------ */
  function fieldWrap(f, control) {
    var id = 'l-' + Math.random().toString(36).slice(2);
    var wrap = el('div', { class: 'field' + (f.important ? ' is-important' : '') }, [
      el('span', { class: 'field-label', id: id, text: f.label }),
      control,
      f.hint ? el('span', { class: 'hint', text: f.hint }) : null
    ]);
    if (control.matches && control.matches('input,select,textarea')) control.setAttribute('aria-labelledby', id);
    return wrap;
  }

  function renderField(f, obj) {
    if (f.type === 'image') return renderImageField(f, obj);
    if (f.type === 'strings') return renderStrings(f, obj);
    if (f.type === 'list') {
      if (!Array.isArray(obj[f.key])) obj[f.key] = [];
      return fieldWrap(f, renderList(obj[f.key], f, true));
    }
    var control;
    if (f.type === 'textarea') {
      control = el('textarea', { rows: String(f.rows || 3) });
      control.value = obj[f.key] || '';
    } else if (f.type === 'select') {
      control = el('select', null, f.options.map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
      control.value = obj[f.key] || f.options[0][0];
    } else {
      control = el('input', { type: f.type === 'date' ? 'date' : 'text' });
      control.value = obj[f.key] || '';
    }
    control.addEventListener('input', function () { obj[f.key] = control.value; markDirty(); if (f.onChange) f.onChange(); });
    if (f.type === 'select') control.addEventListener('change', function () { obj[f.key] = control.value; markDirty(); if (f.onChange) f.onChange(); });
    return fieldWrap(f, control);
  }

  function imageControl(obj, key, opts) {
    opts = opts || {};
    var box = el('div', { class: 'image-field' });
    function draw() {
      box.textContent = '';
      var src = previewSrc(obj[key]);
      box.appendChild(src ? el('img', { class: 'thumb', src: src, alt: '' }) : el('div', { class: 'thumb thumb-empty', text: 'No photo' }));
      box.appendChild(el('div', { class: 'image-actions' }, [
        el('button', {
          type: 'button', class: 'btn btn-small', text: src ? 'Replace photo' : 'Upload photo',
          onclick: function () {
            addPhotos(false, function (path) { obj[key] = path; }).then(function (n) { if (n) { markDirty(); draw(); if (opts.onChange) opts.onChange(); } });
          }
        }),
        (src && !opts.required) ? el('button', {
          type: 'button', class: 'btn btn-small btn-danger-ghost', text: 'Remove photo',
          onclick: function () { obj[key] = ''; markDirty(); draw(); if (opts.onChange) opts.onChange(); }
        }) : null
      ]));
      if (opts.altKey) {
        var alt = el('input', { type: 'text', placeholder: 'Describe the photo in a few words (helps blind visitors and Google)' });
        alt.value = obj[opts.altKey] || '';
        alt.addEventListener('input', function () { obj[opts.altKey] = alt.value; markDirty(); });
        box.appendChild(el('label', { class: 'alt-field' }, [el('span', { text: 'Photo description' }), alt]));
      }
    }
    draw();
    return box;
  }
  function renderImageField(f, obj) {
    return fieldWrap(f, imageControl(obj, f.key, { altKey: f.altKey, required: f.required }));
  }

  function renderStrings(f, obj) {
    if (!Array.isArray(obj[f.key])) obj[f.key] = [];
    var arr = obj[f.key];
    var box = el('div', { class: 'strings' });
    function draw() {
      box.textContent = '';
      arr.forEach(function (v, i) {
        var input = f.multiline ? el('textarea', { rows: '3' }) : el('input', { type: 'text' });
        input.value = v;
        input.setAttribute('aria-label', f.label + ' ' + (i + 1));
        input.addEventListener('input', function () { arr[i] = input.value; markDirty(); });
        box.appendChild(el('div', { class: 'string-row' }, [
          input,
          el('div', { class: 'row-tools' }, [
            el('button', { type: 'button', class: 'icon-btn', title: 'Move up', 'aria-label': 'Move up', text: '↑', disabled: i === 0, onclick: function () { move(arr, i, -1); markDirty(); draw(); } }),
            el('button', { type: 'button', class: 'icon-btn', title: 'Move down', 'aria-label': 'Move down', text: '↓', disabled: i === arr.length - 1, onclick: function () { move(arr, i, 1); markDirty(); draw(); } }),
            el('button', { type: 'button', class: 'icon-btn danger', title: 'Remove', 'aria-label': 'Remove', text: '✕', onclick: function () { arr.splice(i, 1); markDirty(); draw(); } })
          ])
        ]));
      });
      box.appendChild(el('button', { type: 'button', class: 'btn btn-small btn-ghost', text: '+ ' + (f.addLabel || 'Add'), onclick: function () { arr.push(''); markDirty(); draw(); var all = box.querySelectorAll('input,textarea'); if (all.length) all[all.length - 1].focus(); } }));
    }
    draw();
    return fieldWrap(f, box);
  }

  /* A list of collapsible items (used for top-level sections and for nested lists like bank accounts) */
  function renderList(arr, sec, nested) {
    var wrap = el('div', { class: 'list' + (nested ? ' list-nested' : '') });
    var open = {};
    function draw(focusIndex) {
      wrap.textContent = '';
      wrap.appendChild(el('button', {
        type: 'button', class: 'btn ' + (nested ? 'btn-small btn-ghost' : 'btn-primary') + ' add-btn', text: '+ ' + sec.addLabel,
        onclick: function () {
          var at = nested ? arr.length : 0;
          if (nested) arr.push(sec.newItem()); else arr.unshift(sec.newItem());
          if (!nested) { var shifted = {}; Object.keys(open).forEach(function (k) { shifted[+k + 1] = open[k]; }); open = shifted; }
          open[at] = true;
          markDirty(); draw(at);
        }
      }));
      if (!arr.length) wrap.appendChild(el('p', { class: 'empty', text: 'Nothing here yet.' }));
      arr.forEach(function (item, i) {
        var title = el('span', { class: 'item-title', text: sec.itemTitle(item) });
        var body = el('div', { class: 'item-body' });
        sec.fields.forEach(function (f) {
          body.appendChild(renderField(Object.assign({}, f, { onChange: function () { title.textContent = sec.itemTitle(item); } }), item));
        });
        var badge = item.status ? el('span', { class: 'badge badge-' + item.status, text: (STATUSES.filter(function (s) { return s[0] === item.status; })[0] || [0, item.status])[1].split(' ')[0] }) : null;
        var details = el('details', { class: 'item', open: !!open[i] }, [
          el('summary', null, [
            badge,
            item.image ? el('img', { class: 'mini-thumb', src: previewSrc(item.image), alt: '' }) : null,
            title,
            el('span', { class: 'row-tools' }, [
              el('button', { type: 'button', class: 'icon-btn', title: 'Move up', 'aria-label': 'Move up', text: '↑', disabled: i === 0, onclick: function (e) { e.preventDefault(); swapOpen(i, i - 1); move(arr, i, -1); markDirty(); draw(); } }),
              el('button', { type: 'button', class: 'icon-btn', title: 'Move down', 'aria-label': 'Move down', text: '↓', disabled: i === arr.length - 1, onclick: function (e) { e.preventDefault(); swapOpen(i, i + 1); move(arr, i, 1); markDirty(); draw(); } }),
              el('button', {
                type: 'button', class: 'icon-btn danger', title: 'Delete', 'aria-label': 'Delete', text: '✕',
                onclick: function (e) {
                  e.preventDefault();
                  if (!confirm('Delete "' + sec.itemTitle(item) + '"? It is only removed from the website when you press Publish.')) return;
                  arr.splice(i, 1);
                  var next = {}; Object.keys(open).forEach(function (k) { k = +k; if (k < i) next[k] = open[k]; else if (k > i) next[k - 1] = open[k]; }); open = next;
                  markDirty(); draw();
                }
              })
            ])
          ]),
          body
        ]);
        details.addEventListener('toggle', function () { open[i] = details.open; });
        wrap.appendChild(details);
        if (focusIndex === i) setTimeout(function () { var first = body.querySelector('input,textarea,select'); if (first) first.focus(); details.scrollIntoView({ block: 'nearest' }); }, 30);
      });
    }
    function swapOpen(a, b) { var t = open[a]; open[a] = open[b]; open[b] = t; }
    draw();
    return wrap;
  }

  /* ------------------------------------------------------------------ *
   * Albums editor
   * ------------------------------------------------------------------ */
  function albumTitle(a) {
    var n = (a.items || []).length;
    return (a.title || 'Untitled album') + '  ·  ' + n + ' item' + (n === 1 ? '' : 's');
  }
  function renderAlbumsEditor() {
    if (!Array.isArray(content.albums)) content.albums = [];
    var albums = content.albums;
    var wrap = el('div', { class: 'list' });
    var open = {};
    function draw(focusIndex) {
      wrap.textContent = '';
      wrap.appendChild(el('button', {
        type: 'button', class: 'btn btn-primary add-btn', text: '+ New album',
        onclick: function () {
          albums.unshift({ title: 'New album', subtitle: '', dateLabel: '', description: '', cover: '', items: [] });
          var s = {}; Object.keys(open).forEach(function (k) { s[+k + 1] = open[k]; }); open = s; open[0] = true;
          markDirty(); draw(0);
        }
      }));
      if (!albums.length) wrap.appendChild(el('p', { class: 'empty', text: 'No albums yet.' }));
      albums.forEach(function (album, i) {
        if (!Array.isArray(album.items)) album.items = [];
        var title = el('span', { class: 'item-title', text: albumTitle(album) });
        var refresh = function () { title.textContent = albumTitle(album); };
        var body = el('div', { class: 'item-body' });
        [
          { key: 'title', label: 'Album name', type: 'text' },
          { key: 'subtitle', label: 'Short line under the name (optional)', type: 'text', hint: 'For example "Muslim Housing Committee".' },
          { key: 'dateLabel', label: 'When (optional)', type: 'text', hint: 'For example "November 2026" or "Ongoing".' },
          { key: 'description', label: 'About this album', type: 'textarea', rows: 3 }
        ].forEach(function (f) { body.appendChild(renderField(Object.assign({}, f, { onChange: refresh }), album)); });
        body.appendChild(fieldWrap({ label: 'Cover photo', hint: 'Shown on the folder. If empty, the first photo is used.' }, imageControl(album, 'cover', {})));
        body.appendChild(renderAlbumItems(album, refresh));
        var thumb = album.cover || ((album.items.filter(function (x) { return x.type !== 'video' && x.src; })[0] || {}).src);
        var details = el('details', { class: 'item', open: !!open[i] }, [
          el('summary', null, [
            thumb ? el('img', { class: 'mini-thumb', src: previewSrc(thumb), alt: '' }) : null,
            title,
            el('span', { class: 'row-tools' }, [
              el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Move up', title: 'Move up', text: '↑', disabled: i === 0, onclick: function (e) { e.preventDefault(); var t = open[i]; open[i] = open[i - 1]; open[i - 1] = t; move(albums, i, -1); markDirty(); draw(); } }),
              el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Move down', title: 'Move down', text: '↓', disabled: i === albums.length - 1, onclick: function (e) { e.preventDefault(); var t = open[i]; open[i] = open[i + 1]; open[i + 1] = t; move(albums, i, 1); markDirty(); draw(); } }),
              el('button', {
                type: 'button', class: 'icon-btn danger', 'aria-label': 'Delete album', title: 'Delete album', text: '✕',
                onclick: function (e) {
                  e.preventDefault();
                  if (!confirm('Delete the album "' + (album.title || 'Untitled') + '" and everything in it? It is only removed from the website when you press Publish.')) return;
                  albums.splice(i, 1);
                  var n = {}; Object.keys(open).forEach(function (k) { k = +k; if (k < i) n[k] = open[k]; else if (k > i) n[k - 1] = open[k]; }); open = n;
                  markDirty(); draw();
                }
              })
            ])
          ]),
          body
        ]);
        details.addEventListener('toggle', function () { open[i] = details.open; });
        wrap.appendChild(details);
        if (focusIndex === i) setTimeout(function () { var f = body.querySelector('input'); if (f) { f.focus(); f.select(); } }, 30);
      });
    }
    draw();
    return wrap;
  }

  function renderAlbumItems(album, onChange) {
    var items = album.items;
    var box = el('div', { class: 'field' });
    function draw() {
      box.textContent = '';
      box.appendChild(el('span', { class: 'field-label', text: 'Photos & videos (' + items.length + ')' }));
      box.appendChild(el('div', { class: 'gallery-tools' }, [
        el('button', {
          type: 'button', class: 'btn btn-primary btn-small-primary', text: '+ Add photos',
          onclick: function () { addPhotos(true, function (path) { items.push({ type: 'image', src: path, caption: '' }); }).then(function (n) { if (n) { markDirty(); draw(); onChange(); toast(n + ' photo' + (n > 1 ? 's' : '') + ' added. Add captions, then Publish.'); } }); }
        }),
        el('button', {
          type: 'button', class: 'btn btn-small btn-ghost', text: '+ Add a video link',
          onclick: function () { items.push({ type: 'video', url: '', caption: '', thumb: '' }); markDirty(); draw(); onChange(); var u = box.querySelectorAll('.video-url'); if (u.length) u[u.length - 1].focus(); }
        })
      ]));
      var grid = el('ul', { class: 'gallery-grid' });
      items.forEach(function (it, i) {
        var isVid = it.type === 'video';
        var info = isVid ? videoInfo(it.url) : null;
        var thumbSrc = isVid ? (previewSrc(it.thumb) || (info && info.thumb) || '') : previewSrc(it.src);
        var cap = el('textarea', { rows: '2', placeholder: 'Caption (optional)' });
        cap.value = it.caption || '';
        cap.setAttribute('aria-label', 'Caption for item ' + (i + 1));
        cap.addEventListener('input', function () { it.caption = cap.value; markDirty(); });
        var parts = [
          thumbSrc ? el('img', { src: thumbSrc, alt: '', loading: 'lazy' }) : el('div', { class: 'thumb-empty video-empty', text: isVid ? '▶ Video' : 'No photo' }),
          el('span', { class: 'type-badge' + (isVid ? ' is-video' : ''), text: isVid ? 'Video' : 'Photo' }),
          (pending[it.src] || pending[it.thumb]) ? el('span', { class: 'new-badge', text: 'New' }) : null
        ];
        if (isVid) {
          var url = el('input', { type: 'url', class: 'video-url', placeholder: 'Paste a Facebook, YouTube, Instagram or TikTok link' });
          url.value = it.url || '';
          var BAD = 'Not a video link we can play. Paste the full link of a video (Facebook reel or video, YouTube, Instagram reel, TikTok video).';
          var status = el('span', { class: 'video-status' + (it.url && !info ? ' is-bad' : ''), text: it.url ? (info ? '✓ ' + info.site + ' video' : BAD) : 'Video link needed' });
          url.addEventListener('input', function () {
            it.url = url.value.trim(); markDirty();
            var inf = videoInfo(it.url);
            status.textContent = it.url ? (inf ? '✓ ' + inf.site + ' video' : BAD) : 'Video link needed';
            status.className = 'video-status' + (it.url && !inf ? ' is-bad' : '');
          });
          parts.push(url, status);
          parts.push(el('button', {
            type: 'button', class: 'btn btn-small', text: it.thumb ? 'Change preview picture' : 'Add preview picture',
            onclick: function () { addPhotos(false, function (p) { it.thumb = p; }).then(function (n) { if (n) { markDirty(); draw(); } }); }
          }));
        }
        parts.push(cap);
        parts.push(el('div', { class: 'row-tools' }, [
          el('button', { type: 'button', class: 'icon-btn', title: 'Move earlier', 'aria-label': 'Move earlier', text: '←', disabled: i === 0, onclick: function () { move(items, i, -1); markDirty(); draw(); } }),
          el('button', { type: 'button', class: 'icon-btn', title: 'Move later', 'aria-label': 'Move later', text: '→', disabled: i === items.length - 1, onclick: function () { move(items, i, 1); markDirty(); draw(); } }),
          (!isVid && album.cover !== it.src) ? el('button', { type: 'button', class: 'btn btn-small', text: 'Use as cover', onclick: function () { album.cover = it.src; markDirty(); draw(); onChange(); toast('Cover photo updated.'); } }) : null,
          el('button', { type: 'button', class: 'btn btn-small btn-danger-ghost', text: 'Remove', onclick: function () { if (confirm('Remove this ' + (isVid ? 'video' : 'photo') + ' from the album?')) { if (album.cover && album.cover === it.src) album.cover = ''; items.splice(i, 1); markDirty(); draw(); onChange(); } } })
        ]));
        grid.appendChild(el('li', { class: 'gallery-item' }, parts));
      });
      box.appendChild(grid);
    }
    draw();
    return box;
  }

  /* ------------------------------------------------------------------ *
   * History (backups made on every publish)
   * ------------------------------------------------------------------ */
  function renderHistory() {
    var box = el('div', { class: 'card history' }, [el('p', { class: 'muted', text: 'Loading…' })]);
    api('admin/backups').then(function (j) {
      box.textContent = '';
      if (!j.backups.length) { box.appendChild(el('p', { class: 'muted', text: 'No earlier versions yet. A copy is saved automatically every time you publish.' })); return; }
      var list = el('ul', { class: 'history-list' });
      j.backups.forEach(function (b) {
        var d = new Date(b.savedAt);
        var label = isNaN(d) ? b.key : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
        list.appendChild(el('li', null, [
          el('span', { text: 'Version saved before a publish on ' + label }),
          el('button', {
            type: 'button', class: 'btn btn-small', text: 'Restore',
            onclick: function () {
              if (isDirty() && !confirm('You have unpublished changes. Restoring will discard them. Continue?')) return;
              if (!confirm('Restore the version from ' + label + '? The live website will change immediately. (Your current version is kept in History too.)')) return;
              busy(true, 'Restoring…');
              api('admin/restore', { method: 'POST', body: { key: b.key } }).then(function (r) {
                original = r.content; content = clone(r.content); baseVersion = r.version || '';
                markDirty(); toast('Restored. The website now shows that version.');
                openSection('history');
              }).catch(handleError).then(function () { busy(false); });
            }
          })
        ]));
      });
      box.appendChild(list);
    }).catch(function (e) { box.textContent = ''; box.appendChild(el('p', { class: 'error', text: e.message })); });
    return box;
  }

  /* ------------------------------------------------------------------ *
   * Sections + sidebar
   * ------------------------------------------------------------------ */
  function renderSection(sec) {
    var main = $('#editor');
    main.textContent = '';
    main.appendChild(el('div', { class: 'section-head' }, [
      el('h1', { text: sec.title }),
      sec.desc ? el('p', { class: 'muted', text: sec.desc }) : null
    ]));
    if (sec.type === 'object') {
      if (!content[sec.key] || typeof content[sec.key] !== 'object') content[sec.key] = {};
      var card = el('div', { class: 'card' });
      sec.fields.forEach(function (f) { card.appendChild(renderField(f, content[sec.key])); });
      main.appendChild(card);
    } else if (sec.type === 'list') {
      if (!Array.isArray(content[sec.key])) content[sec.key] = [];
      main.appendChild(renderList(content[sec.key], sec, false));
    } else if (sec.type === 'albums') {
      main.appendChild(renderAlbumsEditor());
    } else if (sec.type === 'history') {
      main.appendChild(renderHistory());
    }
  }
  function renderSidebar() {
    var nav = $('#sidebar');
    nav.textContent = '';
    SECTIONS.forEach(function (sec) {
      nav.appendChild(el('button', {
        type: 'button', class: 'side-link' + (activeSection === sec.key ? ' is-active' : ''), text: sec.title,
        'aria-current': activeSection === sec.key ? 'page' : null,
        onclick: function () { openSection(sec.key); document.body.classList.remove('nav-open'); $('.nav-toggle').setAttribute('aria-expanded', 'false'); }
      }));
    });
    // On phones the top bar is too small for these, so they live at the bottom of the menu
    nav.appendChild(el('div', { class: 'side-extra' }, [
      el('a', { class: 'side-link', href: '../', target: '_blank', rel: 'noopener', text: 'View site ↗' }),
      el('button', { type: 'button', class: 'side-link', text: 'Sign out', onclick: function () { $('#logout-btn').click(); } })
    ]));
  }
  function openSection(key) {
    activeSection = key;
    renderSidebar();
    renderSection(SECTIONS.filter(function (s) { return s.key === key; })[0]);
    window.scrollTo(0, 0);
    var h = $('#editor h1');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  }

  /* ------------------------------------------------------------------ *
   * Validation + publishing
   * ------------------------------------------------------------------ */
  var SAFE_PROTOCOLS = { 'http:': 1, 'https:': 1, 'mailto:': 1, 'tel:': 1 };
  function isSafeLink(u) {
    u = String(u || '').trim();
    if (!u || /^#[\w-]*$/.test(u)) return true;
    try { return SAFE_PROTOCOLS.hasOwnProperty(new URL(u, location.href).protocol); } catch (e) { return false; }
  }
  function validate() {
    var problems = [];
    if (!content.hero || !content.hero.image) problems.push('The top-of-page photo is missing.');
    var accounts = (content.donate && content.donate.accounts) || [];
    if (!accounts.length) problems.push('Add at least one bank account.');
    accounts.forEach(function (a, i) { if (!String(a.accountNumber || '').trim()) problems.push('Bank account "' + (a.label || i + 1) + '" has no account number.'); });
    var c = content.contact || {};
    ['mapLink', 'facebook', 'instagram', 'youtube', 'tiktok'].forEach(function (k) { if (!isSafeLink(c[k])) problems.push('The ' + k + ' link is not a valid web address.'); });
    (content.involved || []).forEach(function (x) { if (!isSafeLink(x.ctaLink)) problems.push('"' + (x.title || 'Get involved card') + '" has an invalid link.'); });
    (content.projects || []).forEach(function (p, i) {
      if (!p.title) problems.push('Project #' + (i + 1) + ' has no title.');
      if (p.ctaLabel && !p.ctaLink) problems.push('"' + (p.title || 'Project #' + (i + 1)) + '" has button text but no button link.');
      if (!isSafeLink(p.ctaLink)) problems.push('"' + (p.title || 'Project #' + (i + 1)) + '" has an invalid button link.');
    });
    (content.albums || []).forEach(function (a) {
      if (!String(a.title || '').trim()) problems.push('An album has no name.');
      (a.items || []).forEach(function (it) {
        if (it.type === 'video' && !videoInfo(it.url)) problems.push('A video in "' + (a.title || 'an album') + '" needs a valid link (Facebook, YouTube, Instagram, TikTok or Vimeo).');
      });
    });
    return problems.filter(function (p, i, all) { return all.indexOf(p) === i; });
  }
  function referencedMedia(c) {
    var found = {};
    (function walk(v) {
      if (typeof v === 'string') { if (v.indexOf('media/') === 0) found[v] = true; }
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.keys(v).forEach(function (k) { walk(v[k]); });
    })(c);
    return found;
  }
  function handleError(e) {
    if (e.status === 401) {
      saveDraft();
      toast('Your sign-in has expired. Reload this page and sign in again: your text changes will be offered back to you (new photos need to be added again).', true);
      return;
    }
    if (e.status === 409) saveDraft();
    toast((e.status === 409 ? '' : 'Something went wrong: ') + e.message, true);
  }
  function publish() {
    if (publishing) return;
    var problems = validate();
    if (problems.length) { toast('Please fix: ' + problems.join(' '), true); return; }
    var used = referencedMedia(content);
    var uploads = Object.keys(pending).filter(function (p) { return used[p]; });
    publishing = true;
    markDirty();
    busy(true, 'Publishing…');
    uploads.reduce(function (p, path, i) {
      return p.then(function () {
        $('#busy-text').textContent = 'Uploading photo ' + (i + 1) + ' of ' + uploads.length + '…';
        return api('admin/upload?name=' + encodeURIComponent(path.slice(6)), { method: 'POST', body: pending[path].blob }).then(function () {
          shown[path] = pending[path].url;
          delete pending[path];
        });
      });
    }, Promise.resolve()).then(function () {
      $('#busy-text').textContent = 'Saving…';
      return api('admin/content', { method: 'PUT', body: { content: content, base: baseVersion } });
    }).then(function (j) {
      baseVersion = j.version || '';
      original = clone(content);
      clearDraft();
      toast('Published. The website shows your changes within a minute.');
    }).catch(handleError).then(function () { publishing = false; busy(false); markDirty(); });
  }

  /* Draft safety net: keeps unpublished text edits if a session expires */
  function saveDraft() {
    try { localStorage.setItem('cda-draft', JSON.stringify({ content: content, base: baseVersion, at: Date.now() })); } catch (e) { /* ignore */ }
  }
  function clearDraft() { try { localStorage.removeItem('cda-draft'); } catch (e) { /* ignore */ } }
  function takeDraft() {
    try {
      var d = JSON.parse(localStorage.getItem('cda-draft') || 'null');
      if (!d || !d.content || Date.now() - d.at > 7 * 864e5) return null;
      return d;
    } catch (e) { return null; }
  }
  function stripUnsavedPhotos(c) {
    (function walk(v) {
      if (Array.isArray(v)) {
        for (var i = v.length - 1; i >= 0; i--) {
          var it = v[i];
          if (it && typeof it === 'object' && it.type === 'image' && typeof it.src === 'string' && it.src.indexOf('media/') === 0 && !shown[it.src] && !knownMedia[it.src]) v.splice(i, 1);
          else walk(it);
        }
      } else if (v && typeof v === 'object') {
        Object.keys(v).forEach(function (k) {
          if (typeof v[k] === 'string' && v[k].indexOf('media/') === 0 && !knownMedia[v[k]]) v[k] = '';
          else walk(v[k]);
        });
      }
    })(c);
    return c;
  }
  var knownMedia = {};

  function preview() {
    var w = window.open('../?preview=1', 'cda-preview');
    if (!w) { toast('Please allow pop-ups to use Preview.', true); return; }
    if (preview._listener) window.removeEventListener('message', preview._listener);
    function onMsg(e) {
      if (e.origin !== location.origin || e.source !== w || !e.data || e.data.type !== 'cda-preview-ready') return;
      var images = {};
      Object.keys(shown).forEach(function (p) { images[p] = shown[p]; });
      Object.keys(pending).forEach(function (p) { images[p] = pending[p].url; });
      w.postMessage({ type: 'cda-preview', content: content, images: images }, location.origin);
    }
    preview._listener = onMsg;
    window.addEventListener('message', onMsg);
  }

  /* ------------------------------------------------------------------ *
   * Start-up and sign-in
   * ------------------------------------------------------------------ */
  function showScreen(id) {
    ['login-view', 'app-view'].forEach(function (v) { $('#' + v).hidden = v !== id; });
  }
  function showLoginPanel(id) {
    ['login-form', 'state-offline', 'state-setup'].forEach(function (p) { $('#' + p).hidden = p !== id; });
    showScreen('login-view');
    var input = $('#' + id + ' input');
    if (input) setTimeout(function () { input.focus(); }, 50);
  }
  function loginError(msg) { var e = $('#login-error'); e.textContent = msg || ''; e.hidden = !msg; }

  function startEditor() {
    busy(true, 'Loading content…');
    return api('admin/content').then(function (j) {
      baseVersion = j.version || '';
      if (j.content) return j.content;
      // Nothing published from the admin yet: start from the content shipped with the site.
      return fetch('../content/site.json', { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('Could not load the website content (' + r.status + ').');
        return r.json();
      });
    }).then(function (c) {
      original = c; content = clone(c);
      knownMedia = referencedMedia(c);
      var draft = takeDraft();
      if (draft && JSON.stringify(draft.content) !== JSON.stringify(c)) {
        var newer = typeof draft.base === 'string' && draft.base !== baseVersion;
        var msg = newer
          ? 'You have unpublished changes from an earlier session, but someone has published since then. Restore your changes anyway? (Publishing them will be blocked until you reload, so nothing is overwritten by accident.)'
          : 'You have unpublished changes from an earlier session. Restore them?';
        if (confirm(msg)) {
          content = stripUnsavedPhotos(draft.content);
          if (newer) baseVersion = draft.base; // keeps the conflict check honest
        }
      }
      clearDraft();
      showScreen('app-view');
      markDirty();
      openSection('projects');
    }).catch(function (e) {
      if (e.status === 401) { showLoginPanel('login-form'); return; }
      loginError(e.message);
      showLoginPanel('login-form');
    }).then(function () { busy(false); });
  }

  function init() {
    api('session').then(function (s) {
      if (!s.configured) { showLoginPanel('state-setup'); return; }
      if (s.authed) startEditor();
      else showLoginPanel('login-form');
    }).catch(function () { showLoginPanel('state-offline'); });

    $('#login-form').addEventListener('submit', function (e) {
      e.preventDefault();
      loginError('');
      var pw = $('#password').value;
      busy(true, 'Signing in…');
      api('login', { method: 'POST', body: { password: pw } }).then(function () {
        $('#password').value = '';
        return startEditor();
      }).catch(function (err) { loginError(err.message); }).then(function () { busy(false); });
    });

    $('#publish-btn').addEventListener('click', publish);
    $('#preview-btn').addEventListener('click', preview);
    $('#logout-btn').addEventListener('click', function () {
      if (isDirty() && !confirm('You have unpublished changes. Sign out anyway?')) return;
      api('logout', { method: 'POST', body: {} }).catch(function () {}).then(function () { original = content = null; location.reload(); });
    });
    $('.nav-toggle').addEventListener('click', function () {
      var open = !document.body.classList.contains('nav-open');
      document.body.classList.toggle('nav-open', open);
      this.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (!$('#publish-btn').disabled) publish(); }
    });
  }

  init();
})();
