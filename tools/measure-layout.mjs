// Layout harness for the scheduling simulator's app shell.
//
// Opens index.html in headless Chrome over the DevTools protocol, applies the
// case matrix below, and checks the layout invariants from
// docs/superpowers/plans/2026-10-17-controls-toolbar.md.
//
// Run it from cpu_scheduling_simulation:
//   node tools/measure-layout.mjs
//   node tools/measure-layout.mjs --shots="%TEMP%\cpusched"
//   node tools/measure-layout.mjs --keys      (report the Tab order instead)
//
// It needs Chrome at the path in CHROME, and Python on PATH for the static
// server: the page imports frontend/app.js as a module, which file:// blocks.
//
// The page loads Geist from Google Fonts with display=swap, and Geist is
// measurably wider than the fallback, so the harness waits for the font before
// measuring and refuses to report fallback-font numbers unless passed
// --allow-fallback-font (they wrap differently, so they are not what users see).
//
// Exit code 0 when every assertion holds, 1 otherwise.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const HTTP_PORT = 8776;
const CDP_PORT = 9236;

const shotsArg = process.argv.find((a) => a.startsWith('--shots='));
const SHOTS_DIR = shotsArg ? resolve(shotsArg.slice('--shots='.length)) : null;
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.slice('--only='.length).split(',').map((s) => s.trim().toUpperCase()) : null;
const ALLOW_FALLBACK = process.argv.includes('--allow-fallback-font');
const KEYS = process.argv.includes('--keys');
// Screenshot the hover link: the lane hover stays on for the shot instead of
// being cleared before it, so the shot shows what the pointer sees.
const KEEP_HOVER = process.argv.includes('--keep-hover');
// Screenshot in a named theme. Both themes carry the design, so both are worth
// a look; the toggle is idempotent per run, so the profile cannot drift.
const THEME = (process.argv.find((a) => a.startsWith('--theme=')) || '').slice('--theme='.length) || null;

