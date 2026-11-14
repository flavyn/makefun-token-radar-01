// Pre-token Radar: the page's whole behaviour. No framework, no network, no fetch: window.RADAR
// arrives with data.js, written by main.ts from the same board.json the scorer reads.
(function () {
  'use strict';

  var R = window.RADAR;
  if (!R || !R.rows) {
    document.body.innerHTML = '<p style="font:14px system-ui;padding:24px">data.js is missing: run main.ts first.</p>';
    return;
  }

  var $ = function (id) { return document.getElementById(id); };
  var state = { sort: 'rank', cat: 'all', chain: 'all', q: '', watch: false, live: false, slug: null };

  // ------------------------------------------------------------ formatting

  function usd(n) {
    if (n === null || n === undefined) return '\u2014';
    var a = Math.abs(n);
    if (a >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(a >= 1e8 ? 0 : 1) + 'M';
    if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'k';
    return '$' + n;
  }

  function pct(n) {
    if (n === null || n === undefined) return '\u2014';
    return (n > 0 ? '+' : n < 0 ? '\u2212' : '') + Math.abs(n).toFixed(1) + '%';
  }

  function days(n) { return n === null || n === undefined ? '\u2014' : n + 'd'; }

  function mult(n) { return '\u00d7' + Number(n).toFixed(2); }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  // ------------------------------------------------------------ hash state

  function readHash() {
    var h = String(location.hash || '').replace(/^#/, '');
    if (!h) return;
    h.split('&').forEach(function (pair) {
      var kv = pair.split('=');
      var k = decodeURIComponent(kv[0] || '');
      var v = decodeURIComponent(kv.slice(1).join('=') || '');
      if (k === 'slug') state.slug = v || null;
      else if (k === 'cat') state.cat = v || 'all';
      else if (k === 'chain') state.chain = v || 'all';
      else if (k === 'q') state.q = v;
      else if (k === 'sort') state.sort = v || 'rank';
      else if (k === 'watch') state.watch = v === '1';
      else if (k === 'live') state.live = v === '1';
    });
  }

  // ------------------------------------------------------------ the data views

  var CATS = (function () {
    var seen = {};
    R.rows.forEach(function (r) { if (r.category) seen[r.category] = true; });
    return Object.keys(seen).sort();
  })();

  var CHAINS = (function () {
    var seen = {};
    R.rows.forEach(function (r) { (r.chains || []).forEach(function (c) { seen[c] = true; }); });
    return Object.keys(seen).sort();
  })();

  function matches(r) {
    if (state.watch && !r.watchlisted) return false;
    if (state.cat !== 'all' && (r.category || '') !== state.cat) return false;
    if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
    if (state.q) {
      var hay = (r.name + ' ' + r.slug + ' ' + (r.category || '') + ' ' + (r.chains || []).join(' ')).toLowerCase();
      if (hay.indexOf(state.q.toLowerCase()) < 0) return false;
    }
    return true;
  }

  function sorted(rows) {
    var copy = rows.slice();
    var cmp;
    if (state.sort === 'tvl') cmp = function (a, b) { return b.tvl_usd - a.tvl_usd; };
    else if (state.sort === 'growth') cmp = function (a, b) { return (b.change_7d === null ? -1e9 : b.change_7d) - (a.change_7d === null ? -1e9 : a.change_7d); };
    else if (state.sort === 'age') cmp = function (a, b) { return (b.age_days === null ? -1 : b.age_days) - (a.age_days === null ? -1 : a.age_days); };
    else if (state.sort === 'name') cmp = function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0; };
    else cmp = function (a, b) { return a.rank - b.rank; };
    copy.sort(function (a, b) { return cmp(a, b) || a.rank - b.rank; });
    return copy;
  }

  // ------------------------------------------------------------ the table

  var HEAD = [
    { key: 'rank', label: '#', cls: 'rank' },
    { key: 'name', label: 'Protocol', cls: 'who' },
    { key: null, label: 'Category', cls: 'cat' },
    { key: 'tvl', label: 'TVL', cls: 'num' },
    { key: 'growth', label: '7-day', cls: 'num' },
    { key: 'age', label: 'No token for', cls: 'num' },
    { key: null, label: 'Implied value', cls: 'num' },
    { key: null, label: 'Comp', cls: 'num' }
  ];

  var HEAD_LIVE = [
    { key: null, label: '#', cls: 'rank' },
    { key: null, label: 'Protocol', cls: 'who' },
    { key: null, label: 'Category', cls: 'cat' },
    { key: null, label: 'TVL', cls: 'num' },
    { key: null, label: 'Market cap', cls: 'num' },
    { key: null, label: 'MC / TVL', cls: 'num' },
    { key: null, label: '7-day', cls: 'num' }
  ];

  function renderHead(live) {
    var row = $('head-row');
    row.textContent = '';
    (live ? HEAD_LIVE : HEAD).forEach(function (h) {
      var th = el('th', h.cls === 'num' ? 'num' : '');
      th.textContent = h.label;
      if (h.key) {
        th.setAttribute('data-sort', h.key);
        th.style.cursor = 'pointer';
        if (state.sort === h.key) th.className += ' sorted';
      }
      if (h.cls === 'num') th.className = 'num' + (state.sort === h.key ? ' sorted' : '');
      row.appendChild(th);
    });
  }

  function renderTable() {
    renderHead(state.live);
    var body = $('body');
    body.textContent = '';

    if (state.live) {
      var live = R.live.slice(0, 300);
      $('board-title').textContent = 'The token-bearing set';
      $('board-note').textContent = R.live.length + ' protocols whose token already trades, in the market\u2019s own numbers: the evidence the board is priced from, never a row of it.';
      live.forEach(function (r, i) {
        var tr = el('tr');
        tr.appendChild(el('td', 'rank', i + 1));
        var who = el('td', 'who');
        who.appendChild(el('b', '', r.name));
        who.appendChild(el('span', 'subline', r.slug + ' \u00b7 ' + (r.chains || []).slice(0, 2).join(', ')));
        tr.appendChild(who);
        tr.appendChild(el('td', 'cat', r.category || '\u2014'));
        tr.appendChild(el('td', 'num', usd(r.tvl_usd)));
        tr.appendChild(el('td', 'num', usd(r.mcap_usd)));
        tr.appendChild(el('td', 'num', r.ratio.toFixed(2) + '\u00d7'));
        var g = el('td', 'num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'up' : 'down'), pct(r.change_7d));
        tr.appendChild(g);
        body.appendChild(tr);
      });
      return;
    }

    var rows = sorted(R.rows.filter(matches));
    var top = R.rows.length > 0 ? R.rows[0].implied_value_usd : 1;
    $('board-title').textContent = 'The board';
    $('board-note').textContent = rows.length + ' of ' + R.rows.length + ' protocols that record no token' +
      (state.watch ? ', the watchlist floor only' : ', ' + R.early_size + ' of them under the house\u2019s floor') +
      ' \u00b7 ranked by implied value at launch';

    rows.forEach(function (r) {
      var tr = el('tr');
      if (r.slug === state.slug) tr.className = 'on';
      tr.appendChild(el('td', 'rank', r.rank));

      var who = el('td', 'who');
      var b = el('b', '', r.name);
      if (r.watchlisted) {
        var chip = el('span', 'chip', 'watchlist');
        chip.style.marginLeft = '6px';
        b.appendChild(chip);
      }
      who.appendChild(b);
      who.appendChild(el('span', 'subline', r.slug + ' \u00b7 ' + (r.chains || []).slice(0, 2).join(', ')));
      tr.appendChild(who);

      tr.appendChild(el('td', 'cat', r.category || '\u2014'));
      tr.appendChild(el('td', 'num', usd(r.tvl_usd)));
      tr.appendChild(el('td', 'num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'up' : 'down'), pct(r.change_7d)));
      tr.appendChild(el('td', 'num', days(r.age_days)));

      var v = el('td', 'num value');
      v.appendChild(document.createTextNode(usd(r.implied_value_usd)));
      var bar = el('span', 'bar');
      var fill = el('i');
      fill.style.width = Math.max(2, Math.round((r.implied_value_usd / top) * 100)) + '%';
      bar.appendChild(fill);
      v.appendChild(bar);
      v.style.minWidth = '80px';
      tr.appendChild(v);

      var borrowed = r.model.comp_source === 'category' ? '' : '\u2248';
      tr.appendChild(el('td', 'num', borrowed + mult(r.model.comp_multiple)));
      tr.addEventListener('click', function () {
        state.slug = state.slug === r.slug ? null : r.slug;
        render();
      });
      body.appendChild(tr);
    });
  }

  // ------------------------------------------------------------ the detail

  function planParts(s) {
    var m = /^(.*) Cost: (.*)\. Time: (.*)\.$/.exec(s);
    return m ? { text: m[1], cost: m[2], time: m[3] } : { text: s, cost: '', time: '' };
  }

  function whereComp(source) {
    if (source === 'category') return 'its own category';
    if (source === 'family') return 'borrowed from its family';
    return 'borrowed from the whole snapshot';
  }

  function compsTable(activeKey) {
    var t = el('table', 'comps');
    var measured = R.comps.filter(function (c) { return c.sample >= R.model.comp_min_sample; });
    var rows = [];
    measured.slice(0, 7).forEach(function (c) {
      rows.push({ key: c.key, label: c.key, sample: c.sample, multiple: c.multiple, kind: '' });
    });
    R.families.filter(function (f) { return f.sample >= R.model.comp_min_sample; }).slice(0, 3).forEach(function (f) {
      rows.push({ key: f.key, label: f.key + ' family', sample: f.sample, multiple: f.multiple, kind: 'borrowed' });
    });
    rows.forEach(function (c) {
      var tr = el('tr', c.key === activeKey ? 'here' : '');
      tr.appendChild(el('td', '', c.label));
      tr.appendChild(el('td', '', 'n=' + c.sample));
      var m = el('td', '', mult(c.multiple));
      if (c.kind === 'borrowed') m.style.color = 'var(--mute)';
      tr.appendChild(m);
      t.appendChild(tr);
    });
    return t;
  }

  function renderDetail() {
    var d = $('detail');
    d.textContent = '';

    var row = null;
    if (state.slug) {
      for (var i = 0; i < R.rows.length; i++) if (R.rows[i].slug === state.slug) { row = R.rows[i]; break; }
    }

    if (!row) {
      d.appendChild(el('h3', '', 'How the number is built'));
      var lede = el('p', 'lede', 'Every protocol here records no token. The board asks one question: what would a token look like at launch if this protocol\u2019s record held? It answers with what protocols that already trade are worth against their own TVL, in the same category, and then moves that multiple by the protocol\u2019s own seven-day flows and by how long it has run without a token.');
      d.appendChild(lede);
      d.appendChild(el('p', 'formula', 'implied = TVL \u00d7 comp(category)\n        \u00d7 (1 + 0.75 \u00d7 clamp(7d,-40,40)%)\n        \u00d7 (0.70 + 0.30 \u00d7 min(age,1095)/1095)'));
      var scope = el('p', 'lede', 'What is ranked: every protocol that records no token and is not a wrapped, staked, bridged or restaked product of one that trades. Above the house\u2019s ' + usd(R.floor_usd) + ' floor its watchlist is authoritative, because its rule also reads a parent-protocol field this snapshot omits; below the floor the same visible rule is applied, which is where a radar earns its keep. The ' + R.live_size + ' protocols whose token trades are the evidence, and never a row.');
      scope.style.fontSize = '11.5px';
      d.appendChild(scope);
      d.appendChild(el('h4', '', 'Comparables in this snapshot'));
      d.appendChild(compsTable(state.cat === 'all' ? null : state.cat));
      var note = el('p', 'note', 'Median market cap per dollar of TVL among the ' + R.live_size + ' token-bearing protocols, by category; a category under five readings borrows its family\u2019s median, and one under that borrows the whole snapshot\u2019s. Click a row to see one protocol\u2019s arithmetic and its farm plan.');
      note.style.marginTop = '10px';
      d.appendChild(note);
      return;
    }

    d.appendChild(el('h3', '', row.name));
    var chains = row.chains || [];
    var chainLine = chains.slice(0, 3).join(', ') + (chains.length > 3 ? ' +' + (chains.length - 3) + ' more' : '');
    d.appendChild(el('p', 'sub', row.slug + ' \u00b7 ' + (row.category || 'uncategorised') + ' \u00b7 ' + chainLine));

    var big = el('p', 'big');
    big.appendChild(el('b', '', usd(row.implied_value_usd)));
    big.appendChild(el('span', '', 'implied at launch'));
    d.appendChild(big);
    d.appendChild(el('p', 'note', 'rank ' + row.rank + ' of ' + R.rows.length + (row.watchlisted ? ' \u00b7 on the watchlist floor' : ' \u00b7 found below the floor')));

    var dl = el('dl', 'derivation');
    function pair(k, v, cls) {
      var line = el('div', cls || '');
      line.appendChild(el('dt', '', k));
      var dd = el('dd', '', v);
      line.appendChild(dd);
      dl.appendChild(line);
    }
    pair('TVL, 14 November', usd(row.tvl_usd));
    pair('Comparable', mult(row.model.comp_multiple) + '  ' + whereComp(row.model.comp_source) + ', n=' + row.model.comp_sample);
    pair('Seven-day flows', pct(row.model.growth_pct) + '  ' + mult(row.model.momentum_multiplier));
    pair('Days without a token', (row.age_days === null ? 'unrecorded' : row.age_days + 'd') + '  ' + mult(row.model.maturity_multiplier));
    pair('Implied value at launch', usd(row.implied_value_usd), 'total');
    d.appendChild(dl);

    d.appendChild(el('h4', '', 'Farm it'));
    var ol = el('ol', 'plan');
    row.farm_steps.forEach(function (s) {
      var p = planParts(s);
      var li = el('li', '', p.text + ' ');
      var em = el('em', '', p.cost + ' \u00b7 ' + p.time);
      li.appendChild(em);
      ol.appendChild(li);
    });
    d.appendChild(ol);

    d.appendChild(el('h4', '', 'The comparables behind that multiple'));
    d.appendChild(compsTable(row.model.comp_key));
  }

  // ------------------------------------------------------------ the page

  function renderFacts() {
    var facts = $('facts');
    facts.textContent = '';
    [
      ['Ranked', String(R.board_size), 'pre-token'],
      ['Watchlist', String(R.watchlist_size), 'floor'],
      ['Below floor', String(R.early_size), 'by rule'],
      ['Token-bearing', String(R.live_size), 'caps']
    ].forEach(function (f) {
      var div = el('div');
      div.appendChild(el('dt', '', f[0]));
      var dd = el('dd', '', f[1] + ' ');
      dd.appendChild(el('small', '', f[2]));
      div.appendChild(dd);
      facts.appendChild(div);
    });

    $('dateline').textContent = 'Snapshot ' + R.as_of + ' \u00b7 ' + R.rows.length + ' protocols with no token, ' +
      R.live_size + ' that trade \u00b7 floor ' + usd(R.floor_usd) + ' \u00b7 ' + R.model.version;
    $('footnote').textContent = 'Source: ' + R.source + '. An implied value is this radar\u2019s own claim about a token if the record held; it predicts no issuance. Every figure is the sealed snapshot\u2019s.';
  }

  function fillSelect(id, values, current) {
    var sel = $(id);
    values.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v;
      o.textContent = v === 'all' ? (id === 'cat' ? 'Every category' : 'Every chain') : v;
      if (v === current) o.selected = true;
      sel.appendChild(o);
    });
  }

  function render() {
    $('q').value = state.q;
    $('cat').value = state.cat;
    $('chain').value = state.chain;
    $('sort').value = state.sort;
    $('watch').checked = state.watch;
    $('live').checked = state.live;
    renderTable();
    renderDetail();
  }

  function wire() {
    $('q').addEventListener('input', function (e) { state.q = e.target.value; render(); });
    $('cat').addEventListener('change', function (e) { state.cat = e.target.value; render(); });
    $('chain').addEventListener('change', function (e) { state.chain = e.target.value; render(); });
    $('sort').addEventListener('change', function (e) { state.sort = e.target.value; render(); });
    $('watch').addEventListener('change', function (e) { state.watch = e.target.checked; render(); });
    $('live').addEventListener('change', function (e) { state.live = e.target.checked; render(); });
    $('head-row').addEventListener('click', function (e) {
      var th = e.target.closest('th[data-sort]');
      if (!th) return;
      state.sort = th.getAttribute('data-sort');
      render();
    });
  }

  readHash();
  fillSelect('cat', ['all'].concat(CATS), state.cat);
  fillSelect('chain', ['all'].concat(CHAINS), state.chain);
  renderFacts();
  wire();
  render();
})();
