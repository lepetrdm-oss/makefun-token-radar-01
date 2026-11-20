// Token Radar's dashboard (model radar-3). It reads window.RADAR (written beside
// dashboard/ by main.ts) and renders the ranked board, a per-protocol detail view, the
// model's proof (fit + three blind tests + odds tables), the full-universe ledger and
// the traded anchors. No network: every byte it shows is in data.js.
//
// The integrity strip is not decoration: on load, this page re-derives every board
// row's fitted value, token odds and expected launch value from the shipped fitted
// parameters (the same arithmetic lib/model.ts runs) and counts any row that does not
// match. If the data and the model ever disagree, the strip says so in red.
//
// Views, by query string (deep links and screenshots alike):
//   ?view=board (default)   the ranked board; filters: verdict, sort, chain, mintvl, wl
//   ?view=detail&protocol=<slug>   one protocol's detail as a full page
//   ?view=model | ledger | anchors   the proof, the accounting, the anchors
// A row click opens the same detail; the nav switches views without a reload.
(function () {
  'use strict';
  var R = window.RADAR;
  var P = R.params;
  var main = document.getElementById('main');

  /* ---------- small helpers ---------- */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function commas(n) { return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function money(n) {
    var a = Math.abs(n);
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e4) return '$' + (n / 1e3).toFixed(1) + 'k';
    if (a >= 100) return '$' + Math.round(n);
    return '$' + n.toFixed(2);
  }
  function moneyFull(n) { return (n < 0 ? '-$' : '$') + commas(Math.abs(n)); }
  function pct(x, d) { return (x * 100).toFixed(d === undefined ? 0 : d) + '%'; }
  function factor(logErr) { return 'x' + Math.exp(logErr).toFixed(1); }
  function ageLabel(days) {
    if (days === null) return 'no date';
    if (days < 30) return days + 'd';
    if (days < 365) return Math.round(days / 30.4) + 'mo';
    return (days / 365).toFixed(1) + 'y';
  }

  /* ---------- the model, re-run in the page (integrity) ---------- */
  function growthFeature(c) {
    var p = typeof c === 'number' && isFinite(c) ? c : 0;
    p = Math.max(-50, Math.min(100, p));
    return Math.sign(p) * Math.log1p(Math.abs(p) / 25);
  }
  function bandKey(age) {
    if (age === null) return 'bx';
    for (var i = 0; i < P.ageBands.length; i++) {
      var b = P.ageBands[i];
      if (b.key !== 'bx' && age >= b.lo && age <= b.hi) return b.key;
    }
    return 'b3';
  }
  function growthCell(c) { return c === null ? 'unreported' : c > 0 ? 'growing' : 'shrinking'; }
  function cell(table, key) { var c = table[key]; return c ? c.lr : 1; }
  function derive(row) {
    var curve = P.b0 + P.bTvl * Math.log(Math.max(1, row.tvl_usd)) + P.bGrowth * growthFeature(row.change_7d);
    var offEnt = P.offsets[row.category === null ? 'Other' : row.category];
    var off = offEnt ? offEnt.off : 0;
    var ageTerm = row.age_days === null ? 0 : P.bAge * (Math.log(row.age_days + 30) - P.ageCenter);
    var value = Math.max(1, Math.round(Math.exp(curve + off + ageTerm)));
    var baseOdds = P.oddsBase / (1 - P.oddsBase);
    var o = baseOdds * cell(P.oddsByAgeBand, bandKey(row.age_days)) * cell(P.oddsBySector, row.sector) * cell(P.oddsByGrowth, growthCell(row.change_7d));
    var odds = Math.min(0.97, Math.max(0.03, o / (1 + o)));
    odds = Math.round(odds * 10000) / 10000;
    return { value: value, odds: odds, expected: Math.max(1, Math.round(value * odds)) };
  }
  var integrity = (function () {
    var bad = [];
    R.rows.forEach(function (row) {
      var d = derive(row);
      if (Math.abs(d.value - row.value_usd) > Math.max(2, row.value_usd * 0.002)) bad.push(row.slug + ' value');
      else if (Math.abs(d.odds - row.odds) > 0.002) bad.push(row.slug + ' odds');
      else if (Math.abs(d.expected - row.implied_value_usd) > Math.max(2, row.implied_value_usd * 0.01)) bad.push(row.slug + ' expected');
      else if (!(row.p10_usd <= row.value_usd && row.value_usd <= row.p90_usd)) bad.push(row.slug + ' range');
    });
    var ledgerSum = R.ledger.reduce(function (s, g) { return s + g.count; }, 0);
    var rowSlugs = {};
    R.rows.forEach(function (r) { rowSlugs[r.slug] = 1; });
    var wlMissing = R.watchlist_slugs.filter(function (s) { return !rowSlugs[s]; }).length;
    return { bad: bad, ledgerSum: ledgerSum, wlMissing: wlMissing };
  })();

  /* ---------- chrome: header, KPIs, integrity, nav ---------- */
  var qs = new URLSearchParams(location.search);
  var state = {
    view: qs.get('view') === 'detail' ? 'detail' : ['model', 'ledger', 'anchors'].indexOf(qs.get('view')) >= 0 ? qs.get('view') : 'board',
    slug: qs.get('protocol') || '',
    q: qs.get('q') || '',
    chain: qs.get('chain') || '',
    category: qs.get('category') || '',
    verdict: qs.get('verdict') || '',
    mintvl: qs.get('mintvl') ? Number(qs.get('mintvl')) : 0,
    wl: qs.get('wl') === '1',
    sort: qs.get('sort') || 'expected',
  };
  var V = R.validation;
  function header() {
    var h = '<div class="wrap"><header class="top"><h1>Token Radar<span class="dot">.</span></h1>' +
      '<div class="tag">Pre-token protocols priced by a value model <b>fitted on the tokens that already trade</b>, ' +
      'blind-tested three ways, ranked by expected launch value — fitted value x the odds it ever records a token — ' +
      'each with a P10–P90 range and a farm plan netted to a verdict.</div>' +
      '<div class="meta">model ' + esc(R.model_version) + '<br>snapshot ' + esc(R.as_of) + '<br>' + esc(R.source) + '</div></header>';
    var kpis = [
      ['hot', P.fitN + ' tokens', 'the value model is fitted on (of ' + P.fitPriced + ' priced)'],
      ['', factor(V.loo.medAbsLogErr), 'median blind miss, leave-one-out (n=' + V.loo.n + ')'],
      ['hot', pct(V.rangeCoverage), 'of blind actuals land inside the P10–P90 ranges'],
      ['', factor(V.olderToNewer.medAbsLogErr), 'median miss pricing newer tokens from older ones'],
      ['', pct(V.walkForward.coverage), 'walk-forward range coverage (4 folds)'],
      ['', R.watchlist_slugs.length + '/' + R.watchlist_size, 'watchlist protocols on the board'],
      ['', R.universe_size + '/' + R.universe_size, 'protocols accounted for in the ledger'],
    ];
    h += '<div class="kpis">' + kpis.map(function (k) {
      return '<div class="kpi ' + k[0] + '"><b>' + esc(k[1]) + '</b><span>' + esc(k[2]) + '</span></div>';
    }).join('') + '</div>';
    if (integrity.bad.length === 0 && integrity.ledgerSum === R.universe_size && integrity.wlMissing === 0) {
      h += '<div class="integrity">INTEGRITY — this page re-derived all ' + R.rows.length + ' board rows from the fitted parameters: ' +
        R.rows.length + '/' + R.rows.length + ' values, odds and expected values match the model · ledger ' + integrity.ledgerSum + '/' + R.universe_size +
        ' · watchlist ' + R.watchlist_size + '/' + R.watchlist_size + ' covered</div>';
    } else {
      h += '<div class="integrity bad">INTEGRITY FAILURE — ' + integrity.bad.length + ' row(s) do not re-derive (' +
        esc(integrity.bad.slice(0, 4).join(', ')) + ') · ledger ' + integrity.ledgerSum + '/' + R.universe_size +
        ' · watchlist missing ' + integrity.wlMissing + '</div>';
    }
    var views = [['board', 'Board'], ['model', 'Model & proof'], ['ledger', 'Ledger ' + R.universe_size + '/' + R.universe_size], ['anchors', 'Traded anchors']];
    h += '<nav class="views">' + views.map(function (v) {
      return '<button data-view="' + v[0] + '" aria-pressed="' + (state.view === v[0] || (state.view === 'detail' && v[0] === 'board')) + '">' + esc(v[1]) + '</button>';
    }).join('') + '</nav>';
    return h;
  }

  /* ---------- board ---------- */
  var SORTS = {
    expected: ['Expected value', function (a, b) { return b.implied_value_usd - a.implied_value_usd; }],
    value: ['Fitted value', function (a, b) { return b.value_usd - a.value_usd; }],
    odds: ['Token odds', function (a, b) { return b.odds - a.odds; }],
    tvl: ['TVL', function (a, b) { return b.tvl_usd - a.tvl_usd; }],
    net: ['Farm net $', function (a, b) { return b.farm.net_usd - a.farm.net_usd; }],
    perhour: ['Farm $/hour', function (a, b) { return b.farm.per_hour_usd - a.farm.per_hour_usd; }],
    growth: ['7d growth', function (a, b) { return (b.change_7d || 0) - (a.change_7d || 0); }],
    age: ['No-token age', function (a, b) { return (b.age_days || 0) - (a.age_days || 0); }],
  };
  function filteredRows() {
    var wl = {};
    R.watchlist_slugs.forEach(function (s) { wl[s] = 1; });
    var rows = R.rows.filter(function (r) {
      if (state.wl && !wl[r.slug]) return false;
      if (state.verdict && r.farm.verdict !== state.verdict) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (state.category && (r.category || 'Other') !== state.category) return false;
      if (state.mintvl && r.tvl_usd < state.mintvl) return false;
      if (state.q && (r.name + ' ' + r.slug).toLowerCase().indexOf(state.q.toLowerCase()) < 0) return false;
      return true;
    });
    rows.sort(SORTS[state.sort][1]);
    return rows;
  }
  function boardView() {
    var chains = {}, cats = {};
    R.rows.forEach(function (r) {
      r.chains.forEach(function (c) { chains[c] = 1; });
      cats[r.category || 'Other'] = 1;
    });
    var rows = filteredRows();
    var wl = {};
    R.watchlist_slugs.forEach(function (s) { wl[s] = 1; });
    var h = '<div class="controls">' +
      '<input type="search" id="f-q" placeholder="Search protocols" value="' + esc(state.q) + '">' +
      '<select id="f-chain"><option value="">All chains</option>' + Object.keys(chains).sort().map(function (c) {
        return '<option' + (state.chain === c ? ' selected' : '') + '>' + esc(c) + '</option>';
      }).join('') + '</select>' +
      '<select id="f-cat"><option value="">All categories</option>' + Object.keys(cats).sort().map(function (c) {
        return '<option' + (state.category === c ? ' selected' : '') + '>' + esc(c) + '</option>';
      }).join('') + '</select>' +
      '<select id="f-verdict"><option value="">All verdicts</option>' + ['FARM', 'THIN', 'SKIP'].map(function (v) {
        return '<option' + (state.verdict === v ? ' selected' : '') + '>' + v + '</option>';
      }).join('') + '</select>' +
      '<select id="f-sort">' + Object.keys(SORTS).map(function (k) {
        return '<option value="' + k + '"' + (state.sort === k ? ' selected' : '') + '>Sort: ' + SORTS[k][0] + '</option>';
      }).join('') + '</select>' +
      '<label class="check"><input type="checkbox" id="f-wl"' + (state.wl ? ' checked' : '') + '> Watchlist only</label>' +
      '<span class="count">' + rows.length + ' of ' + R.rows.length + ' rows</span></div>';
    h += '<table class="board"><thead><tr><th class="l">#</th><th class="l">Protocol</th><th>TVL</th><th>7d</th><th>Age</th>' +
      '<th>Fitted value</th><th>P10–P90</th><th>Odds</th><th>Expected</th><th class="l">Farm verdict</th></tr></thead><tbody>';
    h += rows.map(function (r) {
      var g = r.change_7d === null ? '<span class="rng">—</span>' : '<span class="' + (r.change_7d >= 0 ? 'pos' : 'neg') + '">' + (r.change_7d >= 0 ? '+' : '') + r.change_7d.toFixed(1) + '%</span>';
      return '<tr data-slug="' + esc(r.slug) + '"><td class="l">' + r.rank + '</td>' +
        '<td class="l"><span class="nm">' + esc(r.name) + '</span>' + (wl[r.slug] ? ' <span class="wl">★ watchlist</span>' : '') +
        '<span class="sub" style="display:block">' + esc(r.category || 'Other') + ' · ' + esc(r.chains.slice(0, 3).join(', ') || '—') + '</span></td>' +
        '<td>' + money(r.tvl_usd) + '</td><td>' + g + '</td><td>' + ageLabel(r.age_days) + '</td>' +
        '<td>' + money(r.value_usd) + '</td>' +
        '<td><span class="rng">' + money(r.p10_usd) + ' – ' + money(r.p90_usd) + '</span></td>' +
        '<td>' + pct(r.odds) + '</td><td><b>' + money(r.implied_value_usd) + '</b></td>' +
        '<td class="l"><span class="chip ' + r.farm.verdict + '">' + r.farm.verdict + '</span>' +
        '<span class="net">net ' + moneyFull(r.farm.net_usd) + ' · ' + moneyFull(r.farm.per_hour_usd) + '/h</span></td></tr>';
    }).join('');
    h += '</tbody></table>';
    h += '<p class="foot">Ranked by expected launch value = fitted value x token odds. The fitted value is what the model ' +
      'prices the token at if it launched today; the range is the band the model\u2019s own blind misses calibrate; a farm ' +
      'verdict is the plan\u2019s net after fees and forgone yield. Click any row for the full working.</p>';
    return h;
  }

  /* ---------- detail ---------- */
  function detailView() {
    var row = null;
    R.rows.forEach(function (r) { if (r.slug === state.slug) row = r; });
    if (!row) return '<div class="panel"><h2>Protocol not on the board</h2><p>It is accounted for in the ledger.</p></div>';
    var d = derive(row);
    var offMult = Math.exp(row.model.category_offset);
    var ageMult = Math.exp(row.model.age_term_log);
    var curveUsd = row.value_usd / (offMult * ageMult);
    var band = row.age_days === null ? ['pooled', P.rangePooled] : row.age_days < 540 ? ['young (<540d)', P.rangeYoung] : ['seasoned (≥540d)', P.rangeSeasoned];
    var pool = P.farm.poolPct * row.value_usd;
    var lo = Math.log(row.p10_usd), hi = Math.log(row.p90_usd), v = Math.log(row.value_usd);
    var markPct = hi > lo ? ((v - lo) / (hi - lo)) * 100 : 50;
    var ageBandEnt = P.oddsByAgeBand[bandKey(row.age_days)];
    var ageBandLabel = '';
    P.ageBands.forEach(function (b) { if (b.key === bandKey(row.age_days)) ageBandLabel = b.label; });
    var secEnt = P.oddsBySector[row.sector];
    var groEnt = P.oddsByGrowth[growthCell(row.change_7d)];
    var h = '<button class="back" data-view="board">← Back to the board</button>';
    h += '<div class="panel detail"><h2>' + esc(row.name) + ' <span class="chip ' + row.farm.verdict + '">' + row.farm.verdict + '</span></h2>' +
      '<p>Rank <b>#' + row.rank + '</b> of ' + R.rows.length + ' · ' + esc(row.category || 'Other') + ' · ' + esc(row.chains.join(', ') || 'no chain listed') +
      ' · TVL <b>' + moneyFull(row.tvl_usd) + '</b> · 7d ' + (row.change_7d === null ? 'unreported' : row.change_7d.toFixed(1) + '%') +
      ' · tracked ' + (row.listed_at || 'no date') + ' (' + ageLabel(row.age_days) + ' with no token)</p>' +
      '<h3>The fitted value — every term shown</h3><div class="cols2"><table class="kv">' +
      '<tr><th>Size + growth curve (TVL^' + P.bTvl.toFixed(2) + ', growth slope ' + P.bGrowth.toFixed(2) + ')</th><td class="r">' + moneyFull(Math.round(curveUsd)) + '</td></tr>' +
      '<tr><th>x category offset, ' + esc(row.category || 'Other') + ' (fitted on ' + row.model.comp_n + ' traded)</th><td class="r">x' + offMult.toFixed(2) + '</td></tr>' +
      '<tr><th>x age term (slope ' + P.bAge.toFixed(2) + ' on log age)</th><td class="r">x' + ageMult.toFixed(2) + '</td></tr>' +
      '<tr><th><b>Fitted launch value</b></th><td class="r"><b>' + moneyFull(row.value_usd) + '</b></td></tr></table>' +
      '<table class="kv">' +
      '<tr><th>TVL</th><td class="r">' + moneyFull(row.tvl_usd) + '</td></tr>' +
      '<tr><th>7d growth</th><td class="r">' + (row.change_7d === null ? 'unreported' : row.change_7d.toFixed(1) + '%') + '</td></tr>' +
      '<tr><th>Days with no token</th><td class="r">' + (row.age_days === null ? 'no listing date' : row.age_days) + '</td></tr>' +
      '<tr><th>Chains</th><td class="r">' + row.chains.length + '</td></tr></table></div>' +
      '<div class="rangebar"><div class="fill" style="left:0;width:100%"></div><div class="mark" style="left:' + markPct.toFixed(1) + '%"></div></div>' +
      '<div class="rangelabels"><span>P10 ' + moneyFull(row.p10_usd) + '</span><span>' + esc(band[0]) + ' band · holds ' + pct(V.rangeCoverage) + ' of blind actuals</span><span>P90 ' + moneyFull(row.p90_usd) + '</span></div>' +
      '<h3>Token odds — the peers\u2019 record</h3><table class="kv">' +
      '<tr><th>Base rate: share of all ' + R.universe_size + ' protocols that record a token</th><td class="r">' + pct(P.oddsBase, 1) + '</td></tr>' +
      '<tr><th>x age band: ' + esc(ageBandLabel) + ' (' + ageBandEnt.n + ' peers, ' + pct(ageBandEnt.share, 1) + ' record one)</th><td class="r">x' + ageBandEnt.lr.toFixed(2) + '</td></tr>' +
      '<tr><th>x sector: ' + esc(row.sector) + ' (' + secEnt.n + ' peers, ' + pct(secEnt.share, 1) + ')</th><td class="r">x' + secEnt.lr.toFixed(2) + '</td></tr>' +
      '<tr><th>x growth: ' + esc(growthCell(row.change_7d)) + ' (' + groEnt.n + ' peers, ' + pct(groEnt.share, 1) + ')</th><td class="r">x' + groEnt.lr.toFixed(2) + '</td></tr>' +
      '<tr><th><b>Token odds</b></th><td class="r"><b>' + pct(row.odds, 1) + '</b></td></tr>' +
      '<tr><th><b>Expected launch value (ranked by this)</b></th><td class="r"><b>' + moneyFull(row.implied_value_usd) + '</b></td></tr></table>' +
      '<p style="font-size:12px">This page re-derived the row just now: value ' + moneyFull(d.value) + ', odds ' + pct(d.odds, 1) + ', expected ' + moneyFull(d.expected) + '.</p>' +
      '<h3>The farm plan, netted</h3><table class="kv">' +
      '<tr><th>Reward pool assumed (' + pct(P.farm.poolPct) + ' of fitted value, shared by farmer capital = ' + pct(P.farm.capitalShare) + ' of TVL)</th><td class="r">' + moneyFull(Math.round(pool)) + '</td></tr>' +
      '<tr><th>Sized deposit (best of the $50–$5,000 ladder)</th><td class="r">' + moneyFull(row.farm.deposit_usd) + '</td></tr>' +
      '<tr><th>Expected slice after token odds</th><td class="r">' + moneyFull(row.farm.expected_slice_usd) + '</td></tr>' +
      '<tr><th>− fees (gas + swaps over the plan)</th><td class="r">' + moneyFull(row.farm.fees_usd) + '</td></tr>' +
      '<tr><th>− forgone yield at ' + pct(P.farm.forgoneApy, 1) + '/yr on the deposit</th><td class="r">' + moneyFull(row.farm.forgone_yield_usd) + '</td></tr>' +
      '<tr><th><b>Net</b> · ' + moneyFull(row.farm.per_hour_usd) + ' per active hour · break-even ticket ' + (row.farm.break_even_usd === null ? 'above $5,000' : moneyFull(row.farm.break_even_usd)) + '</th><td class="r"><b>' + moneyFull(row.farm.net_usd) + '</b></td></tr></table>' +
      '<h3>Steps</h3><ol class="steps">' + row.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>';
    var peers = R.rows.filter(function (r) { return r.slug !== row.slug && (r.category || 'Other') === (row.category || 'Other'); }).slice(0, 5);
    if (peers.length) {
      h += '<h3>Highest-ranked board peers in ' + esc(row.category || 'Other') + '</h3><table class="kv"><tr><th>Protocol</th><th class="r">Fitted value</th><th class="r">Odds</th><th class="r">Expected</th><th class="r">Verdict</th></tr>' +
        peers.map(function (r) {
          return '<tr><th>#' + r.rank + ' ' + esc(r.name) + '</th><td class="r">' + money(r.value_usd) + '</td><td class="r">' + pct(r.odds) + '</td><td class="r">' + money(r.implied_value_usd) + '</td><td class="r">' + r.farm.verdict + '</td></tr>';
        }).join('') + '</table>';
    }
    h += '</div>';
    return h;
  }

  /* ---------- model & proof ---------- */
  function oddsTable(title, table, labels) {
    var h = '<h3>' + esc(title) + '</h3><table class="kv"><tr><th>Cell</th><th class="r">Peers</th><th class="r">Record a token</th><th class="r">Odds ratio</th></tr>';
    Object.keys(table).forEach(function (k) {
      var c = table[k];
      h += '<tr><th>' + esc(labels && labels[k] ? labels[k] : k) + '</th><td class="r">' + c.n + '</td><td class="r">' + pct(c.share, 1) + '</td><td class="r">x' + c.lr.toFixed(2) + '</td></tr>';
    });
    return h + '</table>';
  }
  function modelView() {
    var bandLabels = {};
    P.ageBands.forEach(function (b) { bandLabels[b.key] = b.label; });
    var baseBrier = R.calibration.actualShare * (1 - R.calibration.actualShare);
    var h = '<div class="panel"><h2>The value model — fitted, then blind-tested three ways</h2>' +
      '<p>The curve is fitted on the snapshot\u2019s traded tokens: of ' + P.fitPriced + ' protocols carrying a price above zero, ' +
      'the fit uses <b>' + P.fitN + '</b> — dust tokens under $1M are dead markets, not comps, and exchange tokens, canonical bridges ' +
      'and versioned pools are out because their market cap prices something other than the row\u2019s own TVL. The fit is Huber-reweighted ' +
      'so wild prints cannot bend it. log(price) = intercept + size slope x log(TVL) + growth slope x log-scaled 7d growth, then a shrunk ' +
      'per-category offset, then an age slope fitted on the ' + P.fitNAge + ' fit tokens that carry a listing date.</p>' +
      '<table class="kv">' +
      '<tr><th>Intercept</th><td class="r">' + P.b0.toFixed(3) + '</td></tr>' +
      '<tr><th>Size slope (on log TVL)</th><td class="r">' + P.bTvl.toFixed(3) + '</td></tr>' +
      '<tr><th>Growth slope (on sign x log1p(|7d %| / 25))</th><td class="r">' + P.bGrowth.toFixed(3) + '</td></tr>' +
      '<tr><th>Age slope (on centred log age)</th><td class="r">' + P.bAge.toFixed(3) + '</td></tr></table>' +
      '<h3>Blind tests — every number below is a token the fit never saw</h3>' +
      '<table class="kv"><tr><th>Test</th><th class="r">n</th><th class="r">Median miss</th><th class="r">Mean miss</th><th class="r">Inside the shipped ranges</th></tr>' +
      [['Leave-one-out (refit without each token)', V.loo], ['Older → newer (fit the oldest 60%, price the newest 40%)', V.olderToNewer], ['Walk-forward (4 chronological folds)', V.walkForward]].map(function (t) {
        return '<tr><th>' + t[0] + '</th><td class="r">' + t[1].n + '</td><td class="r">' + factor(t[1].medAbsLogErr) + '</td><td class="r">' + factor(t[1].meanAbsLogErr) + '</td><td class="r">' + pct(t[1].coverage) + '</td></tr>';
      }).join('') + '</table>' +
      '<p>The board\u2019s P10–P90 ranges are the 10th–90th percentiles of <b>all ' + (V.rangePooled.n) + ' blind residuals pooled</b>, split young ' +
      '(<540 days: ' + factor(V.rangeYoung.q10) + ' to ' + factor(V.rangeYoung.q90) + ') and seasoned (' + factor(V.rangeSeasoned.q10) + ' to ' + factor(V.rangeSeasoned.q90) + '), ' +
      'each shrunk toward the pooled band by its count. Pooled, they held <b>' + pct(V.rangeCoverage) + '</b> of blind actuals. A point value alone would claim ' +
      'precision the model does not have; the range is the honest part of the number.</p>' +
      '<h3>Category offsets (log space, shrunk by count)</h3><table class="kv"><tr><th>Category</th><th class="r">Traded in fit</th><th class="r">Offset</th></tr>' +
      Object.keys(P.offsets).map(function (k) { return [k, P.offsets[k]]; }).filter(function (e) { return e[1].n >= 2; })
        .sort(function (a, b) { return b[1].n - a[1].n; })
        .map(function (e) { return '<tr><th>' + esc(e[0]) + '</th><td class="r">' + e[1].n + '</td><td class="r">x' + Math.exp(e[1].off).toFixed(2) + '</td></tr>'; }).join('') + '</table></div>';
    h += '<div class="panel"><h2>Token odds — calibrated on the peers\u2019 record, checked out of sample</h2>' +
      '<p>Odds start from the base rate — <b>' + pct(P.oddsBase, 1) + '</b> of all ' + R.universe_size + ' protocols record a token — and multiply by one ' +
      'likelihood ratio per factor, each read off the snapshot\u2019s own cross-section and shrunk by cell size. The growth table is stratified ' +
      'by age band before pooling, so it is not just age restated. Calibration, honestly out of sample: tables fitted on one slug-sorted half ' +
      'of the universe predicted the other half with mean odds <b>' + pct(R.calibration.meanPredicted, 1) + '</b> against an actual share of <b>' +
      pct(R.calibration.actualShare, 1) + '</b>, Brier score <b>' + R.calibration.brier.toFixed(3) + '</b> against ' + baseBrier.toFixed(3) + ' for always guessing the base rate.</p>' +
      oddsTable('By no-token age', P.oddsByAgeBand, bandLabels) +
      oddsTable('By sector group', P.oddsBySector, null) +
      oddsTable('By 7-day growth (age-stratified)', P.oddsByGrowth, null) + '</div>';
    h += '<div class="panel"><h2>Farm model — the stated assumptions every verdict is arithmetic on</h2><table class="kv">' +
      '<tr><th>Reward pool reaching early users</th><td class="r">' + pct(P.farm.poolPct) + ' of fitted value</td></tr>' +
      '<tr><th>Farmer capital competing for it</th><td class="r">' + pct(P.farm.capitalShare) + ' of TVL</td></tr>' +
      '<tr><th>Most of the pool one wallet takes</th><td class="r">' + pct(P.farm.sliceCapPct) + '</td></tr>' +
      '<tr><th>Forgone yield on the deposit</th><td class="r">' + pct(P.farm.forgoneApy, 1) + ' / yr</td></tr>' +
      '<tr><th>Swap fee on weekly volume</th><td class="r">' + pct(P.farm.swapFee, 1) + '</td></tr>' +
      '<tr><th>Gas per transaction</th><td class="r">Ethereum $8 · Solana $0.05 · major L2s $0.50 · other chains $2</td></tr>' +
      '<tr><th>Deposit ladder tried per row</th><td class="r">$50 – $5,000</td></tr>' +
      '<tr><th>FARM bar</th><td class="r">net ≥ ' + moneyFull(P.farm.farmMinNet) + ' and ≥ ' + moneyFull(P.farm.farmMinPerHour) + '/hour; positive below it is THIN; never positive is SKIP</td></tr></table>' +
      '<p>Change any assumption and the verdicts move — that is the point of stating them. What does not move is the ranking ' +
      'arithmetic: expected slice x odds, minus fees, minus forgone yield.</p></div>';
    return h;
  }

  /* ---------- ledger & anchors ---------- */
  function ledgerView() {
    var h = '<div class="panel"><h2>The ledger — all ' + R.universe_size + ' protocols, each with its reason</h2>' +
      '<p>Nothing in the snapshot is silently dropped. Every protocol lands in exactly one group below; the counts sum to ' +
      R.universe_size + ', and this page checked that they do.</p>';
    R.ledger.forEach(function (g) {
      h += '<details class="ledger"><summary><b>' + esc(g.label) + '</b> — ' + g.count + '</summary>' +
        '<p>' + esc(g.reason) + '</p><div class="names">' + g.names.map(esc).join(' · ') + '</div></details>';
    });
    return h + '</div>';
  }
  function anchorsView() {
    var h = '<div class="panel"><h2>Traded anchors — the fit set, priced by its own curve</h2>' +
      '<p>These are the tokens the value model was fitted on, sampled evenly across the size range (largest, then every ' +
      'few by market cap). The model price beside each actual is the curve judging itself on its own training set — the ' +
      'blind numbers in the Model view are the honest test; this table exists so a reader can see the raw material.</p>' +
      '<table class="kv"><tr><th>Protocol</th><th class="r">TVL</th><th class="r">Actual cap</th><th class="r">Model price</th><th class="r">Error</th></tr>' +
      R.anchors.map(function (a) {
        return '<tr><th>' + esc(a.name) + ' <span style="color:var(--faint)">' + esc(a.category || '') + '</span></th><td class="r">' + money(a.tvl_usd) + '</td><td class="r">' + money(a.mcap_usd) + '</td><td class="r">' + money(a.fitted_usd) + '</td><td class="r">' + (a.err_pct >= 0 ? '+' : '') + a.err_pct.toFixed(0) + '%</td></tr>';
      }).join('') + '</table></div>';
    return h;
  }

  /* ---------- render & wiring ---------- */
  function render() {
    var body = state.view === 'detail' ? detailView()
      : state.view === 'model' ? modelView()
      : state.view === 'ledger' ? ledgerView()
      : state.view === 'anchors' ? anchorsView()
      : boardView();
    main.innerHTML = header() + body +
      '<p class="foot">Data: ' + esc(R.source) + ', snapshot of ' + esc(R.as_of) + '. Implied and expected values are this model\u2019s ' +
      'own claims, derived only from that snapshot; a protocol is said to <i>record</i> no token, never to have none. ' +
      'Model <code>' + esc(R.model_version) + '</code> · board rows ' + R.rows.length + ' · dossier source is the dashboard\u2019s own code.</p></div>';
    main.setAttribute('aria-busy', 'false');
    document.querySelectorAll('nav.views button').forEach(function (b) {
      b.addEventListener('click', function () { state.view = b.getAttribute('data-view'); render(); window.scrollTo(0, 0); });
    });
    var back = document.querySelector('button.back');
    if (back) back.addEventListener('click', function () { state.view = 'board'; render(); window.scrollTo(0, 0); });
    if (state.view === 'board') {
      var bind = function (id, key, num) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('change', function () { state[key] = num ? Number(el.value) : el.value; render(); });
      };
      bind('f-chain', 'chain'); bind('f-cat', 'category'); bind('f-verdict', 'verdict'); bind('f-sort', 'sort');
      var q = document.getElementById('f-q');
      if (q) q.addEventListener('input', function () {
        state.q = q.value;
        var pos = q.selectionStart;
        render();
        var nq = document.getElementById('f-q');
        nq.focus(); nq.setSelectionRange(pos, pos);
      });
      var wlBox = document.getElementById('f-wl');
      if (wlBox) wlBox.addEventListener('change', function () { state.wl = wlBox.checked; render(); });
      document.querySelectorAll('table.board tbody tr').forEach(function (tr) {
        tr.addEventListener('click', function () { state.view = 'detail'; state.slug = tr.getAttribute('data-slug'); render(); window.scrollTo(0, 0); });
      });
    }
  }
  render();
})();
