# Events — the add-on's own actions are muted, the user's are mirrored

How the handlers of the browser events in `addon/src/js/tabs.js` and `windows.js` tell the
add-on's own actions from the user's, and what the add-on does about other add-ons. Events are
subscribed through `addon/src/js/listeners.js` (the MV3-ready module); the browser facts are in
`BEHAVIOR-CREATE-TABS.md`, `BEHAVIOR-MOVE-TABS.md`, `BEHAVIOR-REMOVE-TABS.md` and
`BEHAVIOR-TABGROUPS.md`.

## 1. The add-on's own actions are muted in the events

A flow that creates, moves or hides tabs itself marks them with skip flags (`skipTracking`,
`skip.created`, for whole windows `skipTrackingWindow`) for the time of the operation. The
handlers level the timing with timeouts (`Utils.wait(50–70)` at the start), because the browser
delivers the events late — sometimes after the API call has resolved and the flags are gone. A
handler must remember that its snapshot of the tab may be older than reality.

## 2. The user's actions are mirrored into the add-on

They go through the filter of the add-on's logic: a new tab is bound to the group of its window,
the catch rules, a hidden tab loses its group, and so on.

## 3. Other add-ons do strange things — the add-on obeys, it does not fight

Another add-on hid a tab — the user wanted it that way: the tab loses its group, STG does not
restore it and does not fight back. STG is not obliged to handle the crookedness of others.
There are backups.

These policies are deliberate decisions. They are not changed in passing while fixing a bug.
