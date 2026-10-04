/* Caribbean Dawah Association - site admin.
   Edits content/site.json and the images in /uploads.

   Two storage backends, picked automatically:
   - PHP:    when admin/api.php runs on the host (shared hosting / cPanel). Password sign-in.
   - GitHub: when the site is served from GitHub Pages. Signs in with a fine-grained
             access token and publishes each save as a single commit. */
(function () {
  'use strict';

  var CFG = window.CDA_ADMIN_CONFIG || {};
  var CONTENT_PATH = CFG.contentPath || 'content/site.json';
  var UPLOADS = (CFG.uploadsDir || 'uploads').replace(/\/+$/, '');
  var MAX_W = CFG.maxImageWidth || 1600;
  var QUALITY = CFG.jpegQuality || 0.82;
  var GH_API = (CFG.githubApi || 'https://api.github.com').replace(/\/+$/, '');

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
    toast._t = setTimeout(function () { t.classList.remove('is-visible'); }, isError ? 6000 : 3000);
  }
  function busy(on, text) {
    $('#busy').hidden = !on;
    if (text) $('#busy-text').textContent = text;
  }
  function slugify(s) {
    return String(s || 'photo').toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'photo';
  }

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */
  var backend = null;        // 'php' | 'github'
  var original = null;       // content as last loaded/published
  var content = null;        // working copy being edited
  var pending = {};          // path -> { blob, url } images not yet published
  var shown = {};            // path -> blob URL for images just published (the host may take a minute to serve them)
  var activeSection = null;
  var gh = { repo: '', branch: 'main', token: '' };
  var csrf = '';
  var baseVersion = '';      // version of site.json we started editing from (detects someone else publishing meanwhile)
  var publishing = false;

  function isDirty() { return JSON.stringify(original) !== JSON.stringify(content); }
  function markDirty() {
    var d = isDirty();
    $('#dirty-flag').hidden = !d;
    $('#publish-btn').disabled = !d;
  }
  window.addEventListener('beforeunload', function (e) {
    if (content && isDirty()) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ------------------------------------------------------------------ *
   * Image handling: resize + compress in the browser before upload
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
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('This file could not be read as an image.')); };
      img.src = url;
    });
  }
  function processImage(file) {
    if (!/^image\/(jpeg|png|webp|gif|heic|heif)$/i.test(file.type) && !/\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name)) {
      return Promise.reject(new Error('"' + file.name + '" is not a supported image. Please use JPG, PNG or WebP.'));
    }
    if (file.size > 25 * 1024 * 1024) return Promise.reject(new Error('"' + file.name + '" is larger than 25 MB.'));
    return loadBitmap(file).then(function (img) {
      var w = img.width, h = img.height;
      if (!w || !h) throw new Error('"' + file.name + '" could not be read.');
      var scale = Math.min(1, MAX_W / w);
      var cw = Math.round(w * scale), ch = Math.round(h * scale);
      var canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cw, ch);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, cw, ch);
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (blob) { blob ? resolve(blob) : reject(new Error('Could not compress "' + file.name + '".')); }, 'image/jpeg', QUALITY);
      });
    }).then(function (blob) {
      var stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      var path = UPLOADS + '/' + slugify(file.name) + '-' + stamp + '.jpg';
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

  /* ------------------------------------------------------------------ *
   * Editor schema: describes every editable part of the site
   * ------------------------------------------------------------------ */
  var ICONS = [['chat', 'Speech bubble'], ['question', 'Question mark'], ['book', 'Book'], ['bowl', 'Soup bowl'], ['basket', 'Basket'], ['home', 'House'], ['hands', 'Heart'], ['mosque', 'Masjid']];
  var STATUSES = [['upcoming', 'Upcoming'], ['ongoing', 'Ongoing'], ['planned', 'Planned / future goal'], ['past', 'Completed (shows under "Recent")']];

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
        { key: 'ctaLink', label: 'Button link', type: 'text', hint: 'Use #donate for the donation section, #contact for contact details, or paste a full web address (https://…).' }
      ]
    },
    { key: 'gallery', title: 'Photo gallery', desc: 'Real photos from the field. Add as many as you like, drag the order with the arrows, and remove any you no longer want.', type: 'gallery' },
    {
      key: 'donate', title: 'Donations & bank details', desc: 'These details appear in the "Give" section. Double-check the account number before publishing.',
      type: 'object',
      fields: [
        { key: 'heading', label: 'Heading', type: 'text' },
        { key: 'intro', label: 'Intro text', type: 'textarea' },
        { key: 'bankName', label: 'Bank', type: 'text' },
        { key: 'accountName', label: 'Account name', type: 'text' },
        { key: 'accountNumber', label: 'Account number', type: 'text', important: true },
        { key: 'accountType', label: 'Account type', type: 'text' },
        { key: 'currency', label: 'Currency (optional)', type: 'text', hint: 'For example TTD. Leave empty to hide.' },
        { key: 'swift', label: 'SWIFT / BIC code (optional)', type: 'text', hint: 'Only needed for international donors. Leave empty to hide.' },
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
        { key: 'image', label: 'Background photo', type: 'image', altKey: 'imageAlt', required: true, hint: 'A wide, real photo works best. Faces should be on the right half.' }
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
        { key: 'pillar', label: 'Column', type: 'text', hint: 'Currently "Sharing Islam" or "Serving our community".' },
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
    }
  ];

  /* ------------------------------------------------------------------ *
   * Field renderers
   * ------------------------------------------------------------------ */
  function fieldWrap(f, control) {
    return el('div', { class: 'field' + (f.important ? ' is-important' : '') }, [
      el('span', { class: 'field-label', text: f.label }),
      control,
      f.hint ? el('span', { class: 'hint', text: f.hint }) : null
    ]);
  }

  function renderField(f, obj) {
    if (f.type === 'image') return renderImageField(f, obj);
    if (f.type === 'strings') return renderStrings(f, obj);
    var id = 'f-' + Math.random().toString(36).slice(2);
    var control;
    if (f.type === 'textarea') {
      control = el('textarea', { id: id, rows: String(f.rows || 3) });
      control.value = obj[f.key] || '';
    } else if (f.type === 'select') {
      control = el('select', { id: id }, f.options.map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
      control.value = obj[f.key] || f.options[0][0];
    } else {
      control = el('input', { id: id, type: f.type === 'date' ? 'date' : 'text' });
      control.value = obj[f.key] || '';
    }
    control.addEventListener('input', function () { obj[f.key] = control.value; markDirty(); if (f.onChange) f.onChange(); });
    var wrap = fieldWrap(f, control);
    wrap.querySelector('.field-label').setAttribute('id', id + '-l');
    control.setAttribute('aria-labelledby', id + '-l');
    return wrap;
  }

  function renderImageField(f, obj) {
    var box = el('div', { class: 'image-field' });
    function draw() {
      box.textContent = '';
      var src = previewSrc(obj[f.key]);
      box.appendChild(src
        ? el('img', { class: 'thumb', src: src, alt: '' })
        : el('div', { class: 'thumb thumb-empty', text: 'No photo' }));
      var actions = el('div', { class: 'image-actions' }, [
        el('button', {
          type: 'button', class: 'btn btn-small', text: src ? 'Replace photo' : 'Upload photo',
          onclick: function () {
            pickFiles(false).then(function (files) {
              if (!files.length) return;
              busy(true, 'Preparing photo…');
              return processImage(files[0]).then(function (path) {
                obj[f.key] = path; markDirty(); draw();
              });
            }).catch(function (e) { toast(e.message, true); }).then(function () { busy(false); });
          }
        }),
        (src && !f.required) ? el('button', {
          type: 'button', class: 'btn btn-small btn-danger-ghost', text: 'Remove photo',
          onclick: function () { obj[f.key] = ''; markDirty(); draw(); }
        }) : null
      ]);
      box.appendChild(actions);
      if (f.altKey) {
        var alt = el('input', { type: 'text', placeholder: 'Describe the photo in a few words (helps blind visitors and Google)' });
        alt.value = obj[f.altKey] || '';
        alt.addEventListener('input', function () { obj[f.altKey] = alt.value; markDirty(); });
        box.appendChild(el('label', { class: 'alt-field' }, [el('span', { text: 'Photo description' }), alt]));
      }
    }
    draw();
    return fieldWrap(f, box);
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
      box.appendChild(el('button', { type: 'button', class: 'btn btn-small btn-ghost', text: '+ ' + (f.addLabel || 'Add'), onclick: function () { arr.push(''); markDirty(); draw(); var last = box.querySelectorAll('input,textarea'); if (last.length) last[last.length - 1].focus(); } }));
    }
    draw();
    return fieldWrap(f, box);
  }

  function move(arr, i, d) {
    var j = i + d;
    if (j < 0 || j >= arr.length) return;
    var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }

  /* ------------------------------------------------------------------ *
   * Section renderers
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
      main.appendChild(renderList(sec));
    } else if (sec.type === 'gallery') {
      main.appendChild(renderGallery());
    }
  }

  function renderList(sec) {
    if (!Array.isArray(content[sec.key])) content[sec.key] = [];
    var arr = content[sec.key];
    var wrap = el('div', { class: 'list' });
    var open = {};
    function draw(focusIndex) {
      wrap.textContent = '';
      wrap.appendChild(el('button', {
        type: 'button', class: 'btn btn-primary add-btn', text: '+ ' + sec.addLabel,
        onclick: function () {
          arr.unshift(sec.newItem());
          var shifted = {}; Object.keys(open).forEach(function (k) { shifted[+k + 1] = open[k]; }); open = shifted; open[0] = true;
          markDirty(); draw(0);
        }
      }));
      if (!arr.length) wrap.appendChild(el('p', { class: 'empty', text: 'Nothing here yet.' }));
      arr.forEach(function (item, i) {
        var title = el('span', { class: 'item-title', text: sec.itemTitle(item) });
        var body = el('div', { class: 'item-body' });
        sec.fields.forEach(function (f) {
          var ff = Object.assign({}, f, { onChange: function () { title.textContent = sec.itemTitle(item); } });
          body.appendChild(renderField(ff, item));
        });
        var details = el('details', { class: 'item', open: !!open[i] }, [
          el('summary', null, [
            item.status ? el('span', { class: 'badge badge-' + item.status, text: (STATUSES.filter(function (s) { return s[0] === item.status; })[0] || [0, item.status])[1].split(' ')[0] }) : null,
            item.image ? el('img', { class: 'mini-thumb', src: previewSrc(item.image), alt: '' }) : null,
            title,
            el('span', { class: 'row-tools' }, [
              el('button', { type: 'button', class: 'icon-btn', title: 'Move up', 'aria-label': 'Move up', text: '↑', disabled: i === 0, onclick: function (e) { e.preventDefault(); swapOpen(i, i - 1); move(arr, i, -1); markDirty(); draw(); } }),
              el('button', { type: 'button', class: 'icon-btn', title: 'Move down', 'aria-label': 'Move down', text: '↓', disabled: i === arr.length - 1, onclick: function (e) { e.preventDefault(); swapOpen(i, i + 1); move(arr, i, 1); markDirty(); draw(); } }),
              el('button', {
                type: 'button', class: 'icon-btn danger', title: 'Delete', 'aria-label': 'Delete', text: '✕',
                onclick: function (e) {
                  e.preventDefault();
                  if (!confirm('Delete "' + sec.itemTitle(item) + '"? You can still undo by not publishing.')) return;
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

  function renderGallery() {
    if (!Array.isArray(content.gallery)) content.gallery = [];
    var arr = content.gallery;
    var wrap = el('div');
    function draw() {
      wrap.textContent = '';
      wrap.appendChild(el('div', { class: 'gallery-tools' }, [
        el('button', {
          type: 'button', class: 'btn btn-primary', text: '+ Add photos',
          onclick: function () {
            pickFiles(true).then(function (files) {
              if (!files.length) return;
              var done = 0, failed = [];
              busy(true, 'Preparing ' + files.length + ' photo' + (files.length > 1 ? 's' : '') + '…');
              return files.reduce(function (p, file) {
                return p.then(function () {
                  return processImage(file).then(function (path) {
                    arr.unshift({ image: path, caption: '' }); done++;
                    $('#busy-text').textContent = 'Prepared ' + done + ' of ' + files.length + '…';
                  }, function (e) { failed.push(e.message); });
                });
              }, Promise.resolve()).then(function () {
                markDirty(); draw();
                if (failed.length) toast(failed.join(' '), true);
                else toast(done + ' photo' + (done > 1 ? 's' : '') + ' added. Add captions, then Publish.');
              });
            }).catch(function (e) { toast(e.message, true); }).then(function () { busy(false); });
          }
        }),
        el('span', { class: 'muted', text: arr.length + ' photo' + (arr.length === 1 ? '' : 's') })
      ]));
      var grid = el('ul', { class: 'gallery-grid' });
      arr.forEach(function (g, i) {
        var cap = el('textarea', { rows: '2', placeholder: 'Caption (optional)' });
        cap.value = g.caption || '';
        cap.setAttribute('aria-label', 'Caption for photo ' + (i + 1));
        cap.addEventListener('input', function () { g.caption = cap.value; markDirty(); });
        grid.appendChild(el('li', { class: 'gallery-item' }, [
          el('img', { src: previewSrc(g.image), alt: '', loading: 'lazy' }),
          pending[g.image] ? el('span', { class: 'new-badge', text: 'New' }) : null,
          cap,
          el('div', { class: 'row-tools' }, [
            el('button', { type: 'button', class: 'icon-btn', title: 'Move earlier', 'aria-label': 'Move earlier', text: '←', disabled: i === 0, onclick: function () { move(arr, i, -1); markDirty(); draw(); } }),
            el('button', { type: 'button', class: 'icon-btn', title: 'Move later', 'aria-label': 'Move later', text: '→', disabled: i === arr.length - 1, onclick: function () { move(arr, i, 1); markDirty(); draw(); } }),
            el('button', { type: 'button', class: 'btn btn-small btn-danger-ghost', text: 'Remove', onclick: function () { if (confirm('Remove this photo from the gallery?')) { arr.splice(i, 1); markDirty(); draw(); } } })
          ])
        ]));
      });
      wrap.appendChild(grid);
    }
    draw();
    return wrap;
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
   * Images referenced by content (used to clean up removed uploads)
   * ------------------------------------------------------------------ */
  function collectImages(c) {
    var found = {};
    (function walk(v) {
      if (typeof v === 'string') { if (v.indexOf(UPLOADS + '/') === 0) found[v] = true; }
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.keys(v).forEach(function (k) { walk(v[k]); });
    })(c);
    return found;
  }
  function changeSet() {
    var now = collectImages(content), before = collectImages(original);
    var uploads = Object.keys(pending).filter(function (p) { return now[p]; });
    var deletes = Object.keys(before).filter(function (p) { return !now[p]; });
    return { uploads: uploads, deletes: deletes };
  }
  var SAFE_PROTOCOLS = { 'http:': 1, 'https:': 1, 'mailto:': 1, 'tel:': 1 };
  function isSafeLink(u) {
    u = String(u || '').trim();
    if (!u || /^#[\w-]*$/.test(u)) return true;
    try { return SAFE_PROTOCOLS.hasOwnProperty(new URL(u, location.href).protocol); } catch (e) { return false; }
  }
  function validate() {
    var problems = [];
    var c = content.contact || {};
    ['mapLink', 'facebook', 'instagram', 'youtube', 'tiktok'].forEach(function (k) {
      if (!isSafeLink(c[k])) problems.push('The ' + k + ' link is not a valid web address.');
    });
    (content.involved || []).forEach(function (x) { if (!isSafeLink(x.ctaLink)) problems.push('"' + (x.title || 'Get involved card') + '" has an invalid link.'); });
    if (!content.hero || !content.hero.image) problems.push('The top-of-page photo is missing.');
    var d = content.donate || {};
    if (!d.accountNumber) problems.push('The bank account number is empty.');
    (content.projects || []).forEach(function (p, i) {
      if (!p.title) problems.push('Project #' + (i + 1) + ' has no title.');
      if (p.ctaLabel && !p.ctaLink) problems.push('"' + (p.title || 'Project #' + (i + 1)) + '" has button text but no button link.');
      if (!isSafeLink(p.ctaLink)) problems.push('"' + (p.title || 'Project #' + (i + 1)) + '" has an invalid button link.');
    });
    return problems;
  }

  /* ------------------------------------------------------------------ *
   * Backend: GitHub (Git Data API, one commit per publish)
   * ------------------------------------------------------------------ */
  function ghApi(path, opts) {
    opts = opts || {};
    var headers = { 'Authorization': 'Bearer ' + gh.token, 'Accept': opts.accept || 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (opts.body) headers['Content-Type'] = 'application/json';
    return fetch(GH_API + '/repos/' + gh.repo + path, {
      method: opts.method || 'GET', headers: headers, cache: 'no-store',
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      if (r.ok) return opts.raw ? r.text() : r.json();
      return r.json().catch(function () { return {}; }).then(function (j) {
        var msg = j.message || ('GitHub error ' + r.status);
        if (r.status === 401) msg = 'GitHub rejected the access token. It may have expired. Please sign in again.';
        if (r.status === 403 || r.status === 404) msg = 'This token cannot access ' + gh.repo + '. Check the repository name and that the token has Contents: Read and write.';
        var err = new Error(msg); err.status = r.status; throw err;
      });
    });
  }
  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result).split(',')[1]); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsDataURL(blob);
    });
  }
  function utf8ToBase64(str) {
    var bytes = new TextEncoder().encode(str), bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  var GitHubBackend = {
    label: function () { return 'Saving to GitHub · ' + gh.repo + ' (' + gh.branch + ')'; },
    signIn: function () {
      return ghApi('').then(function (repo) {
        if (!repo.permissions || !repo.permissions.push) throw new Error('This token can read ' + gh.repo + ' but cannot save changes. Give it Contents: Read and write.');
      });
    },
    load: function () {
      return ghApi('/contents/' + CONTENT_PATH + '?ref=' + encodeURIComponent(gh.branch)).then(function (meta) {
        baseVersion = meta.sha;
        return ghApi('/git/blobs/' + meta.sha, { accept: 'application/vnd.github.raw+json', raw: true });
      }).then(function (text) { return JSON.parse(text); });
    },
    publish: function (json, cs, progress) {
      var head, baseTree, existing = {}, newVersion = '';
      return ghApi('/git/ref/heads/' + encodeURIComponent(gh.branch)).then(function (ref) {
        head = ref.object.sha;
        return ghApi('/git/commits/' + head);
      }).then(function (commit) {
        baseTree = commit.tree.sha;
        // Stop if someone else published content since this editor loaded it
        return ghApi('/contents/' + CONTENT_PATH + '?ref=' + head).then(function (meta) {
          if (baseVersion && meta.sha !== baseVersion) {
            var err = new Error('Someone else published changes while you were editing. Copy anything you need, then reload the admin to get the latest version.');
            err.conflict = true; throw err;
          }
        });
      }).then(function () {
        if (!cs.deletes.length) return null;
        return ghApi('/git/trees/' + baseTree + '?recursive=1').then(function (t) { (t.tree || []).forEach(function (e) { if (e.type === 'blob') existing[e.path] = true; }); });
      }).then(function () {
        var entries = [];
        var chain = Promise.resolve();
        cs.uploads.forEach(function (path, i) {
          chain = chain.then(function () {
            progress('Uploading photo ' + (i + 1) + ' of ' + cs.uploads.length + '…');
            return blobToBase64(pending[path].blob).then(function (b64) {
              return ghApi('/git/blobs', { method: 'POST', body: { content: b64, encoding: 'base64' } });
            }).then(function (b) { entries.push({ path: path, mode: '100644', type: 'blob', sha: b.sha }); });
          });
        });
        return chain.then(function () {
          progress('Saving content…');
          return ghApi('/git/blobs', { method: 'POST', body: { content: utf8ToBase64(json), encoding: 'base64' } });
        }).then(function (b) {
          entries.push({ path: CONTENT_PATH, mode: '100644', type: 'blob', sha: b.sha });
          newVersion = b.sha;
          cs.deletes.forEach(function (p) { if (existing[p]) entries.push({ path: p, mode: '100644', type: 'blob', sha: null }); });
          return ghApi('/git/trees', { method: 'POST', body: { base_tree: baseTree, tree: entries } });
        });
      }).then(function (tree) {
        var parts = [];
        if (cs.uploads.length) parts.push(cs.uploads.length + ' new photo' + (cs.uploads.length > 1 ? 's' : ''));
        if (cs.deletes.length) parts.push(cs.deletes.length + ' removed');
        return ghApi('/git/commits', { method: 'POST', body: { message: 'Update site content via admin' + (parts.length ? ' (' + parts.join(', ') + ')' : ''), tree: tree.sha, parents: [head] } });
      }).then(function (c) {
        progress('Publishing…');
        return ghApi('/git/refs/heads/' + encodeURIComponent(gh.branch), { method: 'PATCH', body: { sha: c.sha, force: false } });
      }).then(function () { baseVersion = newVersion; return 'Published. The live site updates in about a minute.'; });
    },
    signOut: function () {
      try { localStorage.removeItem('cda-gh'); sessionStorage.removeItem('cda-gh'); } catch (e) { /* storage unavailable */ }
      return Promise.resolve();
    }
  };

  /* ------------------------------------------------------------------ *
   * Backend: PHP (admin/api.php on regular web hosting)
   * ------------------------------------------------------------------ */
  function php(action, data) {
    var opts = { credentials: 'same-origin', cache: 'no-store', headers: {} };
    if (data) {
      opts.method = 'POST';
      opts.body = data;
      opts.headers['X-CSRF-Token'] = csrf;
    }
    return fetch('api.php?action=' + action, opts).then(function (r) {
      return r.json().catch(function () { throw new Error('The server did not respond correctly.'); }).then(function (j) {
        if (!r.ok || !j.ok) { var e = new Error(j.error || ('Server error ' + r.status)); e.status = r.status; e.conflict = r.status === 409; throw e; }
        return j;
      });
    });
  }
  var PhpBackend = {
    label: function () { return 'Saving to this web server'; },
    load: function () {
      return php('load').then(function (j) { baseVersion = j.version; return JSON.parse(j.content); });
    },
    publish: function (json, cs, progress) {
      // Upload photos in small batches (hosts often allow only 20 files per request),
      // then save the content. Re-sending a photo that already arrived is harmless.
      var batches = [];
      for (var i = 0; i < cs.uploads.length; i += 6) batches.push(cs.uploads.slice(i, i + 6));
      var done = 0;
      return batches.reduce(function (p, batch) {
        return p.then(function () {
          progress('Uploading photos ' + (done + 1) + '-' + (done + batch.length) + ' of ' + cs.uploads.length + '…');
          var fd = new FormData();
          batch.forEach(function (path) { fd.append('files[]', pending[path].blob, path.split('/').pop()); });
          return php('upload', fd).then(function () { done += batch.length; });
        });
      }, Promise.resolve()).then(function () {
        progress('Saving content…');
        var fd = new FormData();
        fd.append('content', json);
        fd.append('deletes', JSON.stringify(cs.deletes));
        fd.append('base', baseVersion);
        return php('save', fd);
      }).then(function (j) { baseVersion = j.version; return 'Published. Your changes are live.'; });
    },
    signOut: function () { var fd = new FormData(); return php('logout', fd).catch(function () {}); }
  };

  /* ------------------------------------------------------------------ *
   * Publish / preview
   * ------------------------------------------------------------------ */
  function publish() {
    if (publishing) return;
    var problems = validate();
    if (problems.length) { toast('Please fix: ' + problems.join(' '), true); return; }
    var cs = changeSet();
    var json = JSON.stringify(content, null, 2) + '\n';
    var B = backend === 'php' ? PhpBackend : GitHubBackend;
    publishing = true;
    $('#publish-btn').disabled = true;
    busy(true, 'Publishing…');
    B.publish(json, cs, function (t) { $('#busy-text').textContent = t; }).then(function (msg) {
      // Uploaded photos are no longer pending, but keep their in-memory preview
      // because the host may take a minute to start serving the new files.
      Object.keys(pending).forEach(function (p) { shown[p] = pending[p].url; });
      pending = {};
      original = clone(content);
      clearDraft();
      toast(msg);
    }).catch(function (e) {
      if (e.status === 401) {
        saveDraft();
        toast('Your sign-in has expired. Reload this page and sign in again: your text changes will be offered back to you (new photos need to be added again).', true);
        return;
      }
      toast((e.conflict ? '' : 'Publishing failed: ') + e.message, true);
    }).then(function () { publishing = false; busy(false); markDirty(); });
  }

  /* Draft safety net: keeps unpublished text edits if a session expires */
  function saveDraft() {
    try { localStorage.setItem('cda-draft', JSON.stringify({ content: content, at: Date.now() })); } catch (e) { /* ignore */ }
  }
  function clearDraft() { try { localStorage.removeItem('cda-draft'); } catch (e) { /* ignore */ } }
  function takeDraft() {
    try {
      var d = JSON.parse(localStorage.getItem('cda-draft') || 'null');
      if (!d || !d.content || Date.now() - d.at > 7 * 864e5) return null;
      return d.content;
    } catch (e) { return null; }
  }
  // Drop references to photos that only existed in the old browser session
  function stripMissingImages(c, known) {
    (function walk(v) {
      if (Array.isArray(v)) {
        for (var i = v.length - 1; i >= 0; i--) {
          var it = v[i];
          if (it && typeof it === 'object' && typeof it.image === 'string' && it.image.indexOf(UPLOADS + '/') === 0 && !known[it.image] && !('title' in it)) v.splice(i, 1);
          else walk(it);
        }
      } else if (v && typeof v === 'object') {
        Object.keys(v).forEach(function (k) {
          if (typeof v[k] === 'string' && v[k].indexOf(UPLOADS + '/') === 0 && !known[v[k]]) v[k] = '';
          else walk(v[k]);
        });
      }
    })(c);
    return c;
  }

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
   * Sign-in flow
   * ------------------------------------------------------------------ */
  function showLogin(which) {
    $('#app-view').hidden = true;
    $('#login-view').hidden = false;
    ['php-login', 'php-setup', 'gh-login'].forEach(function (id) { $('#' + id).hidden = id !== which; });
    var first = $('#' + which + ' input');
    if (first) setTimeout(function () { first.focus(); }, 50);
  }
  function loginError(msg) { var e = $('#login-error'); e.textContent = msg || ''; e.hidden = !msg; }

  function startEditor() {
    busy(true, 'Loading content…');
    var B = backend === 'php' ? PhpBackend : GitHubBackend;
    return B.load().then(function (c) {
      original = c; content = clone(c);
      var draft = takeDraft();
      if (draft && JSON.stringify(draft) !== JSON.stringify(c) && confirm('You have unpublished changes from an earlier session. Restore them?')) {
        content = stripMissingImages(draft, collectImages(c));
      }
      clearDraft();
      $('#login-view').hidden = true;
      $('#app-view').hidden = false;
      $('#mode-label').textContent = B.label();
      markDirty();
      openSection('projects');
    }).catch(function (e) {
      loginError(e.message);
      showLogin(backend === 'php' ? 'php-login' : 'gh-login');
    }).then(function () { busy(false); });
  }

  function readStoredGitHub() {
    try {
      localStorage.removeItem('cda-gh'); // older versions offered "remember me"; tokens now live only for this tab
      var s = sessionStorage.getItem('cda-gh');
      return s ? JSON.parse(s) : null;
    } catch (e) { return null; }
  }

  function guessRepo() {
    if (CFG.repo) return CFG.repo;
    // On GitHub Pages: owner.github.io/repo/admin/ -> owner/repo
    var m = location.hostname.match(/^([a-z0-9-]+)\.github\.io$/i);
    if (m) {
      var seg = location.pathname.split('/').filter(Boolean)[0];
      return m[1] + '/' + (seg && seg !== 'admin' ? seg : m[1] + '.github.io');
    }
    return '';
  }

  function init() {
    // Detect backend: if api.php executes, we are on PHP hosting.
    fetch('api.php?action=status', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (s) {
        if (s && s.ok && s.backend === 'php') {
          backend = 'php';
          csrf = s.csrf || '';
          if (!s.configured) { $('#login-intro').textContent = 'First-time setup'; showLogin('php-setup'); }
          else if (s.authed) startEditor();
          else showLogin('php-login');
          return;
        }
        backend = 'github';
        var saved = readStoredGitHub();
        $('#gh-repo').value = (saved && saved.repo) || guessRepo();
        $('#gh-branch').value = (saved && saved.branch) || CFG.branch || 'main';
        if (saved && saved.token) {
          gh = saved;
          GitHubBackend.signIn().then(startEditor, function (e) { loginError(e.message); showLogin('gh-login'); });
        } else showLogin('gh-login');
      });

    $('#gh-login').addEventListener('submit', function (e) {
      e.preventDefault();
      loginError('');
      gh = { repo: $('#gh-repo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, ''), branch: $('#gh-branch').value.trim() || 'main', token: $('#gh-token').value.trim() };
      busy(true, 'Signing in…');
      GitHubBackend.signIn().then(function () {
        try { sessionStorage.setItem('cda-gh', JSON.stringify(gh)); } catch (err) { /* storage unavailable: signed in until reload */ }
        $('#gh-token').value = '';
        return startEditor();
      }).catch(function (err) { loginError(err.message); }).then(function () { busy(false); });
    });

    $('#php-login').addEventListener('submit', function (e) {
      e.preventDefault();
      loginError('');
      var fd = new FormData();
      fd.append('password', $('#php-password').value);
      busy(true, 'Signing in…');
      php('login', fd).then(function (j) {
        csrf = j.csrf || csrf;
        $('#php-password').value = '';
        return startEditor();
      }).catch(function (err) { loginError(err.message); }).then(function () { busy(false); });
    });

    $('#php-setup').addEventListener('submit', function (e) {
      e.preventDefault();
      var fd = new FormData();
      fd.append('password', $('#setup-password').value);
      php('hash', fd).then(function (j) {
        var out = $('#setup-hash');
        out.value = j.hash; out.hidden = false; out.select();
        loginError('');
      }).catch(function (err) { loginError(err.message); });
    });

    $('#publish-btn').addEventListener('click', publish);
    $('#preview-btn').addEventListener('click', preview);
    $('#logout-btn').addEventListener('click', function () {
      if (isDirty() && !confirm('You have unpublished changes. Sign out anyway?')) return;
      var B = backend === 'php' ? PhpBackend : GitHubBackend;
      B.signOut().then(function () { original = content = null; location.reload(); });
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
