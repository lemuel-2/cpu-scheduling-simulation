# Controls Toolbar — Design

Date: 2026-10-17

Status: Approved in conversation. Ready for implementation planning.

Supersedes nothing. Builds on the uncommitted left-column and results work
described in §3.

## 1. Context and problem

The Controls panel (algorithm select, time quantum, time scrubber, Run, Step,
Reset, Clear, status badge) sits at the top of the left pane, above the Processes
panel. At 1024x768 with the history drawer expanded the left pane is 426px tall.
Controls measures roughly 280-300px and the process form 241px, so the two
together already exceed the pane. Scrolling the left pane to reach the process
list pushes Controls out of view, and scrolling back to reach Run pushes the
added process out of view.

The process form was pinned to the top of the pane in an earlier change, so the
form no longer scrolls away. Controls still does. A collapse toggle would only
move the problem: while collapsed, Run and Step are unreachable without
expanding and scrolling again.

## 2. Goal

Move the Controls panel out of the scrolling left column and into its own
horizontal toolbar row that spans the full width of the app shell, directly
under the app header. Then no control on the left can scroll out of reach.

Success criteria:

- At every supported width at or above 1024px, and with the history drawer both
  expanded and collapsed, the toolbar is fully visible without scrolling.
- The toolbar occupies a single row at 1024px and wider.
- The left pane contains no Controls panel and needs no scrolling to reach the
  process form, the Add process button, or an added process row.
- The Results pane keeps its current behaviour: no vertical pane scroll, no
  horizontal scroll, averages and column headers always visible.
- All scheduling results are unchanged; every existing test stays green.
- Keyboard order and screen-reader naming remain correct.

## 3. Prerequisites

The working tree already carries uncommitted changes to `index.html`,
`styles.css`, and `app.js`: the pinned process form in the left column and the
Results panel rework (averages strip, pinned heading and table header, tightened
result cells, widened output column). This design assumes those changes are
present. They must be committed before or as part of this work; otherwise the
height measurements in §6 are meaningless.

## 4. Approach

Chosen: **move the whole Controls section into a shell-level toolbar row.**

The section becomes the first child of `main.app-shell` instead of living inside
`div.pane--setup`. The shell gains a third grid row for it. Below 1024px the
shell stays a single column, so the section renders as the ordinary stacked
panel it is today.

Alternatives considered and rejected:

- **Collapse toggle on Controls.** While collapsed, Run and Step are not
  reachable, so the user expands and scrolls again. Moves the problem.
- **Compact run bar with a "More" button.** Keeps the algorithm and quantum
  fields in the left column, where they still scroll away with a long process
  list. Partial fix.
- **Move only the playback controls, leave algorithm and quantum in the left
  pane.** Same partial fix, plus the algorithm choice now lives in two places.

## 5. Shell layout

DOM change, in `index.html`: move the entire
`<section class="panel panel--controls" aria-labelledby="controls-heading">`
element out of `<div class="pane pane--setup">` and place it as the first child
of `<main class="app-shell" id="main-content">`, before `div.pane--setup`.
Nothing inside the section changes.

CSS, inside the existing `@media (min-width: 1024px)` block that owns the shell:
add the two `grid-template` declarations below to the existing `.app-shell` rule
at `styles.css:222`, and add the new `.panel--controls` rule:

```css
.app-shell {
  /* replaces the current grid-template-rows and grid-template-areas */
  grid-template-areas:
    "controls controls controls"
    "setup    timeline output"
    "history  history  history";
  grid-template-rows: auto minmax(0, 1fr) auto;
}
.panel--controls { grid-area: controls; }
```

`grid-area: controls` must stay inside the media query. Outside it there is no
`controls` grid area, and the declaration would create stray implicit lines.
Below 1024px the shell's `grid-template-columns: 1fr` and document order already
stack the sections correctly: Controls, then the three panes, then the drawer.

## 6. Height budget

At and above 1024px the available shell height is
`viewport height - header (50px) - shell padding (32px)`. The shell rows are the
toolbar (auto), the pane row (`minmax(0, 1fr)`), and the drawer (auto), separated
by two 16px gaps.

Toolbar height is 60px: the tallest child is a 36px control, plus
`var(--space-3) var(--space-4)` padding (12px vertical).

