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
const LOG_FILE = path.join(os.tmpdir(), 'zoo-editor-hider-diagnostics.log');

// ---- Tuning knobs (for speed) ----
// How long to wait for the ZooCode webview panel to register its viewType after
// openInNewTab. 3s is generous: happy path registers in <200ms. If it never
// appears we fall through (closeOtherTabs has its own safety guard).
const ZOO_TAB_POLL_TIMEOUT_MS = 3000;
const ZOO_TAB_POLL_INTERVAL_MS = 80;
// Small settle time after a batch of tab closes so the workbench can rebuild
// its tab list before we issue more commands.
const TAB_CLOSE_SETTLE_MS = 120;
// Small settle time after the parallel layout-command batch so the workbench
// can finish applying the layout change before we report completion.
const LAYOUT_SETTLE_MS = 150;

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
        log('scheduling auto fullscreen in 1500ms');
        setTimeout(() => { fullscreenZoo(context); }, 1500);
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

// Find an existing ZooCode editor tab (webview) across all tab groups.
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
// Returns the found {tab,group} or undefined on timeout.
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
        await delay(ZOO_TAB_POLL_INTERVAL_MS);
    }
    log('  waitAndFindZooTab(): TIMEOUT after ' + timeoutMs + 'ms');
    return undefined;
}

// Close every editor tab EXCEPT the ZooCode tab(s), and also remove empty tab groups.
// Closes are issued IN PARALLEL — closing tabs is a cheap, order-independent op.
async function closeOtherTabs() {
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
    // Pass 1: close all non-ZooCode tabs in parallel
    const toClose = [];
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            if (!zooTabs.has(tab)) {
                toClose.push(tab);
            }
        }
    }
    await Promise.all(toClose.map(async (tab) => {
        try {
            await vscode.window.tabGroups.close(tab);
        }
        catch (e) {
            // Already closed or gone; ignore.
        }
    }));
    // Give the workbench a moment to rebuild its tab list before we try to close groups.
    await delay(TAB_CLOSE_SETTLE_MS);
    // Pass 2: close any remaining empty tab groups
    const groups = vscode.window.tabGroups.all.slice();
    await Promise.all(groups.map(async (group) => {
        if (group.tabs.length === 0) {
            try {
                await vscode.window.tabGroups.close(group);
                log('  closeOtherTabs(): closed empty group ' + group.id);
            }
            catch (e) {
                // Some groups can't be closed (active group, last group, etc.) — ignore.
            }
        }
    }));
    log('  closeOtherTabs(): closed ' + toClose.length + ' non-ZooCode tab(s)');
}

async function fullscreenZoo(context) {
    if (busy) {
        log('fullscreenZoo() skipped: busy');
        return;
    }
    busy = true;
    log('fullscreenZoo() begin');
    try {
        // ---- UNIFIED STRATEGY ----
        // 1) Open (or reuse) the ZooCode tab.
        // 2) Close EVERY non-ZooCode tab.
        // 3) In parallel: close right sidebar, bottom panel, left sidebar, hide activity bar.
        const existing = findZooTab();
        if (existing) {
            log('  ZooCode tab already exists - reusing');
        }
        else {
            log('  cmd: ' + ZOO_NEW_TAB + ' -> ' + (await tryCmd(ZOO_NEW_TAB) ? 'OK' : 'FAILED'));
            // Give the webview panel time to register its viewType before we scan.
            const confirmed = await waitAndFindZooTab(ZOO_TAB_POLL_TIMEOUT_MS);
            if (!confirmed) {
                log('  WARNING: ZooCode tab did not register in time; proceeding anyway');
            }
        }

        // Close ALL non-ZooCode tabs (parallel).
        await closeOtherTabs();

        // Fire the 4 layout commands IN PARALLEL. Each is independent and
        // executeCommand's promise resolves when the command completes — no
        // need for a fixed sleep after each one.
        const layoutCmds = [];
        if (auxBarToggled !== true) {
            layoutCmds.push(['workbench.action.closeAuxiliaryBar']);
            auxBarToggled = true;
        }
        layoutCmds.push(['workbench.action.closePanel']);
        if (leftSidebarToggled !== true) {
            layoutCmds.push(['workbench.action.closeSidebar']);
            leftSidebarToggled = true;
        }
        if (activityBarToggled !== true) {
            layoutCmds.push(['workbench.action.toggleActivityBarVisibility']);
            activityBarToggled = true;
        }
        if (layoutCmds.length > 0) {
            const results = await Promise.all(layoutCmds.map((pair) => tryCmd(pair[0])));
            log('  layout cmds -> ' + layoutCmds.map((p, i) => p[0] + ':' + (results[i] ? 'OK' : 'FAIL')).join(', '));
            await delay(LAYOUT_SETTLE_MS);
        }
        // Final focus on the ZooCode tab.
        await tryCmd('workbench.action.focusActiveEditorGroup');
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
        // Fire all restore commands IN PARALLEL — they're independent toggles.
        const restoreCmds = [];
        if (activityBarToggled === true) {
            restoreCmds.push('workbench.action.toggleActivityBarVisibility');
            activityBarToggled = null;
        }
        if (leftSidebarToggled === true) {
            restoreCmds.push('workbench.action.toggleSidebarVisibility');
            leftSidebarToggled = null;
        }
        if (auxBarToggled === true) {
            restoreCmds.push('workbench.action.toggleAuxiliaryBar');
            auxBarToggled = null;
        }
        restoreCmds.push('workbench.action.togglePanel');
        const results = await Promise.all(restoreCmds.map((cmd) => tryCmd(cmd)));
        log('  restore cmds -> ' + restoreCmds.map((c, i) => c + ':' + (results[i] ? 'OK' : 'FAIL')).join(', '));
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
