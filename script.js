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
  const chartLogToggle = document.getElementById('chart-log-toggle');
  const logScaleNoteEl = document.getElementById('log-scale-note');
  const failureListSection = document.getElementById('failure-list-section');
  const failureListTitleEl = document.getElementById('failure-list-title');
  const failureListEl = document.getElementById('failure-list');
  const chartTooltip = document.getElementById('chart-tooltip');

  // Set at the end of every drawResultsChart() call: a pristine pixel
  // snapshot of the base chart (axes + density, no highlight) and the
  // geometry/data needed to hit-test the cursor against it. Hovering
  // restores the snapshot (cheap — no re-binning) and draws just the
  // highlighted line and dot on top.
  let lastChartSnapshot = null;
  let lastChartGeometry = null;

  chartLogToggle.addEventListener('change', () => {
    logScaleNoteEl.classList.toggle('hidden', !chartLogToggle.checked);
    if (lastRunCycles) drawResultsChart(lastRunCycles, lastRunYears);
  });

  resultsCanvas.addEventListener('mousemove', (e) => handleChartHover(e.clientX, e.clientY));
  resultsCanvas.addEventListener('mouseleave', hideChartHover);
  resultsCanvas.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 1) return;
    handleChartHover(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  resultsCanvas.addEventListener('touchend', hideChartHover);

  function handleChartHover(clientX, clientY) {
    if (!lastChartGeometry || !lastChartSnapshot) return;
    const rect = resultsCanvas.getBoundingClientRect();
    const mouseX = clientX - rect.left;
    const mouseY = clientY - rect.top;
    const { margin, innerWidth, innerHeight, mapper, monthCount, cycles } = lastChartGeometry;

    if (mouseX < margin.left || mouseX > margin.left + innerWidth || mouseY < margin.top || mouseY > margin.top + innerHeight) {
      hideChartHover();
      return;
    }

    const monthFraction = ((mouseX - margin.left) / innerWidth) * (monthCount - 1);
    const m = Math.round(Math.min(Math.max(monthFraction, 0), monthCount - 1));
    const unitY = (margin.top + innerHeight - mouseY) / innerHeight;

    // Nearest cycle by on-screen (unit-space) distance at this month —
    // unit-space rather than raw dollars so "nearest" means the same
    // thing visually in both linear and log mode, where a given pixel
    // gap represents very different dollar gaps depending on the value.
    let best = null;
    let bestDist = Infinity;
    cycles.forEach((c) => {
      const d = Math.abs(mapper.toUnit(c.trajectory[m]) - unitY);
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    });
    if (best) drawChartHover(best, m);
  }

  function hideChartHover() {
    if (!lastChartSnapshot) return;
    resultsCanvas.getContext('2d').putImageData(lastChartSnapshot, 0, 0);
    chartTooltip.classList.add('hidden');
  }

  function drawChartHover(cycle, m) {
    const ctx = resultsCanvas.getContext('2d');
    ctx.putImageData(lastChartSnapshot, 0, 0);
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // putImageData ignores the transform — restore it for the draws below

    const { margin, innerWidth, innerHeight, mapper, monthCount } = lastChartGeometry;
    const xForMonth = (mm) => margin.left + (mm / (monthCount - 1)) * innerWidth;
    const yForValue = (v) => margin.top + innerHeight - mapper.toUnit(v) * innerHeight;
    const color = cycle.failed ? '#ffa9af' : '#90e58c';

    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 4;
    ctx.beginPath();
    cycle.trajectory.forEach((v, i) => {
      const x = xForMonth(i);
      const y = yForValue(v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.shadowBlur = 0;

    const hoverX = xForMonth(m);
    const hoverY = yForValue(cycle.trajectory[m]);

    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(hoverX, margin.top);
    ctx.lineTo(hoverX, margin.top + innerHeight);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(hoverX, hoverY, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#17191f';
    ctx.stroke();

    const yearsIn = (m / 12).toFixed(1);
    chartTooltip.innerHTML = `
      <div class="tooltip-start">Start: ${formatMonthKey(cycle.startKey)}</div>
      <div class="tooltip-value">${formatDollars(cycle.trajectory[m])}</div>
      <div class="tooltip-year">Year ${yearsIn} of retirement${cycle.failed ? ' · failed' : ''}</div>
    `;
    chartTooltip.classList.remove('hidden');

    // Positioned relative to .results-canvas-card (the nearest positioned
    // ancestor) via the canvas's own offset within it, so the chart
    // controls row above the canvas is accounted for automatically.
    let left = resultsCanvas.offsetLeft + hoverX + 12;
    const top = resultsCanvas.offsetTop + hoverY - 12;
    if (left + 160 > resultsCanvas.offsetLeft + margin.left + innerWidth) {
      left = resultsCanvas.offsetLeft + hoverX - 172;
    }
    chartTooltip.style.left = left + 'px';
    chartTooltip.style.top = Math.max(0, top) + 'px';
  }

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
    let failedAtMonth = null;

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
      if (totalAfterWithdrawal <= 0 && !failed) {
        failed = true;
        failedAtMonth = m; // first month it happened — matches timeline index startIdx + m
      }

      if (config.rebalanceEveryMonths && (m + 1) % config.rebalanceEveryMonths === 0) {
        bucket.stock = (totalAfterWithdrawal * config.allocStock) / 100;
        bucket.bond = (totalAfterWithdrawal * config.allocBond) / 100;
        bucket.infl = (totalAfterWithdrawal * config.allocInflation) / 100;
      }
    }

    return { trajectory, endingBalance: trajectory[cycleMonths], failed, failedAtMonth };
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
      const result = simulateCycle(s, cycleMonths, fullTimeline, config);
      // currentPriceIndex at loop iteration m is startIdx + m (see
      // simulateCycle: growth for iteration m uses the return ending at
      // that index, or — for m=0 — the start date itself), so the failure
      // month's own calendar date is just that index into the timeline.
      const failedKey = result.failedAtMonth !== null ? timeline.keys[s + result.failedAtMonth] : null;
      cycles.push({ startKey: timeline.keys[s], failedKey, ...result });
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

    const failedCycles = cycles.filter((c) => c.failed);
    if (failedCycles.length) {
      failureListTitleEl.textContent = `Failed cycles (${failedCycles.length}) — start date → date it went to $0 or below`;
      failureListEl.innerHTML = failedCycles
        .map((c) => `<div class="failure-list-item">${formatMonthKey(c.startKey)}<span class="arrow">→</span>${formatMonthKey(c.failedKey)}</div>`)
        .join('');
      failureListSection.classList.remove('hidden');
    } else {
      failureListSection.classList.add('hidden');
    }

    resultsSection.classList.remove('hidden');
    lastRunCycles = cycles;
    lastRunYears = config.years;
    drawResultsChart(cycles, config.years);
  }

  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function formatMonthKey(key) {
    const [y, m] = key.split('-').map(Number);
    return `${MONTH_NAMES[m - 1]} ${y}`;
  }

  // Builds the value <-> [0,1] mapping the chart draws against, in either
  // linear or log mode — isolating the one real difference between the two
  // (how a dollar value maps to a vertical position) so drawResultsChart
  // and drawCycleDensity don't need to know which mode is active.
  function buildYMapper(cycles, useLog) {
    let yMin = 0;
    let yMax = 0;
    cycles.forEach((c) => c.trajectory.forEach((v) => {
      if (v < yMin) yMin = v;
      if (v > yMax) yMax = v;
    }));

    if (!useLog) {
      const pad = (yMax - yMin) * 0.05 || 1;
      const lo = yMin - pad;
      const hi = yMax + pad;
      const range = hi - lo || 1;
      return {
        log: false,
        lo,
        hi,
        toUnit: (v) => (v - lo) / range,
        ticks: (count) => {
          const out = [];
          for (let i = 0; i <= count; i++) out.push(lo + (i / count) * range);
          return out;
        },
      };
    }

    // Log mode: $0 and negative balances have no position on a log axis.
    // They're clamped to the smallest positive balance seen anywhere in
    // the data, so a failed cycle's negative dip still shows — flattened
    // into the bottom row — instead of silently vanishing.
    let floor = Infinity;
    cycles.forEach((c) => c.trajectory.forEach((v) => {
      if (v > 0 && v < floor) floor = v;
    }));
    if (!isFinite(floor)) floor = 1; // degenerate case: every cycle started at/below $0
    const hi = Math.max(yMax * 1.05, floor * 10);
    const logLo = Math.log10(floor);
    const logHi = Math.log10(hi);
    const range = logHi - logLo || 1;
    return {
      log: true,
      lo: floor,
      hi,
      toUnit: (v) => (Math.log10(Math.max(v, floor)) - logLo) / range,
      ticks: (count) => logTickValues(floor, hi, count),
    };
  }

  // Nice 1/2/5-per-decade log tick values (plain powers of ten alone would
  // skip straight from, say, $1M to $10M with nothing in between) —
  // coarsens to fewer steps per decade as the domain spans more of them,
  // so a wide range doesn't produce an unreadable wall of labels.
  function logTickValues(lo, hi, maxTicks) {
    if (!(lo > 0) || !(hi > lo)) return [lo, hi];
    const decades = Math.log10(hi / lo);
    const tiers = [[1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 5], [1, 5], [1]];
    const startTier = decades > 4 ? 2 : decades > 1.5 ? 1 : 0;
    const startExp = Math.floor(Math.log10(lo));
    const endExp = Math.ceil(Math.log10(hi));
    for (let tier = startTier; tier < tiers.length; tier++) {
      const ticks = [];
      for (let exp = startExp; exp <= endExp; exp++) {
        for (const m of tiers[tier]) {
          const v = m * Math.pow(10, exp);
          if (v >= lo && v <= hi) ticks.push(v);
        }
      }
      if (ticks.length <= maxTicks || tier === tiers.length - 1) return ticks;
    }
    return [];
  }

  // Renders cycle density as one <canvas> raster (not per-point SVG/DOM
  // elements) so a chart with hundreds or thousands of overlapping cycles
  // stays fast and doesn't bloat the page with interactive chart machinery
  // it doesn't need here — this view is a static image, not a hoverable
  // chart.
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

    const useLog = chartLogToggle.checked;
    const mapper = buildYMapper(cycles, useLog);
    const xForMonth = (m) => margin.left + (m / (cycles[0].trajectory.length - 1)) * innerWidth;
    const yForValue = (v) => margin.top + innerHeight - mapper.toUnit(v) * innerHeight;

    // Gridlines + Y axis labels
    const yTickCount = Math.max(3, Math.floor(innerHeight / 50));
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.fillStyle = '#adafb8'; // --text-secondary
    ctx.font = '11px "Google Sans", Roboto, Arial, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    mapper.ticks(yTickCount).forEach((v) => {
      const y = yForValue(v);
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(margin.left + innerWidth, y);
      ctx.stroke();
      ctx.fillText(formatDollarsCompact(v), margin.left - 8, y);
    });

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

    drawCycleDensity(ctx, cycles, margin, innerWidth, innerHeight, mapper);

    // Zero reference line — the failure threshold. Only meaningful in
    // linear mode; log mode has no position for $0 (see buildYMapper),
    // so it's skipped there in favor of the note next to the toggle.
    if (!useLog) {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(margin.left, yForValue(0));
      ctx.lineTo(margin.left + innerWidth, yForValue(0));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Snapshot the finished base chart (pre-hover) and remember the
    // geometry/data hover needs, so hovering is just a cheap restore +
    // overlay instead of a full re-render (or worse, re-binning density).
    lastChartSnapshot = ctx.getImageData(0, 0, resultsCanvas.width, resultsCanvas.height);
    lastChartGeometry = { margin, innerWidth, innerHeight, mapper, monthCount: cycles[0].trajectory.length, cycles };
    chartTooltip.classList.add('hidden');
  }

  // Plots cycle density rather than individual strokes: with hundreds or
  // thousands of overlapping cycles, stacking semi-transparent lines
  // either washes out to a flat blob wherever many lines cross the same
  // few pixels, or stays too faint to read where they don't — it doesn't
  // actually scale as a way to *see* density. This bins every trajectory
  // into a month x value-bucket grid instead (counted separately for
  // survived vs failed cycles) and paints each bin's own color — a blend
  // of green/red by its survived/failed mix, at an intensity reflecting
  // how crowded that bin is relative to the *other bins in the same
  // month* (not the whole grid): month 0 is identical for every cycle by
  // construction, so a single global peak would make every later, more
  // spread-out month look faint by comparison. Per-month normalization
  // keeps each point in time independently readable.
  function drawCycleDensity(ctx, cycles, margin, innerWidth, innerHeight, mapper) {
    const monthCount = cycles[0].trajectory.length;
    const yBins = Math.max(20, Math.min(220, Math.round(innerHeight / 3)));
    const survivedCounts = new Uint32Array(monthCount * yBins);
    const failedCounts = new Uint32Array(monthCount * yBins);

    cycles.forEach((c) => {
      const counts = c.failed ? failedCounts : survivedCounts;
      c.trajectory.forEach((v, m) => {
        let bin = Math.floor(mapper.toUnit(v) * yBins);
        if (bin < 0) bin = 0;
        if (bin >= yBins) bin = yBins - 1;
        counts[m * yBins + bin]++;
      });
    });

    const colWidth = innerWidth / monthCount;
    const rowHeight = innerHeight / yBins;
    const MIN_ALPHA = 0.1; // even a lone outlier cycle stays visible, just faint
    const GAMMA = 0.5; // compresses the dynamic range so moderately-dense bins don't look empty next to the single densest one
    const GREEN = [144, 229, 140];
    const RED = [255, 169, 175];

    for (let m = 0; m < monthCount; m++) {
      let colMax = 0;
      for (let b = 0; b < yBins; b++) {
        const total = survivedCounts[m * yBins + b] + failedCounts[m * yBins + b];
        if (total > colMax) colMax = total;
      }
      if (colMax === 0) continue;

      for (let b = 0; b < yBins; b++) {
        const s = survivedCounts[m * yBins + b];
        const f = failedCounts[m * yBins + b];
        const total = s + f;
        if (total === 0) continue;

        const failedRatio = f / total;
        const r = Math.round(GREEN[0] + (RED[0] - GREEN[0]) * failedRatio);
        const g = Math.round(GREEN[1] + (RED[1] - GREEN[1]) * failedRatio);
        const bl = Math.round(GREEN[2] + (RED[2] - GREEN[2]) * failedRatio);
        const alpha = MIN_ALPHA + (1 - MIN_ALPHA) * Math.pow(total / colMax, GAMMA);

        ctx.fillStyle = `rgba(${r},${g},${bl},${alpha.toFixed(3)})`;
        const x = margin.left + m * colWidth;
        const y = margin.top + innerHeight - (b + 1) * rowHeight;
        // Slight horizontal overlap (+1px) avoids sub-pixel seams between
        // adjacent month columns at non-integer scale factors.
        ctx.fillRect(x, y, colWidth + 1, rowHeight + 0.5);
      }
    }
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