The drawer is reduced, at `styles.css:276`, from
`height: 30vh; min-height: 180px` to `height: 20vh; min-height: 160px`, in the
1024px-and-above block. Without that reduction
the toolbar's 60px comes straight out of the Results pane, which needs 426px of
content height and would start scrolling again. This is the deliberate cost of
the design: about four visible history rows instead of six, in exchange for no
pane scrolling anywhere.

| Window, drawer expanded | Pane row, drawer 30vh | Pane row, drawer 20vh | Results content needs |
|---|---|---|---|
| 1024x768 | 364px, scrolls 62px | 434px, fits | 426px |
| 1280x800 | 386px, scrolls 40px | 466px, fits | 426px |
| 1440x900 | 456px, fits | 546px, fits | 426px |

If a window is short enough that the panel minimum still exceeds the pane, the
pane's own scroll remains as the safety valve. Panes keep `overflow: auto`; the
design never sets `overflow: hidden` on a pane, because clipped content cannot be
scrolled at all.

## 7. Toolbar layout

All of the following lives inside the `@media (min-width: 1024px)` block, so the
section keeps its current stacked appearance on narrow screens. No markup change
is needed beyond the move.

- `.panel--controls` becomes `display: flex; flex-wrap: wrap;
  align-items: center; gap: var(--space-3) var(--space-4)` with padding
  `var(--space-3) var(--space-4)`.
- The `01 — CONTROLS` heading stays, with `margin-bottom: 0`. Keeping it holds
  the CSS panel counter steady, so Processes stays `02`, Gantt `03`, Queue `04`,
  Results `05`, History `06`.
- Each `.field` inside the toolbar lays out as a row: control on the right, with
  `gap: var(--space-2)` and `margin-bottom: 0`. The label goes visually hidden,
  as the measured note below explains.
- The form controls stop stretching: `.field__control { width: auto }` inside
  the toolbar so the select and the quantum input size to their content instead
  of 100%, and the quantum input is capped at `4rem`, because a number input's
  intrinsic width is about 180px.
- The time field flexes to absorb leftover width (`flex: 1 1 4rem`), selected
  with `.field:has(.scrubber)`, a selector form already used at
  `styles.css:356`. Inside it the scrubber also flexes
  (`width: auto; flex: 1 1 6rem`), and the readout loses its top margin and
  gains `white-space: nowrap`, without which it wrapped to two lines and doubled
  the row's height.
- The algorithm label, the time label, the fieldset legend and the quantum hint
  text all become visually hidden in toolbar mode, matching the existing
  `.sr-only` pattern at `styles.css:133`. They stay in the accessibility tree,
  each label still names its control, and the hint stays referenced by
  `aria-describedby`. Below 1024px every one of them remains visible as it is
  today.
- `.button-row { margin: 0 }` and the status badge gets `margin-left: auto`, so
  the badge sits at the right end of the row.

**Measured note, added during implementation (2026-10-17).** With Geist
actually loaded — the page fetches it from Google Fonts, and it is about 7%
wider than the fallback — the toolbar's contents needed roughly 1120px at a
1024px-wide window with the labels on screen, so the row wrapped. Hiding the
labels as described above brings it to about 890px for the five algorithms
without the quantum field and about 950px with Round Robin's quantum field
showing, both inside the 960px available, and the row lands at 60px tall. The
selected algorithm and the time readout already say what those controls are, and
every label survives for assistive technology.

## 8. Left pane

With Controls gone, `.pane--setup` holds the Processes panel only. The panel
reuses the pinned pattern already applied to Results:

- `.panel--processes` becomes a flex column: `display: flex; flex-direction:
  column; flex: 1 1 auto; min-height: 0`.
- Its heading, form, form error, and the `#process-empty` empty state do not
  shrink (`flex: 0 0 auto`); the form keeps its existing `position: sticky`.
- `.table-scroll` takes the leftover height with `flex: 1 1 auto`, a `4rem`
  floor, and `overflow: auto`, so only the process rows scroll.
- The process table header is pinned with `position: sticky; top: 0` on
  `#process-table thead th`.

The pane itself keeps `overflow: auto` as the short-window safety valve.

