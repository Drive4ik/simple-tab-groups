# Reference: Firefox behavior with extension menus (browser.menus)

Verified live on Firefox 154 (August 2026) with the throwaway test add-on (`test-addon/`,
round-11), in a clean profile with no other add-ons. Every fact here is one browser build on one machine; a claim is as
strong as the runs cited next to it, and no stronger.

Only facts confirmed by an actual test run belong here — never assumptions about how the browser
"probably" works. The scope is the **registration lifecycle inside one extension session**:
creation, duplication, removal, `removeAll`, and how the optional `bookmarks` permission gates
bookmark-context items. What menus survive across a browser or extension restart is deliberately
NOT here — a temporary add-on dies or is reinstalled by the very action being measured; those are
lifecycle facts in the sense of BEHAVIOR-NOTATION.md §7 and need the two-addon stand.

State tables, markers, confirmation rules and how the tests are written — BEHAVIOR-NOTATION.md.

**A new fact is appended as the next number at the end of the numbered sections, right before
"Implications for STG code". Numbers are never renumbered or reused** — code comments reference
them by number (`docs/MENUS-BEHAVIOR.md §5`).

There is no `menus.getAll` — existence is probed with `menus.update(id, {enabled: true})`:
resolves if the item is registered, rejects with the §3 error if it is not. The probe is itself
validated: true right after a successful create, false right after a remove. (R11.01, R11.02)

---

## 1. A duplicate id is refused, the existing item is untouched

`menus.create` with an id that is already registered fails; the first item stays registered and
keeps working. The error is delivered through `browser.runtime.lastError` in the create callback.
(R11.01)

| action | outcome |
| - | - |
| `menus.create({id: 'dup'})` | ok |
| `menus.create({id: 'dup'})` again | fails — `ID already exists: dup` |
| probe `dup` | still registered |

## 2. Removing a parent removes its whole subtree

One `menus.remove(parent)` takes children and grandchildren with it — no per-child removal is
needed, and after it every descendant id probes as unregistered. (R11.02)

| action | outcome |
| - | - |
| `menus.remove(parent)` — parent has `child1`, `child2`, `grandchild` under `child1` | ok |
| probe `parent`, `child1`, `child2`, `grandchild` | all unregistered |

## 3. remove and update of an unknown id fail with the same error

Both reject with `Cannot find menu item with id <id>`. (R11.03)

| action | outcome |
| - | - |
| `menus.remove('nope')` | fails — `Cannot find menu item with id nope` |
| `menus.update('nope', …)` | fails — `Cannot find menu item with id nope` |

## 4. removeAll clears everything and tolerates empty

`menus.removeAll()` removes top-level and nested items alike, and resolves fine when there is
nothing to remove. (R11.04)

| action | outcome |
| - | - |
| `menus.removeAll()` — `top1`, `top2`, `nested` under `top1` exist | ok, all three unregistered |
| `menus.removeAll()` on empty | ok |

## 5. The bookmarks permission gates only the display, never the registration

The whole registration API is permission-blind for bookmark-context items; the permission is
checked only when the browser builds a bookmark's context menu. (R11.05, R11.06)

Without the `bookmarks` permission ever granted (R11.05):

| action | outcome |
| - | - |
| `menus.create({contexts: ['bookmark']})` | ok |
| `menus.update` of that item | ok |
| `menus.remove` of that item | ok |

Across grant → revoke → re-grant (R11.06; display checked by eye 👁️):

| action | outcome |
| - | - |
| grant, create parent + child with bookmark context | ok; 👁️ both shown in a bookmark's context menu |
| revoke the permission | 👁️ items disappear from the context menu |
| `menus.create` with the parent's id while revoked | fails — `ID already exists: bm-parent` — the item is still registered |
| `menus.update` of the parent while revoked | ok |
| `menus.remove` of the child while revoked | ok |
| re-grant | 👁️ the item is shown again — the same registered item (its duplicate create still fails) |

The browser never unregisters a menu item on a permission change — hiding while revoked and
showing after re-grant is pure display logic over the same registration.

---

## Implications for STG code

- The mirror in `menus.js` can rely on cascade removal (§2): removing a parent from the browser
  and dropping the descendants from the mirror only is correct.
- The mirror check in `Menus.create`/`update`/`remove` fires before any browser call, so an honest
  programming error (removing what was never created, creating a taken id) is caught by the mirror
  with §1/§3 as the browser-side backstop.
- On a `bookmarks` permission revoke the add-on must remove its bookmark menus itself (§5) — the
  browser only hides them, and a later re-grant collides with the leftovers (§1). Removal and
  update need no permission, so the cleanup is always allowed.
- `Menus.removeAll` at startup (`MenusMain.create`) is the recovery primitive: it clears anything
  the browser may have kept or restored regardless of mirror state (§4).
