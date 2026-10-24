// Layout harness for the scheduling simulator's app shell.
//
// Opens index.html in headless Chrome over the DevTools protocol, applies the
// case matrix below, and checks the layout invariants from
// docs/superpowers/plans/2026-10-17-controls-toolbar.md.
//
// Run it from cpu_scheduling_simulation:
//   node tools/measure-layout.mjs
//   node tools/measure-layout.mjs --shots="%TEMP%\cpusched"
//   node tools/measure-layout.mjs --tab=events --shots="%TEMP%\cpusched"
//   node tools/measure-layout.mjs --results-tab=table --shots="%TEMP%\cpusched"
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
// Screenshot one specific tab. Measurement still runs on the default view.
const TAB = (process.argv.find((a) => a.startsWith('--tab=')) || '').slice('--tab='.length) || null;
const RESULTS_TAB = (process.argv.find((a) => a.startsWith('--results-tab=')) || '')
    .slice('--results-tab='.length) || null;

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
    // N covers the five-process case that filled the center pane past its edge.
    { id: 'N', rows: 5, algorithm: 'fcfs', width: 1024, height: 768, shut: false },
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
  const procTable = $('#process-table');
  const procScroll = procTable ? procTable.closest('.table-scroll') : null;
  const procBox = procScroll ? box(procScroll) : null;
  out.processTableInDrawer = !!$('#history-drawer #process-table');
  out.hasFirstRow = !!firstRow;
  out.processRowVisible = procBox
    ? [...document.querySelectorAll('#process-table-body tr')].some((row) => {
      const b = box(row);
      return b.y >= procBox.y - 1 && b.bottom <= procBox.bottom + 1;
    })
    : null;
  out.processHeaderVisible = out.hasFirstRow && procBox
    ? box($('#process-table thead th')).bottom <= procBox.bottom + 1 : null;
  out.processTableWidth = procBox ? procBox.w : null;
  // Tabs must expose one visible panel at a time and keep their selection
  // stable while the user moves between the process list and queue history.
  const panelVisible = (id) => {
    const el = document.getElementById(id);
    return !!el && !el.classList.contains('is-hidden') && el.getClientRects().length > 0;
  };
  const selectedTab = () => {
    const tab = $('#history-drawer [role="tab"][aria-selected="true"]');
    return tab ? tab.id : null;
  };
  const tabState = () => ({
    selected: selectedTab(),
    processes: panelVisible('processes-view'),
    frames: panelVisible('history-frames-view'),
    events: panelVisible('history-events-view'),
  });
  const tabProbe = { default: tabState() };
  const clickTab = (id) => { const el = document.getElementById(id); if (el) el.click(); };
  clickTab('history-view-frames');
  tabProbe.frames = tabState();
  clickTab('history-view-events');
  tabProbe.events = tabState();
  const eventList = document.getElementById('history-events');
  const eventView = document.getElementById('history-events-view');
  const eventBody = $('.drawer__body');
  const scrolls = (el) => {
    if (!el) return false;
    return ['auto', 'scroll'].includes(getComputedStyle(el).overflowY)
      && el.scrollHeight > el.clientHeight + 1;
  };
  out.eventsScroll = {
    view: scrolls(eventView),
    list: scrolls(eventList),
    body: scrolls(eventBody),
    viewScroll: eventView ? eventView.scrollHeight - eventView.clientHeight : null,
    listScroll: eventList ? eventList.scrollHeight - eventList.clientHeight : null,
  };
  clickTab('history-view-processes');
  tabProbe.processes = tabState();
  const tabList = $('#history-drawer [role="tablist"]');
  const key = (k) => {
    const tab = document.activeElement || $('#history-view-processes');
    if (tab && typeof tab.dispatchEvent === 'function') {
      tab.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    }
  };
  if (tabList) {
    $('#history-view-processes')?.focus();
    key('ArrowRight');
    tabProbe.arrowRight = tabState();
    key('ArrowRight');
    tabProbe.arrowRightTwice = tabState();
    key('ArrowLeft');
    tabProbe.arrowLeft = tabState();
    key('Home');
    tabProbe.home = tabState();
  }
  out.tabProbe = tabProbe;
  out.tabRoles = [...document.querySelectorAll('#history-drawer [role="tab"]')]
    .map((tab) => [tab.id, tab.getAttribute('aria-controls'), tab.getAttribute('tabindex')]);
  out.tabPanelRoles = [...document.querySelectorAll('#history-drawer [role="tabpanel"]')]
    .map((panel) => panel.id);
  // Results tabs: averages and the per-process table are alternatives. The
  // table measurements below run with the table selected, then restore the
  // default averages view for the screenshot.
  const resultsTabState = () => {
    const tab = $('#results-tablist [role="tab"][aria-selected="true"]');
    return {
      selected: tab ? tab.id : null,
      averages: panelVisible('results-averages-view'),
      table: panelVisible('results-table-view'),
    };
  };
  const resultsTabProbe = { default: resultsTabState() };
  clickTab('results-view-table');
  resultsTabProbe.table = resultsTabState();
  const resultsTabList = $('#results-tablist');
  if (resultsTabList) {
    $('#results-view-averages')?.focus();
    key('ArrowRight');
    resultsTabProbe.arrowRight = resultsTabState();
    $('#results-view-table')?.focus();
    key('ArrowLeft');
    resultsTabProbe.arrowLeft = resultsTabState();
    $('#results-view-table')?.focus();
    key('Home');
    resultsTabProbe.home = resultsTabState();
    $('#results-view-averages')?.focus();
    key('End');
    resultsTabProbe.end = resultsTabState();
  }
  clickTab('results-view-table');
  out.resultsTabProbe = resultsTabProbe;
  const opane = $('.pane--output');
  const timeline = $('.pane--timeline');
  out.timelineOverflow = timeline ? timeline.scrollHeight - timeline.clientHeight : null;
  const ts = $('#results-table').closest('.table-scroll');
  out.outputPaneOverflowTable = opane.scrollHeight - opane.clientHeight;
  out.resultsOverflowX = ts.scrollWidth - ts.clientWidth;
  const sr = box(ts);
  out.resultsColsCut = [...document.querySelectorAll('#results-table thead th')]
    .filter((th) => { const b = box(th); return b.x < sr.x - 1 || b.right > sr.right + 1; })
    .map((th) => th.textContent.trim());
  clickTab('results-view-averages');
  out.resultsTabProbe.averages = resultsTabState();
  out.resultsTabRoles = [...document.querySelectorAll('#results-tablist [role="tab"]')]
    .map((tab) => [tab.id, tab.getAttribute('aria-controls'), tab.getAttribute('tabindex')]);
  out.resultsTabPanelRoles = [...document.querySelectorAll('.panel--results [role="tabpanel"]')]
    .map((panel) => panel.id);
  out.outputPaneOverflowAverages = opane.scrollHeight - opane.clientHeight;
  out.outputPaneOverflow = Math.max(out.outputPaneOverflowTable, out.outputPaneOverflowAverages);
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
    // K is the short-window fallback: the output pane keeps its scroll there,
    // so the averages can be one small scroll away like the form.
    if (c.id !== 'K') want('averagesVisible', r.averagesVisible === true, r.averagesVisible);
    numeric('ganttOverflowX', r.ganttOverflowX, r.ganttOverflowX <= 0);
    numeric('lanesOverflowX', r.lanesOverflowX, r.lanesOverflowX <= 0);
    if (r.ganttAlignX !== null) {
        numeric('ganttAlignX', r.ganttAlignX, Math.abs(r.ganttAlignX) <= 1);
        numeric('ganttAlignW', r.ganttAlignW, Math.abs(r.ganttAlignW) <= 1);
        want('ganttAxisTicks', r.ganttAxisTicks >= 2, r.ganttAxisTicks);
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
    want('processTableInDrawer', r.processTableInDrawer === true, r.processTableInDrawer);
    if (c.rows > 0 && !c.shut) {
        want('processRowVisible', r.processRowVisible === true, r.processRowVisible);
        want('processHeaderVisible', r.processHeaderVisible === true, r.processHeaderVisible);
        numeric('processTableWidth', r.processTableWidth, r.processTableWidth >= 600);
    }
    const tabIds = (r.tabRoles || []).map(([id]) => id).join(',');
    want('tabRoles', tabIds === 'history-view-processes,history-view-frames,history-view-events', tabIds);
    want('tabAria', (r.tabRoles || []).every(([, controls, index]) =>
        controls && (index === '0' || index === '-1')), JSON.stringify(r.tabRoles));
    const panelIds = (r.tabPanelRoles || []).join(',');
    want('tabPanelRoles', panelIds === 'processes-view,history-frames-view,history-events-view', panelIds);
    if (!c.shut) {
        const tab = r.tabProbe || {};
        const tabOk = (state, selected, shown) => state
            && state.selected === selected
            && ['processes', 'frames', 'events'].every((view) => state[view] === shown.includes(view));
        want('tabDefault', tabOk(tab.default, 'history-view-processes', ['processes']), JSON.stringify(tab.default));
        want('tabFrames', tabOk(tab.frames, 'history-view-frames', ['frames']), JSON.stringify(tab.frames));
        want('tabEvents', tabOk(tab.events, 'history-view-events', ['events']), JSON.stringify(tab.events));
        want('tabProcesses', tabOk(tab.processes, 'history-view-processes', ['processes']), JSON.stringify(tab.processes));
        want('tabArrowRight', tabOk(tab.arrowRight, 'history-view-frames', ['frames']), JSON.stringify(tab.arrowRight));
        want('tabArrowTwice', tabOk(tab.arrowRightTwice, 'history-view-events', ['events']), JSON.stringify(tab.arrowRightTwice));
        want('tabArrowLeft', tabOk(tab.arrowLeft, 'history-view-frames', ['frames']), JSON.stringify(tab.arrowLeft));
        want('tabHome', tabOk(tab.home, 'history-view-processes', ['processes']), JSON.stringify(tab.home));
        const scrollers = ['view', 'list', 'body'].filter((key) => r.eventsScroll && r.eventsScroll[key]);
        want('eventsSingleScrollbar', scrollers.length <= 1, JSON.stringify(r.eventsScroll));
    }
    const resultTabIds = (r.resultsTabRoles || []).map(([id]) => id).join(',');
    want('resultsTabRoles', resultTabIds === 'results-view-averages,results-view-table', resultTabIds);
    want('resultsTabAria', (r.resultsTabRoles || []).every(([, controls, index]) =>
        controls && (index === '0' || index === '-1')), JSON.stringify(r.resultsTabRoles));
    const resultPanelIds = (r.resultsTabPanelRoles || []).join(',');
    want('resultsTabPanelRoles', resultPanelIds === 'results-averages-view,results-table-view', resultPanelIds);
    const rtab = r.resultsTabProbe || {};
    const resultTabOk = (state, selected, shown) => state
        && state.selected === selected
        && ['averages', 'table'].every((view) => state[view] === shown.includes(view));
    want('resultsTabDefault', resultTabOk(rtab.default, 'results-view-averages', ['averages']), JSON.stringify(rtab.default));
    want('resultsTabTable', resultTabOk(rtab.table, 'results-view-table', ['table']), JSON.stringify(rtab.table));
    want('resultsTabAverages', resultTabOk(rtab.averages, 'results-view-averages', ['averages']), JSON.stringify(rtab.averages));
    want('resultsTabArrowRight', resultTabOk(rtab.arrowRight, 'results-view-table', ['table']), JSON.stringify(rtab.arrowRight));
    want('resultsTabArrowLeft', resultTabOk(rtab.arrowLeft, 'results-view-averages', ['averages']), JSON.stringify(rtab.arrowLeft));
    want('resultsTabHome', resultTabOk(rtab.home, 'results-view-averages', ['averages']), JSON.stringify(rtab.home));
    want('resultsTabEnd', resultTabOk(rtab.end, 'results-view-table', ['table']), JSON.stringify(rtab.end));
    if (c.id !== 'K' && c.id !== 'J') {
        numeric('outputPaneOverflow', r.outputPaneOverflow, r.outputPaneOverflow <= 0);
    }
    // The merged 03/04 card holds six lanes at 1024x768; K is the short-window
    // fallback and 20-row runs keep the pane scroll as a safety valve.
    if (c.rows > 0 && c.rows <= 6 && c.height >= 768) {
        numeric('timelineOverflow', r.timelineOverflow, r.timelineOverflow <= 0);
    }
    if (!c.shut) {
        // K is the short-window fallback: panel 07 keeps its 20vh budget there
        // so the results averages stay on screen.
        const ratio = c.height <= 700 ? 0.2 : 0.28;
        const expected = Math.max(ratio * c.height, 160);
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
        // The last panel starts after a 330ms stagger, then rises for 700ms.
        // Leave a wide margin: a mid-rise transform adds a fractional offset
        // that rounds the output pane one pixel into scroll.
        await sleep(1500);

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
            if (TAB && SHOTS_DIR) {
                await evaluate(`document.getElementById(${JSON.stringify(`history-view-${TAB}`)})?.click()`);
            }
            if (RESULTS_TAB && SHOTS_DIR) {
                await evaluate(`document.getElementById(${JSON.stringify(`results-view-${RESULTS_TAB}`)})?.click()`);
            }
            if (SHOTS_DIR && (TAB || RESULTS_TAB)) await sleep(120);
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
