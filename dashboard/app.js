// Token Radar's dashboard. It reads window.RADAR (written beside dashboard/ by main.ts) and
// renders the ranked board, a filterable table, a per-protocol detail view and the live-token
// set. No network: every byte it shows is in data.js, and every farm plan on screen is the
// board.json plan itself, so page and board cannot disagree.
//
// Views, by query string (Microlink and deep links alike):
//   ?view=board                                   the ranked board (default)
//   ?view=detail&protocol=<slug>                  one protocol's detail as a full page
//   ?view=filtered&chain=<chain>&sort=<key>       the board with a filter applied
// A row click opens the same detail in a dialog; #p=<slug> opens it too.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('main');
  var watchlist = new Set(DATA.watchlist_slugs || []);
  var params = new URLSearchParams(window.location.search);
  var view = params.get('view') || 'board';
  var detailSlug = params.get('protocol') || null;
  var state = {
    q: params.get('q') || '',
    chain: params.get('chain') || 'all',
    category: params.get('category') || 'all',
    watchlistOnly: params.get('watchlist') === '1',
    minValue: params.get('min_value') || '0',
    sort: params.get('sort') || 'implied',
    dir: -1,
    tab: params.get('tab') || 'pre-token',
    selected: null
  };

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtMult(n) { return 'x' + n.toFixed(2); }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function rowBySlug(slug) {
    for (var i = 0; i < DATA.rows.length; i++) if (DATA.rows[i].slug === slug) return DATA.rows[i];
    return null;
  }
  function chainsOf(r) { return (r.chains && r.chains.length ? r.chains.join(', ') : 'an unnamed chain'); }
  function isWatchlist(r) { return watchlist.has(r.slug); }

  // -- filtering and sorting -------------------------------------------------
  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    var min = Number(state.minValue) || 0;
    return DATA.rows.filter(function (r) {
      if (state.chain !== 'all' && (!r.chains || r.chains.indexOf(state.chain) < 0)) return false;
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.watchlistOnly && !isWatchlist(r)) return false;
      if (r.implied_value_usd < min) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  // -- shared chrome ---------------------------------------------------------
  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' },
        el('span', { class: 'mark', 'aria-hidden': 'true' }),
        el('span', { class: 'brand-name' }, 'Token ', el('em', { text: 'Radar' }))
      ),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: 'DefiLlama protocol index' }),
        el('span', { text: DATA.model_version + ' model' })
      )
    );
  }
  function footer() {
    return el('footer', { class: 'foot' },
      el('p', null,
        el('b', { text: 'Data: ' }), 'DefiLlama protocol index as of ' + DATA.as_of + ', frozen in the sealed snapshot. '
        + 'Implied value is this radar\u2019s model estimate, not a price and not a promise: it says what a token would be worth if it traded like the tokens that already trade in its category. '
        + 'Nothing on this page is financial advice.'
      ),
      el('p', null,
        el('b', { text: 'Method: ' }), 'comps-calibrated implied value — category median market-cap-per-TVL among live tokens, shrunk to the global median of '
        + fmtMult(DATA.global_multiple) + ' — times seven-day growth, time listed with no token, an early-compounding boost and multi-chain breadth. '
        + 'Live-token protocols are set aside at their market value and never ranked.'
      )
    );
  }

  // -- board view ------------------------------------------------------------
  function lede() {
    var top = DATA.rows[0];
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: DATA.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        el('p', null,
          'The watchlist is the floor: every protocol with at least ', el('b', { text: '$' + Math.round(DATA.floor_usd / 1e6) + 'M' }),
          ' of TVL and no token on record. The early radar adds ', el('b', { text: String(DATA.early_size) + ' pre-token protocols' }),
          ' below that floor, ranked by the same model. Strongest first: ',
          el('b', { text: top ? top.name : '—' }), top ? ' at ' + fmtUsd(top.implied_value_usd) + ' implied.' : ''
        )
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows scored' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Top implied value' }), el('b', { text: top ? fmtUsd(top.implied_value_usd) : 'n/a' })),
        el('div', { class: 'fact' }, el('span', { text: 'Global comp multiple' }), el('b', { text: fmtMult(DATA.global_multiple) }))
      )
    );
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (acc, r) { return acc.concat(r.chains || []); }, []))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; render(); });
    var chainSel = el('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return el('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null }); })
    );
    chainSel.addEventListener('change', function () { state.chain = chainSel.value; render(); });
    var catSel = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); })
    );
    catSel.addEventListener('change', function () { state.category = catSel.value; render(); });
    var minSel = el('select', { id: 'min_value', 'aria-label': 'Minimum implied value' },
      [['0', 'Any implied value'], ['100000000', 'Implied $100M+'], ['500000000', 'Implied $500M+'], ['1000000000', 'Implied $1B+']].map(function (o) {
        return el('option', { value: o[0], text: o[1], selected: o[0] === state.minValue ? 'selected' : null });
      })
    );
    minSel.addEventListener('change', function () { state.minValue = minSel.value; render(); });
    var sortSel = el('select', { id: 'sort', 'aria-label': 'Sort the board' },
      [['implied', 'Sort: implied value'], ['tvl', 'Sort: TVL'], ['growth', 'Sort: 7d growth'], ['age', 'Sort: age'], ['name', 'Sort: name']].map(function (o) {
        return el('option', { value: o[0], text: o[1], selected: o[0] === state.sort ? 'selected' : null });
      })
    );
    sortSel.addEventListener('change', function () { state.sort = sortSel.value; state.dir = -1; render(); });
    var wl = el('input', { type: 'checkbox', id: 'watchlist', checked: state.watchlistOnly ? 'checked' : null });
    wl.addEventListener('change', function () { state.watchlistOnly = wl.checked; render(); });
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre-token'; render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; render(); } });
    var count = state.tab === 'pre-token'
      ? filteredRows().length + ' of ' + DATA.board_size + ' rows shown'
      : DATA.live.length + ' live-token protocols';
    if (view === 'filtered') count = 'Filtered view: ' + count;
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chainSel),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), catSel),
      el('div', { class: 'field' }, el('label', { for: 'min_value', text: 'Implied value' }), minSel),
      el('div', { class: 'field' }, el('label', { for: 'sort', text: 'Sort' }), sortSel),
      el('label', { class: 'check', for: 'watchlist' }, wl, 'Watchlist only'),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Token status' }), el('div', { class: 'tabs' }, pre, live)),
      el('span', { class: 'count', text: count })
    );
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }

  function boardTable() {
    var list = sortedRows(filteredRows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another chain, category or value to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.chain = 'all'; state.category = 'all'; state.minValue = '0'; state.watchlistOnly = false; render(); } })
      ));
    }
    var max = list[0].implied_value_usd || 1;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name + (isWatchlist(r) ? ' ★' : '') }),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        )),
        el('td', null, el('span', { class: 'status', text: 'no token' }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. ★ marks the watchlist. Select a row for its model and farm plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('implied', 'Implied value'),
            el('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: 'live' }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + chainsOf(r) }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', null, el('span', { class: 'status live', text: 'already trades' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  function modelPanel() {
    var m = DATA.model;
    var comps = DATA.comps.slice(0, 8);
    var tbody = el('tbody');
    comps.forEach(function (c) {
      tbody.appendChild(el('tr', null,
        el('td', { text: c.category }),
        el('td', { class: 'num', text: String(c.n) }),
        el('td', { class: 'num', text: fmtMult(c.median) }),
        el('td', { class: 'num', text: fmtMult(c.multiple) })
      ));
    });
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed' }),
      el('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked. The comps multiple is the category median market-cap-per-TVL among the tokens that already trade, shrunk toward the global median of ' + fmtMult(DATA.global_multiple) + ' when a category has few live comps, clamped to x0.05–x1.50.' }),
      el('div', { class: 'formula' },
        'implied = round( tvl_usd x comps_multiple x (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_weight + ') x (' + m.maturity_floor + ' + min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + ' x ' + m.maturity_range + ') x early x breadth )'
      ),
      el('p', { class: 'sub', text: 'Early is x' + m.early_boost + ' when a protocol is under ' + m.early_age_days + ' days old and growing over ' + m.early_growth_pct + '%; breadth adds x' + m.breadth_per_chain + ' per extra chain, up to ' + m.breadth_max_chains + '. Age is the time since first listing; an unlisted age uses ' + m.unknown_age_days + ' days.' }),
      el('div', { class: 'table-wrap' },
        el('table', { class: 'comps' },
          el('caption', { class: 'sub', text: 'Comps by category: live-token protocols counted, their median market-cap-per-TVL, and the multiple the model applies.' }),
          el('thead', null, el('tr', null,
            el('th', { scope: 'col', text: 'Category' }),
            el('th', { scope: 'col', class: 'num', text: 'Live comps' }),
            el('th', { scope: 'col', class: 'num', text: 'Median' }),
            el('th', { scope: 'col', class: 'num', text: 'Multiple applied' })
          )),
          tbody
        )
      )
    );
  }

  // -- detail view -----------------------------------------------------------
  function detailBody(row) {
    var steps = row.farm_steps || [];
    return [
      el('div', { class: 'detail-head' },
        el('div', null,
          el('span', { class: 'kicker', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + (isWatchlist(row) ? ' · on the watchlist' : ' · early radar') }),
          el('h2', { id: 'detail-title', text: row.name }),
          el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + chainsOf(row) + ' · listed ' + (row.listed_at || 'on an unknown date') + ' · records no token' })
        )
      ),
      el('section', { class: 'detail-section' },
        el('h3', { text: 'Implied value' }),
        el('div', { class: 'equation' },
          el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
          el('div', null, el('span', { text: 'Comps multiple' }), el('b', { class: 'num', text: fmtMult(row.comp_multiple) + ' (' + row.comp_n + ' comps)' })),
          el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { class: 'num', text: fmtPct(row.change_7d) })),
          el('div', null, el('span', { text: 'Growth multiplier' }), el('b', { class: 'num', text: fmtMult(row.growth_multiplier) })),
          el('div', null, el('span', { text: 'Age with no token' }), el('b', { class: 'num', text: fmtAge(row.age_days) })),
          el('div', null, el('span', { text: 'Maturity multiplier' }), el('b', { class: 'num', text: fmtMult(row.maturity_multiplier) })),
          el('div', null, el('span', { text: 'Early × breadth' }), el('b', { class: 'num', text: fmtMult(row.early_multiplier) + ' × ' + fmtMult(row.breadth_multiplier) })),
          el('div', { class: 'total' }, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) }))
        ),
        el('p', { class: 'sub', text: 'Model ' + DATA.model_version + ': the same function scores every protocol, and the comps multiple is the category median market-cap-per-TVL among the tokens that already trade. This is an estimate, not a price.' })
      ),
      el('section', { class: 'detail-section' },
        el('h3', { text: 'Farm plan — 7 steps' }),
        el('ol', { class: 'steps' }, steps.map(function (s) {
          var at = s.indexOf(' Cost: ');
          var action = at >= 0 ? s.slice(0, at) : s;
          var tail = at >= 0 ? s.slice(at + 1) : '';
          return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
        }))
      )
    ];
  }

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; });

  function openDetail(slug) {
    var row = rowBySlug(slug);
    if (!row) return;
    state.selected = slug;
    dialog.textContent = '';
    var parts = detailBody(row);
    var head = parts[0];
    head.appendChild(el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } }));
    parts.forEach(function (p) { dialog.appendChild(p); });
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function detailPage(row) {
    return el('div', { class: 'detail-page' },
      el('a', { class: 'button back', href: './', text: '← Back to the board' }),
      el('div', { class: 'panel' }, detailBody(row))
    );
  }

  // -- render ----------------------------------------------------------------
  function renderBoard() {
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'pre-token' ? boardTable() : liveTable());
    if (state.tab === 'pre-token') shell.appendChild(modelPanel());
    shell.appendChild(footer());
    app.appendChild(shell);
    if (!dialog.isConnected) app.appendChild(dialog);
    var hash = window.location.hash.replace(/^#/, '');
    if (hash) {
      var hp = new URLSearchParams(hash);
      if (hp.get('p')) openDetail(hp.get('p'));
    }
  }

  function render() {
    app.textContent = '';
    if (view === 'detail' && detailSlug) {
      var row = rowBySlug(detailSlug);
      var shell = el('div', { class: 'shell' });
      shell.appendChild(header());
      if (row) shell.appendChild(detailPage(row));
      else shell.appendChild(el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol with that slug' }),
        el('p', { text: 'The detail link names a protocol this snapshot does not carry.' }),
        el('a', { class: 'button primary', href: './', text: 'Back to the board' })
      )));
      shell.appendChild(footer());
      app.appendChild(shell);
    } else {
      renderBoard();
    }
    app.setAttribute('aria-busy', 'false');
  }

  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
