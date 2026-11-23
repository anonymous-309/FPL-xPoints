// Backups: with ?archive=<season>/gw<N> a page reads the copy saved before that gameweek's deadline
// (archive/<season>/gw<N>/<file>.gz) instead of the live file, and says so at the top.
(function () {
  'use strict';
  const m = /[?&]archive=([0-9-]+\/(?:replay\/)?gw\d+)/.exec(location.search);
  const path = m ? m[1] : null;
  window.SITE_ARCHIVE = path;
  window.siteFetch = function (name, opts) {
    if (!path) return fetch(name, opts);
    return fetch(`archive/${path}/${name}.gz`, opts).then((r) => {
      if (!r.ok) return r;
      // GitHub Pages may already have unzipped it (served with Content-Encoding); otherwise unzip here
      return r.arrayBuffer().then((buf) => {
        const b = new Uint8Array(buf);
        if (!(b[0] === 0x1f && b[1] === 0x8b)) return new Response(buf, { status: 200 });
        return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip')), { status: 200 });
      });
    });
  };
  if (!path) return;
  const show = () => {
    const parts = path.split('/');
    const season = parts[0], gw = parts[parts.length - 1], replay = parts.includes('replay');
    const bar = document.createElement('div');
    bar.className = 'backup-bar';
    bar.innerHTML = replay
      ? `Replay of <b>${gw.toUpperCase()}</b> (${season}): the site as it would have been before that deadline with today's formulas, rebuilt <span class="backup-when"></span> · <a href="${location.pathname}">Back to live</a>`
      : `Backup of <b>${gw.toUpperCase()}</b> (${season}), saved before the deadline <span class="backup-when"></span> · <a href="${location.pathname}">Back to live</a>`;
    fetch(`archive/${path}/saved_at.txt`).then((r) => (r.ok ? r.text() : '')).then((t) => {
      if (t.trim()) bar.querySelector('.backup-when').textContent = `at ${new Date(t.trim()).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`;
    }).catch(() => {});
    const head = document.querySelector('header');
    if (head) head.after(bar); else document.body.prepend(bar);
    // keep the backup when moving between the pages that have it
    document.addEventListener('click', (e) => {
      const a = e.target.closest('a[href]');
      if (!a) return;
      const href = a.getAttribute('href');
      if (/^(index|minutes|teamnews)\.html$/.test(href)) a.setAttribute('href', `${href}?archive=${path}`);
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show); else show();
})();