// rows, algorithm, viewport, drawer state
const CASES = [
    { id: 'A', rows: 6, algorithm: 'fcfs', width: 1024, height: 768, shut: false },
    { id: 'B', rows: 6, algorithm: 'fcfs', width: 1024, height: 768, shut: true },
    { id: 'C', rows: 6, algorithm: 'fcfs', width: 1280, height: 800, shut: false },
    { id: 'D', rows: 6, algorithm: 'fcfs', width: 1440, height: 900, shut: false },
    { id: 'E', rows: 20, algorithm: 'fcfs', width: 1440, height: 900, shut: false },
    { id: 'F', rows: 20, algorithm: 'fcfs', width: 1920, height: 1080, shut: false },
    { id: 'G', rows: 20, algorithm: 'fcfs', width: 1024, height: 768, shut: false },
    { id: 'H', rows: 6, algorithm: 'rr', width: 1024, height: 768, shut: false },
    { id: 'I', rows: 6, algorithm: 'srtf', width: 1024, height: 768, shut: false },
    { id: 'J', rows: 0, algorithm: 'fcfs', width: 1024, height: 768, shut: false },
    { id: 'K', rows: 6, algorithm: 'fcfs', width: 1024, height: 620, shut: false },
    { id: 'L', rows: 1, algorithm: 'fcfs', width: 1440, height: 900, shut: false },
    // M stops the cursor mid-run: the row and the lanes must still share a scale.
    { id: 'M', rows: 6, algorithm: 'fcfs', width: 1440, height: 900, shut: false, cursor: 9 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, tries = 60) {
    for (let i = 0; i < tries; i++) {
        try {
            const res = await fetch(url);
            if (res.ok) return res;
        } catch { /* not up yet */ }
        await sleep(200);
    }
    throw new Error(`timed out waiting for ${url}`);
}

function setupScript(c) {
    const burst = c.id === 'L' ? '(i === 1 ? 120 : (i % 6) + 1)' : '(i % 6) + 1';
    return `(() => {
  const $ = (s) => document.querySelector(s);
  $('#clear-all').click();
  for (let i = 1; i <= ${c.rows}; i++) {
    $('#pid').value = 'P' + i;
    $('#arrival-time').value = i % 4;
    $('#burst-time').value = ${burst};
    $('#priority').value = i % 5;
    $('#process-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  }
  $('#algorithm').value = '${c.algorithm}';
  $('#algorithm').dispatchEvent(new Event('change', { bubbles: true }));
  window.__keepHover = ${KEEP_HOVER};
  ${THEME ? `if (document.documentElement.dataset.theme !== '${THEME}') $('#theme-toggle').click();` : ''}
  $('#run-simulation').click();
  if (${c.cursor ?? -1} >= 0) {
    const scrub = $('#time-scrubber');
    scrub.value = String(${c.cursor ?? 0});
    scrub.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const drawer = $('#history-drawer');
  if (drawer.classList.contains('is-collapsed') !== ${c.shut}) $('#history-toggle').click();
  window.__setup = {
    rows: document.querySelectorAll('#process-table-body tr').length,
    fieldErrors: [...document.querySelectorAll('.field__error:not(.is-hidden)')].map((e) => e.textContent.trim()),
    formError: $('#process-form-error').classList.contains('is-hidden') ? null : $('#process-form-error').textContent.trim(),
    emptyShown: !$('#process-empty').classList.contains('is-hidden'),
    status: $('#simulation-status').textContent.trim(),
  };
  return true;
})();`;
}

const PROBE = `(() => {
  const $ = (s) => document.querySelector(s);
  const box = (el) => { const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top),
             w: Math.round(r.width), h: Math.round(r.height),
             bottom: Math.round(r.bottom), right: Math.round(r.right) }; };
  const pane = $('.pane--setup');
  const out = { viewport: innerWidth + 'x' + innerHeight };
  const toolbar = $('.app-shell > .panel--controls');
  out.toolbarPresent = !!toolbar;
  if (toolbar) {
    const t = box(toolbar);
    out.toolbarBox = t;
    out.toolbarOnScreen = t.y >= 0 && t.bottom <= innerHeight + 1;
    out.toolbarOverflowsX = toolbar.scrollWidth > toolbar.clientWidth + 1;
    out.toolbarChildren = [...toolbar.children].map((el) => [
      (el.className || el.tagName).toString().split(' ')[0],
      box(el).w, box(el).h,
    ]);
    const fs = toolbar.querySelector('.fieldset');
    out.fieldsetChildren = fs ? [...fs.children].map((el) => [
      (el.className || el.tagName).toString().split(' ')[0], box(el).w, box(el).h,
    ]) : null;
  }
  out.controlsInsidePane = !!$('.pane--setup .panel--controls');
  out.runInsidePane = !!$('.pane--setup #run-simulation');
  out.leftPaneOverflow = pane.scrollHeight - pane.clientHeight;
  const form = box($('#process-form'));
  const pr = box(pane);
  out.paneBox = pr;
  out.paneScrollTop = pane.scrollTop;
  const tf = $('#time-scrubber').closest('.field');
  const tcs = getComputedStyle(tf);
  out.timeField = {
    dir: tcs.flexDirection, wrap: tcs.flexWrap, align: tcs.alignItems,
    h: box(tf).h, w: box(tf).w,
    scrubber: box($('#time-scrubber')), readout: box($('#time-readout')),
  };
  out.formBox = form;
  out.formPosition = getComputedStyle($('#process-form')).position;
  out.formVisible = form.y >= pr.y - 1 && form.bottom <= pr.bottom + 1;
  const firstRow = $('#process-table-body tr');
  out.hasFirstRow = !!firstRow;
  out.firstRowVisible = firstRow ? box(firstRow).bottom <= pr.bottom + 1 : null;
  out.processHeaderVisible = out.hasFirstRow
    ? box($('#process-table thead th')).bottom <= pr.bottom + 1 : null;
  const opane = $('.pane--output');
  const ts = $('#results-table').closest('.table-scroll');
  out.outputPaneOverflow = opane.scrollHeight - opane.clientHeight;
  out.resultsOverflowX = ts.scrollWidth - ts.clientWidth;
  const sr = box(ts);
  out.resultsColsCut = [...document.querySelectorAll('#results-table thead th')]
    .filter((th) => { const b = box(th); return b.x < sr.x - 1 || b.right > sr.right + 1; })
    .map((th) => th.textContent.trim());
  out.averagesVisible = box($('#results-averages')).bottom <= box(opane).bottom + 1;
  out.pageOverflowX = document.documentElement.scrollWidth - innerWidth;
  // The lanes share the CPU row's time axis: tick 0 of the first lane sits under
  // tick 0 of the row and both tracks span the same width, or the column stops
  // reading as one axis.
  const gantt = $('#gantt-chart');
  const gRow = $('#gantt-bars');
  const gLane = $('#gantt-lanes .lane__track');
  out.ganttOverflowX = gantt.scrollWidth - gantt.clientWidth;
  const gLanesBox = $('#gantt-lanes');
  out.lanesOverflowX = gLanesBox ? gLanesBox.scrollWidth - gLanesBox.clientWidth : 0;
  out.ganttAlignX = gLane ? box(gLane).x - box(gRow).x : null;
  out.ganttAlignW = gLane ? box(gLane).w - box(gRow).w : null;
  out.ganttAxisTicks = gLane ? $('#gantt-lanes .lane__track--axis').children.length : 0;
  // Every slice is at least one label wide, so a visible PID must not be
  // transparent and the narrowest slice must clear the 24px tick floor.
  const slices = [...document.querySelectorAll('#gantt-bars .gantt__slice')];
  out.ganttMinSlice = slices.length ? Math.min(...slices.map((el) => box(el).w)) : null;
  out.ganttLabelsHidden = [...document.querySelectorAll(
    '#gantt-bars .gantt__slice:not(.gantt__slice--idle) .gantt__bar')]
    .filter((el) => {
      const rgba = getComputedStyle(el).color.match(/rgba?\\(([^)]+)\\)/);
      if (!rgba) return false;
      const parts = rgba[1].split(',').map(Number);
      return parts.length > 3 && parts[3] === 0;
    }).length;
  // The two scroll views must move together. Drive the CPU row and read the
  // lanes back, then return both to the start for the alignment probes.
  const ganttScroll = $('.gantt__scroll');
  out.scrollSync = null;
  out.laneNameSticky = null;
  if (ganttScroll && gLanesBox && ganttScroll.scrollWidth > ganttScroll.clientWidth) {
    const firstName = $('#gantt-lanes .lane__name');
    const nameX = firstName ? box(firstName).x : null;
    ganttScroll.scrollLeft = 40;
    out.scrollTarget = Math.round(ganttScroll.scrollLeft);
    ganttScroll.dispatchEvent(new Event('scroll'));
    out.scrollSync = Math.round(gLanesBox.scrollLeft);
    out.laneNameSticky = firstName ? box(firstName).x - nameX : null;
    ganttScroll.scrollLeft = 0;
    ganttScroll.dispatchEvent(new Event('scroll'));
  }
  // A process's lane bar must start where that same process's bar starts in the
  // CPU row, whatever the cursor is: one time axis, or the column lies.
  out.ganttBarOffsets = [...document.querySelectorAll('#gantt-lanes .lane')]
    .filter((lane) => lane.querySelector('.lane__bar'))
    .map((lane) => {
      const pid = lane.querySelector('.lane__name').textContent.trim();
      const rowBar = [...document.querySelectorAll('#gantt-bars .gantt__bar')]
        .find((bar) => bar.textContent.trim() === pid);
      return [pid, rowBar ? Math.round(lane.querySelector('.lane__bar').getBoundingClientRect().left
        - rowBar.getBoundingClientRect().left) : null];
    });
  out.drawerShut = $('#history-drawer').classList.contains('is-collapsed');
  out.drawerH = box($('#history-drawer')).h;
  out.setup = window.__setup || null;
  // Hovering a lane must light that one process everywhere. The highlight keys
  // off the process's position, never the colour slot, which wraps at eight.
  const lane = $('#gantt-lanes .lane');
  if (lane) {
    out.hoverPid = lane.querySelector('.lane__name').textContent.trim();
    lane.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const hot = [...document.querySelectorAll('.is-hot')];
    out.hoverHotCount = hot.length;
    out.hoverKeys = [...new Set(hot.map((el) => el.dataset.processKey))];
    out.hoverReadout = ($('#lane-readout') || { textContent: '' }).textContent.trim();
    // The shot mode keeps the light on, to photograph the state.
    if (!window.__keepHover) {
      $('#gantt-lanes').dispatchEvent(new MouseEvent('mouseleave'));
      out.hoverAfterLeave = document.querySelectorAll('.is-hot').length;
    }
  }
  return out;
})()`;

function check(r, c) {
    const bad = [];
    const want = (name, ok, detail) => { if (!ok) bad.push(`${name}${detail !== undefined && detail !== true ? `=${detail}` : ''}`); };
    const numeric = (name, value, ok) => want(name, ok, value);

    want('toolbarPresent', r.toolbarPresent === true, r.toolbarPresent);
    if (r.toolbarPresent) {
        want('toolbarOnScreen', r.toolbarOnScreen === true, r.toolbarOnScreen);
        numeric('toolbarBox.h', r.toolbarBox && r.toolbarBox.h,
            r.toolbarBox && r.toolbarBox.h >= 56 && r.toolbarBox.h <= 72);
        want('toolbarOverflowsX', r.toolbarOverflowsX === false, r.toolbarOverflowsX);
    }
    want('controlsInsidePane', r.controlsInsidePane === false, r.controlsInsidePane);
    want('runInsidePane', r.runInsidePane === false, r.runInsidePane);
    numeric('pageOverflowX', r.pageOverflowX, r.pageOverflowX <= 0);
    numeric('resultsOverflowX', r.resultsOverflowX, r.resultsOverflowX <= 0);
    want('resultsColsCut', r.resultsColsCut.length === 0, r.resultsColsCut.join(','));
    want('averagesVisible', r.averagesVisible === true, r.averagesVisible);
    numeric('ganttOverflowX', r.ganttOverflowX, r.ganttOverflowX <= 0);
    // The rows scroll by design once a run is long enough; the page itself must
    // not. The alignment checks below still run at scroll position 0.
    if (r.ganttAlignX !== null) {
        numeric('ganttAlignX', r.ganttAlignX, Math.abs(r.ganttAlignX) <= 1);
        numeric('ganttAlignW', r.ganttAlignW, Math.abs(r.ganttAlignW) <= 1);
        want('ganttAxisTicks', r.ganttAxisTicks >= 2, r.ganttAxisTicks);
        numeric('ganttMinSlice', r.ganttMinSlice, r.ganttMinSlice === null || r.ganttMinSlice >= 23);
        numeric('ganttLabelsHidden', r.ganttLabelsHidden, r.ganttLabelsHidden === 0);
        if (r.scrollSync !== null) {
            numeric('scrollSync', r.scrollSync, Math.abs(r.scrollSync - r.scrollTarget) <= 1);
            numeric('laneNameSticky', r.laneNameSticky, Math.abs(r.laneNameSticky) <= 1);
        }
        const off = r.ganttBarOffsets.filter(([, dx]) => dx === null || Math.abs(dx) > 1);
        want('ganttBarOffsets', off.length === 0, off.map(([pid, dx]) => `${pid}:${dx}`).join(' '));
    }
    if (r.hoverHotCount !== undefined) {
        want('hoverKeysMixed', r.hoverKeys.length === 1, r.hoverKeys.join(','));
        want('hoverFanout', r.hoverHotCount >= 4, r.hoverHotCount);
        want('hoverReadout', r.hoverReadout.startsWith(`${r.hoverPid} \u00b7 `), r.hoverReadout);
        // Unset in --keep-hover: the light is deliberately left on for the shot.
        if (r.hoverAfterLeave !== undefined) {
            numeric('hoverAfterLeave', r.hoverAfterLeave, r.hoverAfterLeave === 0);
        }
    } else {
        // Lanes on the page and no hover reading: the check skipped itself.
        want('hoverRan', r.ganttAlignX === null, r.ganttAlignX);
    }
    // K is a 620px-tall window, below the 768px the layout is designed for.
    // There the pane keeps its scroll as the documented safety valve, so the
    // form's lower edge is one small scroll away instead of on screen.
    if (c.id !== 'K') want('formVisible', r.formVisible === true, r.formVisible);
    if (c.id !== 'K') numeric('leftPaneOverflow', r.leftPaneOverflow, r.leftPaneOverflow <= 0);
    if (c.rows > 0) {
        want('firstRowVisible', r.firstRowVisible === true, r.firstRowVisible);
        want('processHeaderVisible', r.processHeaderVisible === true, r.processHeaderVisible);
    }
    if (c.id !== 'K' && c.id !== 'J') {
        numeric('outputPaneOverflow', r.outputPaneOverflow, r.outputPaneOverflow <= 0);
    }
    if (!c.shut) {
        const expected = Math.max(0.2 * c.height, 160);
        numeric('drawerH', r.drawerH, Math.abs(r.drawerH - expected) <= 2);
    }
    return bad;
}

async function main() {
    const server = spawn('python', ['-m', 'http.server', String(HTTP_PORT), '--bind', '127.0.0.1'],
        { cwd: APP_DIR, stdio: 'ignore' });
    const profile = mkdtempSync(join(tmpdir(), 'layout-'));
    const chrome = spawn(CHROME, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });
    const stop = () => {
        try { chrome.kill(); } catch { /* already gone */ }
        try { server.kill(); } catch { /* already gone */ }
    };
    process.on('exit', stop);

    let ws;
    try {
        await waitFor(`http://127.0.0.1:${HTTP_PORT}/index.html`);
        await waitFor(`http://127.0.0.1:${CDP_PORT}/json/version`);
        const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        const page = targets.find((t) => t.type === 'page');
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

        let nextId = 0;
        const pending = new Map();
        const events = [];
        ws.onmessage = (raw) => {
            const msg = JSON.parse(raw.data);
            if (msg.id && pending.has(msg.id)) {
                pending.get(msg.id)(msg);
                pending.delete(msg.id);
            } else {
                events.push(msg);
            }
        };
        const send = (method, params = {}) => new Promise((res) => {
            const id = ++nextId;
            pending.set(id, res);
            ws.send(JSON.stringify({ id, method, params }));
        });
        const evaluate = async (expression) => {
            const msg = await send('Runtime.evaluate',
                { expression, returnByValue: true, awaitPromise: true });
            if (msg.result && msg.result.exceptionDetails) {
                throw new Error(msg.result.exceptionDetails.exception?.description
                    || msg.result.exceptionDetails.text);
            }
            return msg.result?.result?.value;
        };

        await send('Runtime.enable');
        await send('Page.enable');

        // The app is an ES module and wires its listeners at evaluation time.
        // Importing it from the page is the exact signal that it has run: a
        // repeat import returns the cached module, so this cannot double-run it.
        const reload = async () => {
            await send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/index.html` });
            let ready = false;
            for (let i = 0; i < 100 && !ready; i++) {
                try {
                    ready = await evaluate("import('./frontend/app.js').then(() => true)");
                } catch { /* module still loading */ }
                if (!ready) await sleep(200);
            }
            if (!ready) throw new Error('app.js never finished loading');
        };

        await reload();
        await sleep(900); // let the 700ms rise animation finish

        // Wait for the webfont swap, capped so an offline run cannot hang here.
        const fontExpr = "Promise.race([document.fonts.ready,"
            + " new Promise((r) => setTimeout(r, 15000))])"
            + ".then(() => document.fonts.check('16px Geist')"
            + " && document.fonts.check('16px \"Geist Mono\"'))";
        const fontsLoaded = await evaluate(fontExpr);
        if (!fontsLoaded) {
            console.log('Geist did not load, so every width below would be the fallback font\'s');
            console.log('and the wrap decisions would not match what users see.');
            if (!ALLOW_FALLBACK) {
                console.log('Re-run with network access, or pass --allow-fallback-font to measure');
                console.log('the fallback anyway.');
                process.exitCode = 1;
                return;
            }
            console.log('--allow-fallback-font given: measuring the fallback font anyway.');
        }

        if (SHOTS_DIR) mkdirSync(SHOTS_DIR, { recursive: true });

        if (KEYS) {
            // Tab from a freshly loaded document, which is what "press Tab from
            // the address bar" means: no click has moved the focus start point.
            // Round Robin is selected through the value, not the mouse, so the
            // quantum field is in the ring too.
            await send('Emulation.setDeviceMetricsOverride',
                { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
            await reload();
            await sleep(400);
            await evaluate(`(() => {
  const a = document.querySelector('#algorithm');
  a.value = 'rr';
  a.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
            const focus = () => evaluate(`(() => {
  const el = document.activeElement;
  if (!el) return null;
  const cs = getComputedStyle(el);
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    text: (el.textContent || '').trim().slice(0, 20),
    label: el.getAttribute('aria-label'),
    focusVisible: (cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px')
      || cs.boxShadow !== 'none',
  };
})()`);
            console.log(`start: ${JSON.stringify(await focus())}`);
            for (let i = 1; i <= 12; i++) {
                const key = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 };
                await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
                await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
                await sleep(60);
                console.log(`${String(i).padStart(2)}: ${JSON.stringify(await focus())}`);
            }
            return;
        }

        let failures = 0;
        const selected = ONLY ? CASES.filter((x) => ONLY.includes(x.id)) : CASES;
        if (!selected.length) {
            console.log(`--only=${ONLY.join(',')} matches no case; known cases are`
                + ` ${CASES.map((c) => c.id).join(', ')}.`);
            process.exitCode = 1;
            return;
        }
        if (ONLY) console.log(`running ${selected.length} of ${CASES.length} cases\n`);
        for (const c of selected) {
            await send('Emulation.setDeviceMetricsOverride',
                { width: c.width, height: c.height, deviceScaleFactor: 1, mobile: false });
            await sleep(250);
            const r = await evaluate(`${setupScript(c)}\n${PROBE}`);
            if (SHOTS_DIR) {
                const shot = await send('Page.captureScreenshot', { format: 'png' });
                writeFileSync(join(SHOTS_DIR, `${c.id}_${c.width}x${c.height}_rows${c.rows}.png`),
                    Buffer.from(shot.result.data, 'base64'));
            }
            const bad = check(r, c);
            failures += bad.length ? 1 : 0;
            const label = `${c.id} ${String(c.width).padStart(4)}x${c.height} rows=${String(c.rows).padStart(2)} ${c.algorithm.padEnd(4)} drawer=${c.shut ? 'shut' : 'open'}`;
            console.log(`${label}  ${bad.length ? `FAIL ${bad.join(', ')}` : 'ok'}`);
            if (bad.length) console.log(`     ${JSON.stringify(r)}`);
        }

        const errors = events
            .filter((e) => e.method === 'Runtime.exceptionThrown')
            .map((e) => e.params?.exceptionDetails?.exception?.description || e.params?.exceptionDetails?.text);
        if (errors.length) {
            console.log(`page errors: ${errors.length}`);
            for (const e of errors) console.log(`  ${e}`);
            failures += 1;
        }
        console.log(failures
            ? `\n${failures} of ${selected.length} case(s) failed`
            : `\nall ${selected.length} case(s) pass`);
        process.exitCode = failures ? 1 : 0;
    } finally {
        try { ws?.close(); } catch { /* already closed */ }
        stop();
    }
}

await main();
