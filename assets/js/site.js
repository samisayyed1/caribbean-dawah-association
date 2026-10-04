/* Caribbean Dawah Association - renders the one-page site from content/site.json.
   All editable content lives in that file and is managed from /admin/. */
(function () {
  'use strict';

  document.documentElement.classList.add('js');

  var CONTENT_URL = 'content/site.json';
  var previewImages = {}; // path -> blob URL, only used by the admin live preview
  var $ = function (sel, root) { return (root || document).querySelector(sel); };

  /* ---------- Safety helpers ---------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // Only allow http(s), mailto and tel links, in-page anchors and same-site relative paths.
  // Parsed with the browser's own URL parser, so tricks like "java\tscript:" are caught.
  var SAFE_PROTOCOLS = { 'http:': 1, 'https:': 1, 'mailto:': 1, 'tel:': 1 };
  function safeUrl(u) {
    u = String(u || '').trim();
    if (!u) return '';
    if (/^#[\w-]*$/.test(u)) return u;
    try {
      var parsed = new URL(u, location.href);
      return SAFE_PROTOCOLS.hasOwnProperty(parsed.protocol) ? u : '';
    } catch (e) { return ''; }
  }
  function imgSrc(p) {
    p = String(p || '').trim();
    if (!p) return '';
    if (previewImages[p]) return previewImages[p];
    if (/^https:\/\//i.test(p)) return p;
    if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.indexOf('..') !== -1) return '';
    return p.replace(/^\/+/, '');
  }
  function icon(name, cls) {
    return '<svg class="i' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="#i-' + esc(name) + '"/></svg>';
  }
  function telHref(phone) { return 'tel:' + String(phone || '').replace(/[^\d+]/g, ''); }
  function isExternal(u) { return /^https?:/i.test(u); }
  function linkAttrs(u) { return isExternal(u) ? ' target="_blank" rel="noopener"' : ''; }
  function setText(id, text) { var el = document.getElementById(id); if (el) el.textContent = text || ''; }

  /* ---------- Dates & project status ---------- */
  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  // An "upcoming" project whose date has passed automatically moves to "Recent".
  function effectiveStatus(p) {
    var s = p.status || 'upcoming';
    if (s === 'upcoming' && p.date && /^\d{4}-\d{2}-\d{2}$/.test(p.date) && p.date < todayISO()) return 'past';
    return s;
  }
  var STATUS_LABEL = { upcoming: 'Upcoming', ongoing: 'Ongoing', planned: 'Planned', past: 'Completed' };

  /* ---------- Renderers ---------- */
  function renderMeta(c) {
    if (c.meta && c.meta.title) document.title = c.meta.title;
    if (c.meta && c.meta.description) {
      var m = document.querySelector('meta[name="description"]');
      if (m) m.setAttribute('content', c.meta.description);
    }
  }

  function renderHero(h) {
    h = h || {};
    var lines = String(h.headline || '').split(/\n/).filter(Boolean);
    if (lines.length) {
      $('#hero-title').innerHTML = lines.map(function (l, i) {
        var t = esc(l);
        return '<span class="line">' + (i === lines.length - 1 && lines.length > 1 ? '<em>' + t + '</em>' : t) + '</span>';
      }).join('');
    }
    setText('hero-eyebrow', h.eyebrow);
    setText('hero-text', h.text);
    var img = $('#hero-img');
    if (h.image && imgSrc(h.image)) { img.src = imgSrc(h.image); img.alt = h.imageAlt || ''; }
  }

  function renderNextUp(projects) {
    var box = $('#next-up');
    var upcoming = (projects || []).filter(function (p) { return effectiveStatus(p) === 'upcoming'; })
      .sort(function (a, b) { return String(a.date || '9999').localeCompare(String(b.date || '9999')); });
    var p = upcoming[0];
    if (!p) { box.hidden = true; return; }
    box.innerHTML =
      '<p class="next-up-kicker">Next up</p>' +
      '<h2>' + esc(p.title) + '</h2>' +
      '<p>' + icon('calendar') + '<span>' + esc(p.dateLabel || p.date) + (p.location ? ' · ' + esc(p.location) : '') + '</span></p>' +
      '<a href="#projects">See what\'s coming ' + icon('arrow-right') + '</a>';
    box.hidden = false;
  }

  function renderStats(stats) {
    $('#stats').innerHTML = (stats || []).map(function (s) {
      return '<li class="stat reveal"><span class="stat-value" data-count="' + esc(s.value) + '">' + esc(s.value) + '</span>' +
        '<span class="stat-label">' + esc(s.label) + '</span></li>';
    }).join('');
  }

  function renderAbout(a) {
    a = a || {};
    setText('about-eyebrow', a.eyebrow || 'Who we are');
    setText('about-title', a.heading);
    setText('about-statement', a.statement);
    $('#about-paragraphs').innerHTML = (a.paragraphs || []).map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('');
    var fig = $('.about-figure'), img = $('#about-img');
    if (a.image && imgSrc(a.image)) { img.src = imgSrc(a.image); img.alt = a.imageAlt || ''; fig.hidden = false; }
    else fig.hidden = true;
  }

  function renderPrograms(list) {
    var groups = [];
    var byName = {};
    (list || []).forEach(function (p) {
      var key = p.pillar || 'Our work';
      if (!byName[key]) { byName[key] = { name: key, items: [] }; groups.push(byName[key]); }
      byName[key].items.push(p);
    });
    $('#pillars').innerHTML = groups.map(function (g, gi) {
      return '<div class="pillar reveal">' +
        '<h3 class="pillar-title">' + esc(g.name) + '<span>' + String(g.items.length).padStart(2, '0') + ' ways</span></h3>' +
        g.items.map(function (p) {
          return '<div class="program"><div class="program-icon">' + icon(p.icon || 'chat') + '</div>' +
            '<div><h4>' + esc(p.title) + '</h4><p>' + esc(p.text) + '</p></div></div>';
        }).join('') + '</div>';
    }).join('');
  }

  function renderStory(s) {
    var section = $('#story');
    if (!s || (!s.before && !s.after && !s.text)) { section.hidden = true; return; }
    section.hidden = false;
    setText('story-eyebrow', s.eyebrow);
    setText('story-title', s.heading);
    setText('story-text', s.text);
    var cta = $('#story-cta');
    if (s.ctaLabel) { cta.textContent = s.ctaLabel; cta.hidden = false; } else cta.hidden = true;
    var shots = '';
    if (s.before && imgSrc(s.before)) {
      shots += '<figure class="story-shot before"><img src="' + esc(imgSrc(s.before)) + '" alt="' + esc(s.beforeAlt) + '" loading="lazy"><figcaption>' + esc(s.beforeLabel || 'Before') + '</figcaption></figure>';
    }
    if (s.after && imgSrc(s.after)) {
      shots += '<figure class="story-shot after"><img src="' + esc(imgSrc(s.after)) + '" alt="' + esc(s.afterAlt) + '" loading="lazy"><figcaption>' + esc(s.afterLabel || 'After') + '</figcaption></figure>';
    }
    if (s.before && s.after) shots += '<span class="story-arrow" aria-hidden="true">' + icon('arrow-right') + '</span>';
    $('#story-compare').innerHTML = shots;
  }

  function renderReflection(r) {
    var sec = $('.reflection');
    if (!r || !r.text) { sec.hidden = true; return; }
    sec.hidden = false;
    setText('reflection-text', r.text);
    setText('reflection-source', r.source);
  }

  var projectFilter = 'current';
  var allProjects = [];
  function renderProjects() {
    var items = allProjects.map(function (p) { return Object.assign({}, p, { _status: effectiveStatus(p) }); });
    var list;
    if (projectFilter === 'past') {
      list = items.filter(function (p) { return p._status === 'past'; })
        .sort(function (a, b) { return String(b.date || '').localeCompare(String(a.date || '')); });
    } else {
      var rank = { upcoming: 0, ongoing: 1, planned: 2 };
      list = items.filter(function (p) { return p._status !== 'past'; })
        .sort(function (a, b) {
          var r = (rank[a._status] == null ? 3 : rank[a._status]) - (rank[b._status] == null ? 3 : rank[b._status]);
          if (r) return r;
          return String(a.date || '9999').localeCompare(String(b.date || '9999'));
        });
    }
    var grid = $('#project-panel');
    if (!list.length) {
      grid.innerHTML = '<p class="empty-state">' + (projectFilter === 'past' ? 'Our recent projects will appear here.' : 'New projects are on the way. Follow us on Facebook and Instagram for updates.') + '</p>';
      return;
    }
    grid.innerHTML = list.map(function (p) {
      if (!STATUS_LABEL.hasOwnProperty(p._status)) p._status = 'ongoing';
      var media;
      if (p.image && imgSrc(p.image)) {
        media = '<div class="project-media"><span class="chip chip-' + p._status + '">' + STATUS_LABEL[p._status] + '</span>' +
          '<img src="' + esc(imgSrc(p.image)) + '" alt="' + esc(p.imageAlt) + '" loading="lazy"></div>';
      } else {
        media = '<div class="project-media is-type"><span class="chip chip-' + p._status + '">' + STATUS_LABEL[p._status] + '</span>' +
          '<span class="type-date">' + esc(p.dateLabel || 'Coming soon') + '</span>' +
          (p.location ? '<span class="type-sub">' + esc(p.location) + '</span>' : '') + '</div>';
      }
      var href = safeUrl(p.ctaLink);
      var cta = (p.ctaLabel && href) ? '<a class="project-link" href="' + esc(href) + '"' + linkAttrs(href) + '>' + esc(p.ctaLabel) + icon('arrow-right') + '</a>' : '';
      return '<article class="project-card">' + media +
        '<div class="project-body"><div class="project-meta">' +
        (p.dateLabel ? '<span>' + icon('calendar') + esc(p.dateLabel) + '</span>' : '') +
        (p.location ? '<span>' + icon('pin') + esc(p.location) + '</span>' : '') +
        '</div><h3>' + esc(p.title) + '</h3><p>' + esc(p.summary) + '</p>' + cta + '</div></article>';
    }).join('');
  }

  function setupTabs() {
    var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
    function select(tab, focus) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.tabIndex = on ? 0 : -1;
      });
      $('#project-panel').setAttribute('aria-labelledby', tab.id);
      projectFilter = tab.getAttribute('data-filter');
      renderProjects();
      if (focus) tab.focus();
    }
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { select(t); });
      t.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          select(tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length], true);
        }
      });
    });
  }

  var galleryItems = [];
  function renderGallery(list) {
    galleryItems = (list || []).filter(function (g) { return g.image && imgSrc(g.image); });
    var sec = $('#gallery');
    if (!galleryItems.length) { sec.hidden = true; return; }
    sec.hidden = false;
    $('#gallery-grid').innerHTML = galleryItems.map(function (g, i) {
      return '<li class="reveal"><button type="button" data-index="' + i + '" aria-label="Open photo: ' + esc(g.caption || 'photo ' + (i + 1)) + '">' +
        '<img src="' + esc(imgSrc(g.image)) + '" alt="' + esc(g.caption) + '" loading="lazy">' +
        (g.caption ? '<span class="cap">' + esc(g.caption) + '</span>' : '') + '</button></li>';
    }).join('');
  }

  function setupLightbox() {
    var dlg = $('#lightbox');
    if (!dlg || typeof dlg.showModal !== 'function') return;
    var idx = 0, opener = null;
    function show(i) {
      idx = (i + galleryItems.length) % galleryItems.length;
      var g = galleryItems[idx];
      $('#lb-img').src = imgSrc(g.image);
      $('#lb-img').alt = g.caption || '';
      $('#lb-cap').textContent = g.caption || '';
    }
    $('#gallery-grid').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-index]');
      if (!b) return;
      opener = b;
      show(+b.getAttribute('data-index'));
      dlg.showModal();
      document.body.style.overflow = 'hidden';
    });
    dlg.addEventListener('close', function () { document.body.style.overflow = ''; if (opener) opener.focus(); });
    $('.lb-close', dlg).addEventListener('click', function () { dlg.close(); });
    $('.lb-prev', dlg).addEventListener('click', function () { show(idx - 1); });
    $('.lb-next', dlg).addEventListener('click', function () { show(idx + 1); });
    dlg.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') show(idx - 1);
      if (e.key === 'ArrowRight') show(idx + 1);
    });
    dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
    var x0 = null;
    dlg.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; }, { passive: true });
    dlg.addEventListener('touchend', function (e) {
      if (x0 === null) return;
      var dx = e.changedTouches[0].clientX - x0;
      if (Math.abs(dx) > 50) show(idx + (dx < 0 ? 1 : -1));
      x0 = null;
    });
  }

  var bankText = '';
  function renderDonate(d, contact) {
    d = d || {}; contact = contact || {};
    setText('donate-eyebrow', d.eyebrow || 'Give');
    setText('donate-title', d.heading);
    setText('donate-intro', d.intro);
    setText('donate-card-note', d.cardNote);
    $('#donate-funds').innerHTML = (d.funds || []).map(function (f) { return '<li>' + icon('check') + esc(f) + '</li>'; }).join('');
    var rows = [
      { label: 'Bank', value: d.bankName, copy: true },
      { label: 'Account name', value: d.accountName, copy: true },
      { label: 'Account number', value: d.accountNumber, copy: true, mono: true },
      { label: 'Account type', value: d.accountType },
      { label: 'Currency', value: d.currency },
      { label: 'SWIFT / BIC', value: d.swift, copy: true, mono: true }
    ].filter(function (r) { return r.value; });
    $('#bank-rows').innerHTML = rows.map(function (r) {
      return '<div class="bank-row"><div><dt>' + esc(r.label) + '</dt><dd' + (r.mono ? ' class="mono"' : '') + '>' + esc(r.value) + '</dd></div>' +
        (r.copy ? '<button type="button" class="copy-btn" data-copy="' + esc(r.value) + '" aria-label="Copy ' + esc(r.label.toLowerCase()) + '">' + icon('copy') + '<span>Copy</span></button>' : '') + '</div>';
    }).join('');
    bankText = rows.map(function (r) { return r.label + ': ' + r.value; }).join('\n');

    var contactBits = [];
    if (contact.phone) contactBits.push('<a href="' + esc(telHref(contact.phone)) + '">' + esc(contact.phone) + '</a>');
    if (contact.email) contactBits.push('<a href="mailto:' + esc(contact.email) + '">email us</a>');
    var steps = [
      ['Send your transfer', 'Use online banking or visit any branch, and send your gift to the account above.'],
      ['Add a note', d.referenceHint],
      ['Let us know', (d.afterText || '') + (contactBits.length ? ' ' : '')]
    ].filter(function (s) { return s[1]; });
    $('#give-steps').innerHTML = steps.map(function (s, i) {
      var extra = (i === steps.length - 1 && contactBits.length) ? contactBits.join(' or ') + '.' : '';
      return '<li><span><strong>' + esc(s[0]) + '</strong>' + esc(s[1]) + extra + '</span></li>';
    }).join('') + (d.internationalText ? '<li><span><strong>Giving from abroad?</strong>' + esc(d.internationalText.replace(/^Giving from abroad\?\s*/i, '')) + '</span></li>' : '');
  }

  function toast(msg) {
    var t = $('#toast');
    t.innerHTML = icon('check') + '<span>' + esc(msg) + '</span>';
    t.classList.add('is-visible');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('is-visible'); }, 2200);
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy') ? resolve() : reject(); } catch (e) { reject(e); }
      document.body.removeChild(ta);
    });
  }
  function setupCopy() {
    $('#bank-rows').addEventListener('click', function (e) {
      var b = e.target.closest('.copy-btn');
      if (!b) return;
      copyText(b.getAttribute('data-copy')).then(function () {
        b.classList.add('is-done');
        b.querySelector('span').textContent = 'Copied';
        setTimeout(function () { b.classList.remove('is-done'); b.querySelector('span').textContent = 'Copy'; }, 1800);
        toast('Copied to clipboard');
      }, function () { toast('Press and hold to copy'); });
    });
    $('#copy-all').addEventListener('click', function () {
      copyText(bankText).then(function () { toast('All bank details copied'); }, function () { toast('Press and hold to copy'); });
    });
  }

  function renderInvolved(list) {
    $('#involve-grid').innerHTML = (list || []).map(function (c) {
      var href = safeUrl(c.ctaLink);
      return '<li class="involve-card reveal"><div class="program-icon">' + icon(c.icon || 'hands') + '</div>' +
        '<h3>' + esc(c.title) + '</h3><p>' + esc(c.text) + '</p>' +
        (c.ctaLabel && href ? '<a href="' + esc(href) + '"' + linkAttrs(href) + '>' + esc(c.ctaLabel) + icon('arrow-right') + '</a>' : '') + '</li>';
    }).join('');
  }

  function renderContact(c) {
    c = c || {};
    var items = [];
    if (c.phone) items.push('<li>' + icon('phone') + '<a href="' + esc(telHref(c.phone)) + '">' + esc(c.phone) + '</a></li>');
    if (c.email) items.push('<li>' + icon('mail') + '<a href="mailto:' + esc(c.email) + '">' + esc(c.email) + '</a></li>');
    if (c.address) {
      var map = safeUrl(c.mapLink);
      items.push('<li>' + icon('pin') + (map ? '<a href="' + esc(map) + '" target="_blank" rel="noopener">' + esc(c.address) + '</a>' : '<span>' + esc(c.address) + '</span>') + '</li>');
    }
    $('#footer-contact').innerHTML = items.join('');
    var socials = [['facebook', 'Facebook'], ['instagram', 'Instagram'], ['youtube', 'YouTube'], ['tiktok', 'TikTok']];
    $('#footer-social').innerHTML = socials.filter(function (s) { return safeUrl(c[s[0]]); }).map(function (s) {
      return '<li><a href="' + esc(safeUrl(c[s[0]])) + '" target="_blank" rel="noopener" aria-label="' + s[1] + '">' + icon(s[0]) + '</a></li>';
    }).join('');
  }

  /* ---------- Behaviour ---------- */
  function countUp(el) {
    var raw = el.getAttribute('data-count') || '';
    var m = raw.match(/^([^\d]*)([\d,]+(?:\.\d+)?)(.*)$/);
    if (!m || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var target = parseFloat(m[2].replace(/,/g, ''));
    var commas = m[2].indexOf(',') !== -1;
    var start = null, dur = 1400;
    function fmt(n) { n = Math.round(n); return commas ? n.toLocaleString('en-US') : String(n); }
    function step(ts) {
      if (!start) start = ts;
      var p = Math.min((ts - start) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = m[1] + fmt(target * eased) + m[3];
      if (p < 1) requestAnimationFrame(step); else el.textContent = raw;
    }
    el.textContent = m[1] + '0' + m[3];
    requestAnimationFrame(step);
  }

  var revealObserver = null;
  function setupReveal() {
    var els = document.querySelectorAll('.reveal:not(.is-in)');
    if (!('IntersectionObserver' in window)) {
      Array.prototype.forEach.call(els, function (el) { el.classList.add('is-in'); });
      return;
    }
    if (!revealObserver) {
      revealObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          e.target.classList.add('is-in');
          var c = e.target.querySelector('[data-count]');
          if (c) countUp(c);
          revealObserver.unobserve(e.target);
        });
      }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
    }
    Array.prototype.forEach.call(els, function (el, i) {
      el.style.transitionDelay = (el.classList.contains('stat') || el.parentElement.classList.contains('gallery') || el.classList.contains('involve-card') ? (i % 4) * 90 : 0) + 'ms';
      revealObserver.observe(el);
    });
  }

  function setupChrome() {
    var hero = $('.hero');
    var bar = $('.mini-bar');
    var giveBar = $('#give-bar');
    var donate = $('#donate');
    var heroGone = false, donateVisible = false;
    giveBar.hidden = false;
    function update() {
      bar.classList.toggle('is-visible', heroGone);
      if (heroGone) { bar.removeAttribute('aria-hidden'); bar.removeAttribute('inert'); }
      else { bar.setAttribute('aria-hidden', 'true'); bar.setAttribute('inert', ''); }
      var showGive = heroGone && !donateVisible;
      giveBar.classList.toggle('is-visible', showGive);
      if (showGive) giveBar.removeAttribute('inert'); else giveBar.setAttribute('inert', '');
    }
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (en) { heroGone = !en[0].isIntersecting; update(); }, { rootMargin: '-80px 0px 0px 0px' }).observe(hero);
      new IntersectionObserver(function (en) { donateVisible = en[0].isIntersecting; update(); }).observe(donate);

      // Highlight the section currently in the middle of the screen in the compact bar
      var links = document.querySelectorAll('.mini-nav a');
      var active = new IntersectionObserver(function (en) {
        en.forEach(function (e) {
          if (!e.isIntersecting) return;
          Array.prototype.forEach.call(links, function (a) { a.classList.toggle('is-active', a.getAttribute('href') === '#' + e.target.id); });
        });
      }, { rootMargin: '-45% 0px -50% 0px' });
      Array.prototype.forEach.call(links, function (a) {
        var s = document.querySelector(a.getAttribute('href'));
        if (s) active.observe(s);
      });
    }

    // Mobile menu
    var menu = $('#mobile-menu');
    var toggles = document.querySelectorAll('.menu-toggle');
    var lastToggle = null;
    var behind = [document.getElementById('main'), document.querySelector('.site-footer'), giveBar];
    function setMenu(open, from, restoreFocus) {
      menu.hidden = !open;
      document.body.classList.toggle('menu-open', open);
      // Keep keyboard focus inside the open menu
      behind.forEach(function (n) { if (n) { if (open) n.setAttribute('inert', ''); else if (n !== giveBar) n.removeAttribute('inert'); } });
      if (!open) update();
      Array.prototype.forEach.call(toggles, function (t) {
        t.setAttribute('aria-expanded', open ? 'true' : 'false');
        t.querySelector('.sr-only').textContent = open ? 'Close menu' : 'Open menu';
      });
      if (open) { lastToggle = from; var first = menu.querySelector('a'); if (first) first.focus(); }
      else if (restoreFocus !== false && lastToggle) lastToggle.focus();
    }
    Array.prototype.forEach.call(toggles, function (t) {
      t.addEventListener('click', function () { setMenu(menu.hidden, t); });
    });
    menu.addEventListener('click', function (e) { if (e.target.closest('a')) setMenu(false, null, false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !menu.hidden) setMenu(false); });
    window.addEventListener('resize', function () { if (window.innerWidth > 900 && !menu.hidden) setMenu(false); });
  }

  /* ---------- Boot ---------- */
  function render(c) {
    renderMeta(c);
    renderHero(c.hero);
    renderNextUp(c.projects);
    renderStats(c.stats);
    renderAbout(c.about);
    renderPrograms(c.programs);
    renderStory(c.story);
    renderReflection(c.reflection);
    allProjects = c.projects || [];
    renderProjects();
    renderGallery(c.gallery);
    renderDonate(c.donate, c.contact);
    renderInvolved(c.involved);
    renderContact(c.contact);
    setupReveal();
  }

  function boot() {
    setText('year', String(new Date().getFullYear()));
    setupTabs();
    setupLightbox();
    setupCopy();
    setupChrome();

    // Live preview from the admin panel: content is posted in from the opener window.
    var previewing = false;
    if (/[?&]preview=1/.test(location.search) && window.opener) {
      window.addEventListener('message', function (e) {
        if (e.origin !== location.origin || !e.data || e.data.type !== 'cda-preview') return;
        previewing = true;
        previewImages = e.data.images || {};
        render(e.data.content);
        Array.prototype.forEach.call(document.querySelectorAll('.reveal'), function (el) { el.classList.add('is-in'); });
      });
      window.opener.postMessage({ type: 'cda-preview-ready' }, location.origin);
    }

    fetch(CONTENT_URL, { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (c) { if (!previewing) render(c); })
      .catch(function (err) {
        console.error('Could not load site content:', err);
        $('#main').insertAdjacentHTML('afterbegin', '<p class="container" style="padding:16px 0;color:#5B6472">Some content could not be loaded. Please refresh the page.</p>');
      });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
