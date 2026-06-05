// The Verovio edit-staff host (#verovio-host) lives INSIDE #sheet, which OSMD owns. OSMD is built
// with autoResize:true, so a window resize (or any resize-like event, e.g. a devtools/CDP viewport
// change) fires osmd.render(), which clears #sheet and DETACHES the host. renderVerovio re-appends
// it, but only when IT runs; a bare OSMD re-render mid-edit detaches the host with no re-append, so
// the edit staff went BLANK until the user toggled edit off+on. This is the same OSMD-detach race the
// #203 toolbar fix dodged by moving the toolbar OUT of #sheet; the host cannot move out as cheaply
// (it is the scrolling display surface), so instead we re-attach it the instant OSMD drops it.
//
// The detach only REMOVES the host node from #sheet; the host div and its SVG content survive (a live
// reference keeps it alive), so re-appending the SAME node restores the staff instantly with no
// re-render. Reflowing the Verovio engraving to a new width on resize is a separate concern (the
// staff keeps its entered width until the next edit); this guard only ensures it is never blank.

/**
 * Re-append `host` to `sheet` when edit mode is on and OSMD has detached it. Returns true if it acted.
 * No-op when not editing, when there is no host, or when the host is already attached. Re-appending is
 * itself a childList mutation, but the `parentNode !== sheet` guard makes the observer's re-fire a
 * no-op, so this cannot loop.
 */
export function reattachHostIfDetached(
  sheet: Element,
  host: Element | null,
  editing: boolean,
): boolean {
  if (editing && host && host.parentNode !== sheet) {
    sheet.appendChild(host);
    return true;
  }
  return false;
}

/**
 * Watch `sheet`'s direct children and re-attach the host whenever OSMD detaches it during edit mode.
 * `getHost` and `isEditing` are read live on every mutation so one observer serves every edit session
 * (the host is created lazily and edit mode toggles). Returns the observer; call `.disconnect()` on
 * exit to stop watching.
 */
export function observeHostReattach(
  sheet: Element,
  getHost: () => Element | null,
  isEditing: () => boolean,
): MutationObserver {
  const observer = new MutationObserver(() => {
    reattachHostIfDetached(sheet, getHost(), isEditing());
  });
  observer.observe(sheet, { childList: true });
  return observer;
}