The empty state is unchanged: `app.js` keeps toggling `#process-empty` as it does
today, and with no processes the table box shows its header at the `4rem` floor
with the empty-state paragraph below it.

## 9. Interfaces

Unchanged: every element id, every class the JavaScript writes, and every ARIA
attribute inside the moved section. `app.js` selects elements by id only — a
search for `pane--setup`, `panel--controls`, and `controls-heading` in `app.js`
returns no matches — so the move requires no JavaScript change. All ids,
including `#algorithm`, `#time-quantum`, `#time-scrubber`, `#time-readout`,
`#run-simulation`, `#step-simulation`, `#reset-simulation`, `#clear-all`, and
`#simulation-status`, keep working.

The panel counter is driven by CSS `counter-increment` on `.panel__heading`,
with `counter-reset: panel` on `.app-shell`. The toolbar remains a child of
`.app-shell`, so the counter counts it once, in document order, and the numbering
in §7 holds. No `app.js` code reads or writes panel numbers.

## 10. Accessibility

- The section keeps `<section aria-labelledby="controls-heading">`, so it stays
  a named region landmark.
- Tab order from the top of the document reaches the algorithm select and the
  quantum input, then the time scrubber, then Run, Step, Reset, and Clear, and
  only then the process form fields. Playback controls before data entry is the
  expected order for a simulator.
- The moved element keeps its live regions: `#simulation-status` and
  `#time-readout` remain `aria-live="polite"`.
- The visually hidden quantum hint remains programmatically associated through
  `aria-describedby`; no information is conveyed by colour alone.
- Focus styling, dark theme, and `prefers-reduced-motion` handling are
  inherited from the existing `.panel` and `.button` rules and need no new work.

## 11. Non-goals

- Any change to scheduling algorithms, engine history, or their results.
- Any change to element ids, JavaScript behaviour, or the existing tests.
- A sticky or collapsible toolbar below 1024px. The section stays in normal
  document flow there; the page scrolls as a whole, which is the existing
  behaviour on narrow screens.
- Any change to the app header, the theme toggle, or the Gantt pane.
- Restyling the Controls controls themselves. Only their arrangement changes.

## 12. Testing and acceptance

Automated, run from `cpu_scheduling_simulation`:

- `node --test test_render.mjs` — 4 tests, must stay green. Predicted to pass:
  the file imports `buildSlices` only and asserts on no markup.
- `node --test test_scheduler.mjs` — 22 tests, must stay green. Same reasoning.

Layout, measured in real Chrome through the DevTools protocol at 1024x768,
1280x800, 1440x900, and 1920x1080, each with the drawer expanded and collapsed,
and with 6 and 20 processes:

- The toolbar exists as a direct child of `.app-shell`, is fully inside the
  viewport, and is 60px tall (one row, not wrapped) at 1024px and wider.
- The left pane contains no Controls heading or `#run-simulation`; the process
  form and the first process row are both on screen without scrolling, and the
  left pane reports no vertical overflow.
- The Results pane still reports zero vertical overflow, zero horizontal
  overflow, all five columns uncut, and the averages visible.
- The drawer reports the new height at each size.

Manual and reasoned:

- Tab order from the document start reaches the algorithm select, the scrubber,
  and Run before the PID input; focus is visible on each.
- Screenshots at 1024x768 and 1440x900 with the drawer expanded, reviewed by
  eye.

Honest limits: `jsdom` is not a project dependency, so no automated test covers
DOM order or CSS layout. The browser measurement and screenshots are the
evidence. `position: sticky` and flex sizing cannot be verified in `jsdom`.

## 13. Risks

| Risk | Mitigation |
|---|---|
| Toolbar wraps to two rows near 1024px, costing 60px more | Measured at 1024x768; the row is asserted to be a single line. If it wraps, shorten the algorithm select's visible width rather than the buttons. |
| The 60px toolbar plus a 20vh drawer still overflows on a very short window | The pane keeps `overflow: auto`; nothing is clipped or lost. |
| Drawer shows fewer history rows | Accepted and stated in §6. It is a preview; rows scroll. |
| Panel renumbering surprises | The `01 — CONTROLS` label stays, per §7. |
| Margin calls inside the toolbar (`align-items: center` with a 10px label beside a 36px control) look misaligned | Checked in screenshots during verification, adjusted then. |
