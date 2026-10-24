# Events — the add-on's own actions are muted, the user's are mirrored

How the handlers of the browser events in `addon/src/js/tabs.js` and `windows.js` tell the
add-on's own actions from the user's, what the add-on does about other add-ons, and how an own
action is awaited by its event (`downloads.js`). Events are subscribed through
`addon/src/js/listeners.js` (the MV3-ready module); the browser facts are in
`BEHAVIOR-CREATE-TABS.md`, `BEHAVIOR-MOVE-TABS.md`, `BEHAVIOR-REMOVE-TABS.md`,
`BEHAVIOR-TABGROUPS.md` and `BEHAVIOR-DOWNLOADS.md`.

## 1. The add-on's own actions are muted in the events

A flow that creates, moves or hides tabs itself marks them with skip flags (`skipTracking`,
`skip.created`, for whole windows `skipTrackingWindow`) for the time of the operation. The flag
of a `tabsAction` is set before the call and removed right at its resolve: for a move, a hide and
a show the browser delivers the events of the call before the promise resolves
(`BEHAVIOR-MOVE-TABS.md` §2, `BEHAVIOR-CREATE-TABS.md` §62), so the synchronous skip check at the
top of a handler still sees the flag. Two flags can come later than the events they mute:
`skip.created` is set once `tabs.create` has resolved, and `skipTrackingWindow` of a restored
window is set by `windows.onCreated`; `onCreated`, `onUpdated` and `onActivated` wait at their
start (`Utils.wait(50–70)`) before they judge, and `onUpdated` reads the tab fresh from the
browser after the wait — an operation may have started meanwhile. The attach and the detach of a
move are muted per tab only: they can be delivered before `windows.onCreated`
(`BEHAVIOR-TABGROUPS.md` §17), a window flag is always too late for them. A handler must remember
that its snapshot of the tab may be older than reality. The mute covers what the add-on's own
actions change: a pin is the user's under the mute too, and `tabs.onUpdated` drops the group and
the sub-group of a pinned tab in its muted branch as well (`DESIGN-GROUPS.md` §1).

## 2. The user's actions are mirrored into the add-on

They go through the filter of the add-on's logic: a new tab is bound to the group of its window,
the catch rules, a hidden tab loses its group, and so on.

## 3. Other add-ons do strange things — the add-on obeys, it does not fight

Another add-on hid a tab — the user wanted it that way: the tab loses its group, STG does not
restore it and does not fight back. STG is not obliged to handle the crookedness of others.
There are backups.

These policies are deliberate decisions. They are not changed in passing while fixing a bug.

## 4. The end of an own action is awaited by its event

Where the browser announces the end of an action of the add-on with an event, the add-on waits
for the event, it does not poll the API. `Downloads.download` (`addon/src/js/downloads.js`, the
same module in the plugins) starts a download and resolves with its final item: one subscription
to `downloads.onChanged` for the whole module, the wait registered right at the resolve of
`downloads.download()` with nothing awaited in between, and no timeout — a download that is still
running is not an error. The end of a download is its `state`; an interruption is done once its
reason has come too, in the same delta or in the next one. The facts — `BEHAVIOR-DOWNLOADS.md`.
