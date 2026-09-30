"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const STATE_KEY = 'zooEditorHider.isHidden';
let statusBarItem;
let isHidden = false;
let suppressAutoFocus = false;
function activate(context) {
    // Restore persisted state so the status bar reflects reality after a reload
    isHidden = context.globalState.get(STATE_KEY, false);
    // Status bar button - click to toggle
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'zoo-editor-hider.toggle';
    updateStatusBar();
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    // Register commands
    context.subscriptions.push(vscode.commands.registerCommand('zoo-editor-hider.toggle', () => toggle(context)), vscode.commands.registerCommand('zoo-editor-hider.hide', () => hideEditor(context)), vscode.commands.registerCommand('zoo-editor-hider.show', () => showEditor(context)));
    // Auto-hide shortly after startup so the workbench layout is fully ready
    const autoHide = vscode.workspace.getConfiguration('zooEditorHider').get('autoHideOnStartup', true);
    if (autoHide && !isHidden) {
        setTimeout(() => {
            suppressAutoFocus = true;
            hideEditor(context).finally(() => { suppressAutoFocus = false; });
        }, 800);
    }
    else if (isHidden) {
        // State was persisted as hidden but editor may be visible again after reload;
        // re-apply hide to keep the promise of "sidebar only".
        setTimeout(() => {
            suppressAutoFocus = true;
            hideEditor(context).finally(() => { suppressAutoFocus = false; });
        }, 800);
    }
}
async function toggle(context) {
    if (isHidden) {
        await showEditor(context);
    }
    else {
        await hideEditor(context);
    }
}
async function hideEditor(context) {
    // Hide the editor area (workbench-level toggle)
    await vscode.commands.executeCommand('workbench.action.toggleEditorVisibility');
    // Keep the primary sidebar visible (Explorer / activity side where ZooCode lives)
    await vscode.commands.executeCommand('workbench.action.focusSideBar');
    isHidden = true;
    await context.globalState.update(STATE_KEY, isHidden);
    updateStatusBar();
}
async function showEditor(context) {
    await vscode.commands.executeCommand('workbench.action.toggleEditorVisibility');
    isHidden = false;
    await context.globalState.update(STATE_KEY, isHidden);
    updateStatusBar();
}
function updateStatusBar() {
    if (isHidden) {
        statusBarItem.text = '$(eye) Show Editor';
        statusBarItem.tooltip = 'Zoo Editor Hider: click to show the editor area';
    }
    else {
        statusBarItem.text = '$(eye-closed) Hide Editor';
        statusBarItem.tooltip = 'Zoo Editor Hider: click to hide the editor area (sidebar only)';
    }
}
function deactivate() {
    // Nothing to clean up beyond what VS Code handles via subscriptions
}
//# sourceMappingURL=extension.js.map
