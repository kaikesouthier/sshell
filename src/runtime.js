
module.exports = {
    tabs: [],
    activeTabId: null,
    sftpMode: false,
    isInteractiveMode: false,
    dragSessId: null,
    dragFolderId: null,
    dragTabId: null,
    // Sidebar multi-select. `rows` mirrors the rendered order so Shift+click can
    // resolve a range; `anchor` is where the current range started.
    selection: new Set(),
    selectionAnchor: null,
    rows: []
};
