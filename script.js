(function () {
  const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;
  const ALLOC_TOLERANCE = 0.01;

  // Each of the three required uploads is { fileName, data } once loaded,
  // where data is a sorted [{date, price}] array — same shape as the chart
  // app, parsed by the same flexible CSV reader below.
  let stock = null;
  let bond = null;
  let inflation = null;

  // Kept so a window resize can redraw the results canvas at its new size
  // without re-running the backtest.
  let lastRunCycles = null;
  let lastRunYears = null;

  const fileInputs = {
    stock: document.getElementById('csv-stock'),
    bond: document.getElementById('csv-bond'),
    inflation: document.getElementById('csv-inflation'),
  };
  const fileLabels = {
    stock: document.getElementById('label-stock'),
    bond: document.getElementById('label-bond'),
    inflation: document.getElementById('label-inflation'),
  };
  const statusCards = {
    stock: document.getElementById('status-stock'),
    bond: document.getElementById('status-bond'),
    inflation: document.getElementById('status-inflation'),
  };
  const statusNames = {
    stock: document.getElementById('status-stock-name'),
    bond: document.getElementById('status-bond-name'),
    inflation: document.getElementById('status-inflation-name'),
  };
  const statusRanges = {
    stock: document.getElementById('status-stock-range'),
    bond: document.getElementById('status-bond-range'),
    inflation: document.getElementById('status-inflation-range'),
  };

  const commonRangeEl = document.getElementById('common-range');

  const initialPortfolioInput = document.getElementById('initial-portfolio');
  const yearsInput = document.getElementById('years-retirement');
  const spendingInput = document.getElementById('annual-spending');
  const realYieldInput = document.getElementById('real-yield');
  const allocStockInput = document.getElementById('alloc-stock');
  const allocBondInput = document.getElementById('alloc-bond');
  const allocInflationInput = document.getElementById('alloc-inflation');
  const allocTotalEl = document.getElementById('alloc-total');
  const rebalanceFreqInput = document.getElementById('rebalance-freq');
  const runButton = document.getElementById('run-backtest');
  const runStatusEl = document.getElementById('run-status');
  const resultsSection = document.getElementById('results-section');
  const resultsStatsEl = document.getElementById('results-stats');
  const resultsCanvas = document.getElementById('results-canvas');

  function loadSeries(key, file) {
    const reader = new FileReader();
    reader.onload = (event) => {
      const parsed = parseCSV(event.target.result);
      if (!parsed.length) {
        alert('No valid date/value rows found in that CSV.');
        return;
      }

      if (key === 'stock') stock = { fileName: file.name, data: parsed };
      if (key === 'bond') bond = { fileName: file.name, data: parsed };
      if (key === 'inflation') inflation = { fileName: file.name, data: parsed };

      fileLabels[key].classList.add('loaded');
      statusCards[key].classList.remove('hidden');
      statusNames[key].textContent = file.name;
      statusRanges[key].textContent = formatSeriesRange(parsed);

      refreshDerivedState();
    };
    reader.readAsText(file);
  }

  Object.keys(fileInputs).forEach((key) => {
    fileInputs[key].addEventListener('change', (event) => {
      const file = event.target.files[0];
      if (!file) return;
      loadSeries(key, file);
    });
  });

  [allocStockInput, allocBondInput, allocInflationInput].forEach((input) => {
    input.addEventListener('input', refreshDerivedState);
  });
  [initialPortfolioInput, yearsInput, spendingInput].forEach((input) => {
    input.addEventListener('input', refreshDerivedState);
  });
  realYieldInput.addEventListener('input', refreshDerivedState);
  rebalanceFreqInput.addEventListener('change', refreshDerivedState);

  // Recomputes everything that depends on loaded data or form state: the
  // common date range display, the allocation total, and whether the
  // backtest button reads as ready. Cheap enough to just rerun in full on
  // any change rather than track fine-grained dependencies. The synthetic
  // inflation-adjusted bond series itself is built fresh inside
  // buildMonthlyTimeline() each time a backtest actually runs (see below) —
  // it needs the monthly-aligned grid, not the raw uploaded dates, to
  // compound correctly.
  function refreshDerivedState() {
    updateCommonRangeDisplay();
    updateAllocTotal();
    updateRunStatus();
    resultsSection.classList.add('hidden'); // stale results no longer match the current inputs
  }

  // The backtest can only run over dates where all three uploads overlap —
  // the latest of the three start dates through the earliest of the three
  // end dates.
  function commonRange() {
    if (!stock || !bond || !inflation) return null;
    const starts = [stock.data[0].date, bond.data[0].date, inflation.data[0].date];
    const ends = [
      stock.data[stock.data.length - 1].date,
      bond.data[bond.data.length - 1].date,
      inflation.data[inflation.data.length - 1].date,
    ];
    const start = new Date(Math.max(...starts.map((d) => d.getTime())));
    const end = new Date(Math.min(...ends.map((d) => d.getTime())));
    return { start, end, invalid: start >= end };
  }

  function updateCommonRangeDisplay() {
    const range = commonRange();
    if (!range) {
      commonRangeEl.classList.add('hidden');
      return;
    }
    commonRangeEl.classList.remove('hidden');
    if (range.invalid) {
      commonRangeEl.classList.add('invalid');
      commonRangeEl.textContent = 'The uploaded series don’t share any overlapping dates — a backtest isn’t possible with this data.';
      return;
    }
    commonRangeEl.classList.remove('invalid');
    const years = (range.end - range.start) / MS_PER_YEAR;
    commonRangeEl.textContent =
      `Common backtest range: ${formatFullDate(range.start)} – ${formatFullDate(range.end)} (${years.toFixed(1)} years of overlapping data)`;
  }

  function updateAllocTotal() {
    const total = allocTotal();
    const valid = Math.abs(total - 100) <= ALLOC_TOLERANCE;
    allocTotalEl.textContent = valid ? 'Total: 100%' : `Total: ${formatPct(total)} (must equal 100%)`;
    allocTotalEl.classList.toggle('invalid', !valid);
    return valid;
  }

  function allocTotal() {
    return (Number(allocStockInput.value) || 0) + (Number(allocBondInput.value) || 0) + (Number(allocInflationInput.value) || 0);
  }

  function updateRunStatus() {
    const reason = readinessBlocker();
    runButton.disabled = !!reason;
    runStatusEl.classList.remove('error');
    if (reason) {
      runStatusEl.textContent = reason;
      runStatusEl.classList.remove('ready');
    } else {
      runStatusEl.textContent = '✓ Ready to run.';
      runStatusEl.classList.add('ready');
    }
  }

  // Returns a human-readable reason the form isn't ready yet, or null if
  // everything required is present and valid.
  function readinessBlocker() {
    if (!stock || !bond || !inflation) return 'Load all three datasets to continue.';
    const range = commonRange();
    if (range.invalid) return 'The uploaded series don’t share any overlapping dates.';

    const portfolio = Number(initialPortfolioInput.value);
    if (!(portfolio > 0)) return 'Enter an initial portfolio size greater than $0.';

    const years = Number(yearsInput.value);
    if (!(years > 0) || !Number.isFinite(years)) return 'Enter a number of years in retirement.';
    const spanYears = (range.end - range.start) / MS_PER_YEAR;
    if (years > spanYears) {
      return `Not enough historical data for a ${years}-year backtest — only ${spanYears.toFixed(1)} years are available.`;
    }

    const spending = spendingInput.value;
    if (spending === '' || !(Number(spending) >= 0)) return 'Enter an annual spending amount.';

    if (realYieldInput.value === '' || !Number.isFinite(Number(realYieldInput.value))) {
      return 'Enter a real yield for inflation-adjusted bonds (0 is fine).';
    }

    const allocStock = Number(allocStockInput.value);
    const allocBond = Number(allocBondInput.value);
    const allocInflation = Number(allocInflationInput.value);
    if ([allocStock, allocBond, allocInflation].some((v) => !Number.isFinite(v) || v < 0)) {
      return 'Portfolio allocation percentages must be 0 or more.';
    }
    if (Math.abs(allocStock + allocBond + allocInflation - 100) > ALLOC_TOLERANCE) {
      return 'Portfolio allocation must total 100%.';
    }

    return null;
  }

  function parseCSV(text) {
    const lines = text.split(/\r\n|\n|\r/).map((line) => line.trim()).filter(Boolean);
    const rows = lines.map(splitCSVLine);

    let startIndex = 0;
    if (rows.length) {
      const [firstDate, firstValue] = rows[0];
      if (isNaN(Date.parse(firstDate)) || isNaN(parseNumber(firstValue))) {
        startIndex = 1;
      }
    }

    const parsed = [];
    for (let i = startIndex; i < rows.length; i++) {
      const [rawDate, rawValue] = rows[i];
      if (rawDate === undefined || rawValue === undefined) continue;
      const date = parseFlexibleDate(rawDate);
      const price = parseNumber(rawValue);
      if (isNaN(date.getTime()) || isNaN(price)) continue;
      parsed.push({ date, price });
    }

    parsed.sort((a, b) => a.date - b.date);
    return parsed;
  }

  function splitCSVLine(line) {
    return line.split(',').map((cell) => cell.trim().replace(/^"|"$/g, ''));
  }

  function parseNumber(value) {
    if (value === undefined) return NaN;
    return parseFloat(String(value).replace(/[$,]/g, ''));
  }

  // Bare "YYYY-MM-DD" strings are parsed by `new Date()` as UTC midnight,
  // which can shift to the previous day once rendered in a timezone behind
  // UTC. Parse date-only strings as local dates instead to avoid that.
  function parseFlexibleDate(value) {
    const isoDateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
    if (isoDateOnly) {
      const [, year, month, day] = isoDateOnly;
      return new Date(Number(year), Number(month) - 1, Number(day));
    }
    return new Date(value);
  }

  function formatSeriesRange(data) {
    const start = data[0].date;
    const end = data[data.length - 1].date;
    return `${formatFullDate(start)} – ${formatFullDate(end)} (${data.length} points)`;
  }

  function formatFullDate(date) {
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
  }

  function formatPct(value) {
    return `${value % 1 === 0 ? value : value.toFixed(1)}%`;
  }

  // ---------------------------------------------------------------------
  // Backtest engine
  // ---------------------------------------------------------------------

  runButton.addEventListener('click', () => {
    const blocker = readinessBlocker();
    if (blocker) return; // button should already be disabled in this case

    const timeline = buildMonthlyTimeline();
    if (timeline.gap) {
      runStatusEl.textContent =
        `The uploaded series aren't on a clean monthly cadence — found a gap between ${timeline.keys[timeline.atIndex - 1]} and ${timeline.keys[timeline.atIndex]} once matched to a shared set of months. A backtest needs one data point per calendar month with no missing months in the overlapping range.`;
      runStatusEl.classList.add('error');
      runStatusEl.classList.remove('ready');
      resultsSection.classList.add('hidden');
      return;
    }

    const years = Number(yearsInput.value);
    const config = {
      initialPortfolio: Number(initialPortfolioInput.value),
      years,
      annualSpending: Number(spendingInput.value),
      realYieldApyPct: Number(realYieldInput.value),
      allocStock: Number(allocStockInput.value),
      allocBond: Number(allocBondInput.value),
      allocInflation: Number(allocInflationInput.value),
      rebalanceEveryMonths: Number(rebalanceFreqInput.value), // 0 = never
    };

    const run = runAllCycles(timeline, config);
    if (run.error) {
      runStatusEl.textContent = run.error;
      runStatusEl.classList.add('error');
      runStatusEl.classList.remove('ready');
      resultsSection.classList.add('hidden');
      return;
    }

    renderResults(run, config);
  });

  // Reduces each series to one price per calendar month (the last data
  // point seen in that month, so daily/weekly data downsamples cleanly),
  // keyed "YYYY-MM" so differing day-of-month between series doesn't
  // prevent a match.
  function toMonthlyMap(data) {
    const map = new Map();
    for (const d of data) {
      const key = `${d.date.getFullYear()}-${String(d.date.getMonth() + 1).padStart(2, '0')}`;
      map.set(key, d.price);
    }
    return map;
  }

  // Builds one shared monthly timeline from the three uploads: the
  // calendar months present in all three, sorted chronologically, each
  // paired with that month's stock/bond/inflation price and — derived
  // right here, on this same monthly grid — the synthetic inflation-
  // adjusted bond price (inflation compounded forward one extra month at
  // the user's real-yield APY each step: a fixed (1+realYield)^(1/12)
  // per month, duration-less like an I-bond). Returns { gap: true, keys,
  // atIndex } instead if the matched months aren't contiguous (a missing
  // month would otherwise silently get treated as a single one-month
  // return spanning a longer gap).
  function buildMonthlyTimeline() {
    const stockMap = toMonthlyMap(stock.data);
    const bondMap = toMonthlyMap(bond.data);
    const inflMap = toMonthlyMap(inflation.data);
    const keys = [...stockMap.keys()].filter((k) => bondMap.has(k) && inflMap.has(k)).sort();

    for (let i = 1; i < keys.length; i++) {
      const [py, pm] = keys[i - 1].split('-').map(Number);
      const [cy, cm] = keys[i].split('-').map(Number);
      if (py * 12 + pm + 1 !== cy * 12 + cm) {
        return { gap: true, keys, atIndex: i };
      }
    }

    const stockPrices = keys.map((k) => stockMap.get(k));
    const bondPrices = keys.map((k) => bondMap.get(k));
    const inflPrices = keys.map((k) => inflMap.get(k));

    const n = keys.length - 1; // number of one-month steps between points
    const stockReturns = new Array(n);
    const bondReturns = new Array(n);
    const inflGrowth = new Array(n); // inflation's own month-over-month growth factor
    for (let i = 0; i < n; i++) {
      stockReturns[i] = stockPrices[i + 1] / stockPrices[i] - 1;
      bondReturns[i] = bondPrices[i + 1] / bondPrices[i] - 1;
      inflGrowth[i] = inflPrices[i + 1] / inflPrices[i];
    }

    return { keys, stockPrices, bondPrices, inflPrices, stockReturns, bondReturns, inflGrowth };
  }

  // Simulates one rolling cycle starting at monthly-grid index `startIdx`,
  // following the month-by-month recipe: withdraw first (month 0, no
  // growth yet — the lump sum you're retiring with), then every month
  // after that: grow each bucket by its own asset's return, inflate the
  // spending amount, withdraw it pro-rata across the buckets (so the
  // withdrawal itself doesn't distort the post-growth weights), and
  // rebalance back to the target split if this month lands on the chosen
  // interval. Keeps computing through $0 (buckets can go negative) so a
  // failed cycle's full trajectory — and how deep it went — still shows.
  function simulateCycle(startIdx, cycleMonths, timeline, config) {
    const { stockReturns, bondReturns, synthReturns, inflGrowth } = timeline;
    const trajectory = new Array(cycleMonths + 1);
    trajectory[0] = config.initialPortfolio;

    let spending = config.annualSpending / 12;
    let bucket = {
      stock: (config.initialPortfolio * config.allocStock) / 100,
      bond: (config.initialPortfolio * config.allocBond) / 100,
      infl: (config.initialPortfolio * config.allocInflation) / 100,
    };

    let failed = false;

    for (let m = 0; m < cycleMonths; m++) {
      if (m > 0) {
        const si = startIdx + m - 1;
        bucket.stock *= 1 + stockReturns[si];
        bucket.bond *= 1 + bondReturns[si];
        bucket.infl *= 1 + synthReturns[si];
        spending *= inflGrowth[si];
      }

      const total = bucket.stock + bucket.bond + bucket.infl;
      const fracStock = total === 0 ? 1 / 3 : bucket.stock / total;
      const fracBond = total === 0 ? 1 / 3 : bucket.bond / total;
      const fracInfl = total === 0 ? 1 / 3 : bucket.infl / total;
      bucket.stock -= spending * fracStock;
      bucket.bond -= spending * fracBond;
      bucket.infl -= spending * fracInfl;

      const totalAfterWithdrawal = bucket.stock + bucket.bond + bucket.infl;
      trajectory[m + 1] = totalAfterWithdrawal;
      if (totalAfterWithdrawal <= 0) failed = true;

      if (config.rebalanceEveryMonths && (m + 1) % config.rebalanceEveryMonths === 0) {
        bucket.stock = (totalAfterWithdrawal * config.allocStock) / 100;
        bucket.bond = (totalAfterWithdrawal * config.allocBond) / 100;
        bucket.infl = (totalAfterWithdrawal * config.allocInflation) / 100;
      }
    }

    return { trajectory, endingBalance: trajectory[cycleMonths], failed };
  }

  // Rolls the cycle start forward one month at a time — exactly the
  // "repeat starting with the second month, and on and on" instruction —
  // stopping once a full cycleMonths-long window no longer fits before the
  // end of the shared monthly timeline. Mirrors FIRECalc's "N possible
  // year periods in the available data" framing.
  function runAllCycles(timeline, config) {
    const synthReturns = new Array(timeline.stockReturns.length);
    const realMonthlyGrowth = Math.pow(1 + config.realYieldApyPct / 100, 1 / 12);
    for (let i = 0; i < synthReturns.length; i++) {
      synthReturns[i] = timeline.inflGrowth[i] * realMonthlyGrowth - 1;
    }
    const fullTimeline = { ...timeline, synthReturns };

    const cycleMonths = config.years * 12;
    const monthlyPoints = timeline.keys.length;
    const numCycles = monthlyPoints - cycleMonths;
    if (numCycles < 1) {
      return { error: `Not enough monthly data for a ${config.years}-year backtest (need ${cycleMonths + 1} consecutive months, have ${monthlyPoints}).` };
    }

    const cycles = [];
    for (let s = 0; s < numCycles; s++) {
      cycles.push({ startKey: timeline.keys[s], ...simulateCycle(s, cycleMonths, fullTimeline, config) });
    }

    return { cycles, cycleMonths, numCycles };
  }

  function renderResults(run, config) {
    const { cycles, numCycles } = run;
    const endingBalances = cycles.map((c) => c.endingBalance);
    const numFailed = cycles.filter((c) => c.failed).length;
    const successRate = ((numCycles - numFailed) / numCycles) * 100;
    const min = Math.min(...endingBalances);
    const max = Math.max(...endingBalances);
    const avg = endingBalances.reduce((a, b) => a + b, 0) / endingBalances.length;

    resultsStatsEl.innerHTML = `
      <div class="headline">This backtest found ${numCycles} possible ${config.years}-year period${numCycles === 1 ? '' : 's'} in the available data, starting with a portfolio of ${formatDollars(config.initialPortfolio)} and spending ${formatDollars(config.annualSpending)}/year thereafter (adjusted for inflation).</div>
      <div>The lowest and highest portfolio balance at the end of your retirement was ${formatDollars(min)} to ${formatDollars(max)}, with an average at the end of ${formatDollars(avg)}.</div>
      <div>Failure means the portfolio was depleted (hit $0 or below) at any point before the end of the ${config.years} years. ${numFailed} of ${numCycles} cycles failed, for a success rate of
        <span class="success-rate ${successRate >= 80 ? 'good' : successRate < 50 ? 'bad' : ''}">${successRate.toFixed(1)}%</span>.
      </div>
    `;

    resultsSection.classList.remove('hidden');
    lastRunCycles = cycles;
    lastRunYears = config.years;
    drawResultsChart(cycles, config.years);
  }

  // Renders every cycle's trajectory as a semi-transparent line on one
  // <canvas> (a plain raster draw, not per-point SVG/DOM elements) so a
  // chart with dozens or hundreds of overlapping cycles stays fast and
  // doesn't bloat the page with interactive chart machinery it doesn't
  // need here — this view is a static image, not a hoverable chart.
  function drawResultsChart(cycles, years) {
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = resultsCanvas.parentElement.clientWidth - 16;
    const cssHeight = Math.round(Math.max(360, Math.min(600, window.innerHeight * 0.5)));
    resultsCanvas.style.width = cssWidth + 'px';
    resultsCanvas.style.height = cssHeight + 'px';
    resultsCanvas.width = Math.round(cssWidth * dpr);
    resultsCanvas.height = Math.round(cssHeight * dpr);
    const ctx = resultsCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const margin = { top: 16, right: 16, bottom: 32, left: 80 };
    const innerWidth = cssWidth - margin.left - margin.right;
    const innerHeight = cssHeight - margin.top - margin.bottom;

    ctx.fillStyle = '#17191f'; // --surface
    ctx.fillRect(0, 0, cssWidth, cssHeight);
    if (innerWidth <= 0 || innerHeight <= 0) return;

    let yMin = 0;
    let yMax = 0;
    cycles.forEach((c) => c.trajectory.forEach((v) => {
      if (v < yMin) yMin = v;
      if (v > yMax) yMax = v;
    }));
    const yPad = (yMax - yMin) * 0.05 || 1;
    yMin -= yPad;
    yMax += yPad;

    const xForMonth = (m) => margin.left + (m / (cycles[0].trajectory.length - 1)) * innerWidth;
    const yForValue = (v) => margin.top + innerHeight - ((v - yMin) / (yMax - yMin)) * innerHeight;

    // Gridlines + Y axis labels
    const yTickCount = Math.max(3, Math.floor(innerHeight / 50));
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.fillStyle = '#adafb8'; // --text-secondary
    ctx.font = '11px "Google Sans", Roboto, Arial, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= yTickCount; i++) {
      const v = yMin + (i / yTickCount) * (yMax - yMin);
      const y = yForValue(v);
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(margin.left + innerWidth, y);
      ctx.stroke();
      ctx.fillText(formatDollarsCompact(v), margin.left - 8, y);
    }

    // X axis labels (years into retirement)
    const xTickCount = Math.min(years, Math.max(2, Math.floor(innerWidth / 70)));
    const xTickStep = Math.max(1, Math.round(years / xTickCount));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let yr = 0; yr <= years; yr += xTickStep) {
      const x = xForMonth(yr * 12);
      ctx.fillText(String(yr), x, margin.top + innerHeight + 8);
    }
    ctx.fillText('Years into retirement', margin.left + innerWidth / 2, margin.top + innerHeight + 22);

    // Zero reference line — the failure threshold
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(margin.left, yForValue(0));
    ctx.lineTo(margin.left + innerWidth, yForValue(0));
    ctx.stroke();
    ctx.setLineDash([]);

    // One line per cycle — green if it survived, red (down) if it failed —
    // drawn at low opacity so the overlapping density itself shows where
    // most cycles tend to land.
    cycles.forEach((c) => {
      ctx.strokeStyle = c.failed ? 'rgba(255, 169, 175, 0.45)' : 'rgba(144, 229, 140, 0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      c.trajectory.forEach((v, m) => {
        const x = xForMonth(m);
        const y = yForValue(v);
        if (m === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });
  }

  function formatDollars(value) {
    const sign = value < 0 ? '-' : '';
    return `${sign}$${Math.round(Math.abs(value)).toLocaleString()}`;
  }

  // Abbreviated axis-label form ("$1.2M", "-$350k") — full formatDollars()
  // would crowd the Y axis at the tick density a chart this tall needs.
  function formatDollarsCompact(value) {
    const sign = value < 0 ? '-' : '';
    const abs = Math.abs(value);
    if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
    if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
    return `${sign}$${Math.round(abs)}`;
  }

  window.addEventListener('resize', () => {
    if (!resultsSection.classList.contains('hidden') && lastRunCycles) {
      drawResultsChart(lastRunCycles, lastRunYears);
    }
  });

  // Initial paint: allocation inputs already have default values (70/15/15)
  // and nothing's loaded yet, so this just shows the correct starting
  // total and the "load data" prompt.
  refreshDerivedState();
})();
