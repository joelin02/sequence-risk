(function () {
  const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;
  const ALLOC_TOLERANCE = 0.01;

  // Each of the three required uploads is { fileName, data } once loaded,
  // where data is a sorted [{date, price}] array — same shape as the chart
  // app, parsed by the same flexible CSV reader below.
  let stock = null;
  let bond = null;
  let inflation = null;

  // The fourth, synthetic series: inflation's own data compounded forward
  // at an extra user-specified real APY, re-derived any time the inflation
  // data or the real-yield field changes. Never rendered — see
  // buildInflationAdjustedSeries — just held here, ready for the backtest
  // engine to consume once it exists.
  let inflationAdjustedBonds = null;

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
  const runButton = document.getElementById('run-backtest');
  const runStatusEl = document.getElementById('run-status');

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

  // Recomputes everything that depends on loaded data or form state: the
  // synthetic bond series (data + real yield), the common date range
  // display, the allocation total, and whether the (still inert) backtest
  // button reads as ready. Cheap enough to just rerun in full on any change
  // rather than track fine-grained dependencies.
  function refreshDerivedState() {
    inflationAdjustedBonds = inflation
      ? buildInflationAdjustedSeries(inflation.data, Number(realYieldInput.value) || 0)
      : null;

    updateCommonRangeDisplay();
    updateAllocTotal();
    updateRunStatus();
  }

  // Linearly compounds the inflation series forward at an extra fixed real
  // APY on top of whatever inflation actually did between each pair of
  // points — modeled like an I-bond: no duration/mark-to-market, it just
  // marches up (or down, if realYieldApyPct is very negative) in lockstep
  // with realized inflation plus the spread. Starts at an arbitrary level
  // of 100 since only this series' own shape (not its absolute level)
  // feeds into a backtest's relative returns.
  function buildInflationAdjustedSeries(inflationData, realYieldApyPct) {
    if (!inflationData.length) return [];
    const realYield = realYieldApyPct / 100;
    const result = [{ date: inflationData[0].date, price: 100 }];
    for (let i = 1; i < inflationData.length; i++) {
      const prev = inflationData[i - 1];
      const curr = inflationData[i];
      const inflationGrowth = curr.price / prev.price;
      const dtYears = (curr.date - prev.date) / MS_PER_YEAR;
      const realGrowth = Math.pow(1 + realYield, dtYears);
      const prevLevel = result[result.length - 1].price;
      result.push({ date: curr.date, price: prevLevel * inflationGrowth * realGrowth });
    }
    return result;
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
    runButton.disabled = true; // backtest engine isn't built yet — stays off regardless of readiness
    if (reason) {
      runStatusEl.textContent = reason;
      runStatusEl.classList.remove('ready');
    } else {
      runStatusEl.textContent = '✓ All inputs look good — backtest engine coming in the next step.';
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

  // Initial paint: allocation inputs already have default values (70/15/15)
  // and nothing's loaded yet, so this just shows the correct starting
  // total and the "load data" prompt.
  refreshDerivedState();
})();
