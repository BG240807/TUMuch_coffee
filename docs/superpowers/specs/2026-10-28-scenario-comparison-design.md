# Scenario comparison

Add an English comparison card showing added trees, added buildings, removed buildings,
and the sum of added tree canopy areas. The baseline is the unedited city, including
after session restoration. Canopy area uses each placed tree's rendered radius;
overlap is counted and this is not city-wide coverage or an environmental prediction.

## Approaches

- Selected: add one import/initialization line to `index.html`, a module, and CSS.
  Pass the existing live arrays into the module; keep all existing logic unchanged.
- Rejected: a separate entry page would duplicate the application or require a wrapper.
- Rejected: refactoring the editor into shared state would expand the requested scope.

Original/Proposal buttons switch the same camera view. Original hides placed objects
and uses a separate copy of the existing vector building layer, so removed buildings
reappear even while navigating to newly loaded tiles. It temporarily selects Navigate
and disables editing controls; Proposal restores the previously active tool.
Neither switching nor statistics write to storage or mutate proposal arrays.
Hide asynchronous imports before rendering so they never flash in Original.

Follow existing floating-card styles, native ES modules, and 250 ms counter refresh.
No runtime dependencies, changes to existing business logic, or climate modeling.
Test real browser interactions, undo/restore, refresh, repeated switching, original-mode
editing protection, async tree imports, keyboard use, and responsive placement.
