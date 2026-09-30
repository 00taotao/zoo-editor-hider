"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");
const STATE_KEY = 'zooEditorHider.zooFullscreen';
const ZOO_NEW_TAB = 'zoo-code.openInNewTab';
const ZOO_TAB_VIEW_TYPE = 'zoo-code.TabPanelProvider';
const LOG_FILE = path.join(os.tmpdir(), 'zoo-editor-hider-diagnostics.log');
let statusBarItem;
let isFullscreen = false;
let busy = false;
// Track which layouts WE changed in this window session, so restore() knows what to revert.
// auxBarToggled: true = we closed the right sidebar (need to re-open)
// leftSidebarToggled: true = we closed the left sidebar (need to re-open)
// activityBarToggled: true = we hid the activity bar (need to re-show)
let auxBarToggled = null;
let leftSidebarToggled = null;
let activityBarToggled = null;
function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    console.log(line.trim());
    try { fs.appendFileSync(LOG_FILE, line); } catch (e) { /* ignore */ }
}
function activate(context) {
    log('activate() called. autoHide=' + vscode.workspace.getConfiguration('zooEditorHider').get('autoHideOnStartup', false));
    isFullscreen = context.globalState.get(STATE_KEY, false);
    auxBarToggled = null;        // reset per window
    leftSidebarToggled = null;   // reset per window
    activityBarToggled = null;   // reset per window
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'zoo-editor-hider.toggle';
    updateStatusBar();
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    context.subscriptions.push(vscode.commands.registerCommand('zoo-editor-hider.toggle', () => toggle(context)));
    context.subscriptions.push(vscode.commands.registerCommand('zoo-editor-hider.fullscreenZoo', () => fullscreenZoo(context)));
    context.subscriptions.push(vscode.commands.registerCommand('zoo-editor-hider.restore', () => restore(context)));
    // Default OFF: user must invoke the shortcut manually.
    if (vscode.workspace.getConfiguration('zooEditorHider').get('autoHideOnStartup', false)) {
        log('scheduling auto fullscreen in 2000ms');
        setTimeout(() => { fullscreenZoo(context); }, 2000);
    }
}
function toggle(context) {
    log('toggle() called, isFullscreen=' + isFullscreen);
    return isFullscreen ? restore(context) : fullscreenZoo(context);
}
// VS Code prefixes webview-panel tab viewType with "mainThreadWebview-", so the real
// value looks like "mainThreadWebview-zoo-code.TabPanelProvider". SUBSTRING match is
// the only reliable way to detect the ZooCode panel.
function isZooTab(tab) {
    const input = tab.input;
    const vt = (input && typeof input.viewType === 'string') ? input.viewType : '';
    if (vt) {
        return vt.indexOf('zoo-code.TabPanelProvider') !== -1;
    }
    // viewType empty — fall back to exact label only.
    return typeof tab.label === 'string' && tab.label === 'Zoo Code';
}
// Find an existing ZooCode editor tab (webview) across all tab groups
function findZooTab() {
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            if (isZooTab(tab)) {
                return { tab, group };
            }
        }
    }
    return undefined;
}
// Poll until the ZooCode tab actually shows up (webview registration can lag).
// Returns true once found; false on timeout. NEVER proceed to destructive steps without this.
async function waitAndFindZooTab(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;
    while (Date.now() < deadline) {
        attempt++;
        const found = findZooTab();
        if (found) {
            log('  waitAndFindZooTab(): found on attempt ' + attempt);
            return found;
        }
        await delay(250);
    }
    log('  waitAndFindZooTab(): TIMEOUT after ' + timeoutMs + 'ms');
    return undefined;
}
// Close every editor tab EXCEPT the ZooCode tab(s), and also remove empty tab groups.
async function closeOtherTabs() {
    let closed = 0;
    // Diagnostic snapshot of ALL tabs (helps with future debugging)
    const allTabs = [];
    const zooTabs = new Set();
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            const vt = (tab.input && typeof tab.input.viewType === 'string') ? tab.input.viewType : '';
            allTabs.push({ label: tab.label, viewType: vt, isZoo: isZooTab(tab) });
            if (isZooTab(tab)) {
                zooTabs.add(tab);
            }
        }
    }
    log('  closeOtherTabs(): found ' + zooTabs.size + ' ZooCode tab(s) to keep; ' + allTabs.length + ' total tab(s): ' + JSON.stringify(allTabs));
    if (zooTabs.size === 0) {
        log('  closeOtherTabs(): NO ZooCode tab found - ABORT (do not close anything)');
        return;
    }
    // Pass 1: close all non-ZooCode tabs
    for (const group of vscode.window.tabGroups.all) {
        const tabsToConsider = group.tabs.slice();
        for (const tab of tabsToConsider) {
            if (zooTabs.has(tab)) { continue; }
            try {
                await vscode.window.tabGroups.close(tab);
                closed++;
                await delay(80);
            } catch (e) {
                log('  closeOtherTabs(): skip -> ' + (e && e.message));
            }
        }
    }
    // Pass 2: close any remaining empty tab groups (a group with 0 tabs is dead weight)
    const groups = vscode.window.tabGroups.all.slice();
    for (const group of groups) {
        if (group.tabs.length === 0 && !zooTabs.has(group.activeTab)) {
            try {
                await vscode.window.tabGroups.close(group);
                log('  closeOtherTabs(): closed empty group ' + group.id);
            } catch (e) {
                // Some groups can't be closed (active group, last group, etc.)
                log('  closeOtherTabs(): could not close empty group ' + group.id + ' -> ' + (e && e.message));
            }
        }
    }
    log('  closeOtherTabs(): closed ' + closed + ' non-ZooCode tab(s)');
}
async function fullscreenZoo(context) {
    if (busy) {
        log('fullscreenZoo() skipped: busy');
        return;
    }
    busy = true;
    log('fullscreenZoo() begin');
    try {
        // ---- SIMPLE UNIFIED STRATEGY ----
        // Always: 1) open (or reuse) the ZooCode tab, 2) close EVERY non-ZooCode tab.
        // This sidesteps the unreliable workbench.action.closeAllEditors command (which
        // doesn't reliably remove all editor kinds) by iterating tabGroups ourselves.
        const existing = findZooTab();
        if (existing) {
            log('  ZooCode tab already exists - reusing');
        }
        else {
            log('  cmd: ' + ZOO_NEW_TAB + ' -> ' + (await tryCmd(ZOO_NEW_TAB) ? 'OK' : 'FAILED'));
            // Give the webview panel time to register its viewType before we scan.
            const confirmed = await waitAndFindZooTab(8000);
            if (!confirmed) {
                log('  WARNING: ZooCode tab did not register within 8s; proceeding with closeOtherTabs anyway');
            }
        }

        // Close ALL non-ZooCode tabs (regular files, terminals, welcome, etc.)
        // We iterate manually because closeAllEditors is unreliable across editor kinds.
        await closeOtherTabs();

        // Deterministically CLOSE the RIGHT sidebar (Auxiliary Bar / Secondary Sidebar)
        if (auxBarToggled !== true) {
            log('  cmd: workbench.action.closeAuxiliaryBar -> ' + (await tryCmd('workbench.action.closeAuxiliaryBar') ? 'OK' : 'FAILED'));
            auxBarToggled = true;
            await delay(300);
        }
        // Deterministically CLOSE the bottom panel
        log('  cmd: workbench.action.closePanel -> ' + (await tryCmd('workbench.action.closePanel') ? 'OK' : 'FAILED'));
        await delay(300);
        // Deterministically CLOSE the LEFT primary sidebar
        if (leftSidebarToggled !== true) {
            log('  cmd: workbench.action.closeSidebar -> ' + (await tryCmd('workbench.action.closeSidebar') ? 'OK' : 'FAILED'));
            leftSidebarToggled = true;
            await delay(300);
        }
        // Hide Activity Bar (only once per session)
        if (activityBarToggled !== true) {
            log('  cmd: workbench.action.toggleActivityBarVisibility -> ' + (await tryCmd('workbench.action.toggleActivityBarVisibility') ? 'OK' : 'FAILED'));
            activityBarToggled = true;
            await delay(300);
        }
        // Final focus on the ZooCode tab
        log('  cmd: workbench.action.focusActiveEditorGroup -> ' + (await tryCmd('workbench.action.focusActiveEditorGroup') ? 'OK' : 'FAILED'));
        isFullscreen = true;
        await context.globalState.update(STATE_KEY, true);
        updateStatusBar();
        log('fullscreenZoo() complete');
    }
    catch (err) {
        log('fullscreenZoo() ERROR: ' + (err && err.message));
    }
    finally {
        busy = false;
    }
}
async function restore(context) {
    if (busy) {
        log('restore() skipped: busy');
        return;
    }
    busy = true;
    log('restore() begin');
    try {
        // Restore Activity Bar first (if we hid it)
        if (activityBarToggled === true) {
            log('  cmd: workbench.action.toggleActivityBarVisibility -> ' + (await tryCmd('workbench.action.toggleActivityBarVisibility') ? 'OK' : 'FAILED'));
            activityBarToggled = null;
            await delay(300);
        }
        // Restore left sidebar (if we closed it)
        if (leftSidebarToggled === true) {
            log('  cmd: workbench.action.toggleSidebarVisibility -> ' + (await tryCmd('workbench.action.toggleSidebarVisibility') ? 'OK' : 'FAILED'));
            leftSidebarToggled = null;
            await delay(300);
        }
        // Restore right auxiliary bar (if we closed it)
        if (auxBarToggled === true) {
            log('  cmd: workbench.action.toggleAuxiliaryBar -> ' + (await tryCmd('workbench.action.toggleAuxiliaryBar') ? 'OK' : 'FAILED'));
            auxBarToggled = null;
            await delay(300);
        }
        // Reveal bottom panel
        log('  cmd: workbench.action.togglePanel -> ' + (await tryCmd('workbench.action.togglePanel') ? 'OK' : 'FAILED'));
        isFullscreen = false;
        await context.globalState.update(STATE_KEY, false);
        updateStatusBar();
        log('restore() complete');
    }
    catch (err) {
        log('restore() ERROR: ' + (err && err.message));
    }
    finally {
        busy = false;
    }
}
function tryCmd(commandId, args) {
    return vscode.commands.executeCommand(commandId, args).then(() => true, () => false);
}
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
function updateStatusBar() {
    if (statusBarItem) {
        if (isFullscreen) {
            statusBarItem.text = '$(close) Exit Zoo Fullscreen';
            statusBarItem.tooltip = 'Zoo Editor Hider: exit fullscreen (Ctrl+Alt+Z)';
        }
        else {
            statusBarItem.text = '$(zoom-in) Zoo Fullscreen';
            statusBarItem.tooltip = 'Zoo Editor Hider: make ZooCode fill the window (Ctrl+Alt+Z)';
        }
    }
}
function deactivate() { }
