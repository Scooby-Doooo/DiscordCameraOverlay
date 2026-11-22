/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, BrowserWindow, globalShortcut, IpcMainInvokeEvent, Rectangle, screen, WebContents } from "electron";

// Every export here becomes an IPC handler, so constants stay private; keep in sync with index.tsx
const WINDOW_KEY = "DISCORD_CALL_TILE_POPOUT_CAMERA_OVERLAY";

const SNAP_DISTANCE = 24;
const MIN_WIDTH = 120;
const POLL_MS = 33;
const FACE_MODEL = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";

type Corner = "tl" | "tr" | "bl" | "br";

let discord: WebContents | null = null;
let mainWindow: BrowserWindow | null = null;
let win: BrowserWindow | null = null;
let aspect = 16 / 9;
let pollTimer: NodeJS.Timeout | null = null;
let dragTimer: NodeJS.Timeout | null = null;
let animTimer: NodeJS.Timeout | null = null;
let lastInside = false;
let userHidden = false;
let discordFocused = false;
let hideWhenDiscordFocused = true;
/** Gap kept between the window and the screen edges it snaps to */
let margin = 8;
let pendingBounds: Rectangle | null = null;

function emit(method: string, ...args: unknown[]) {
    if (!discord || discord.isDestroyed()) return;
    discord.executeJavaScript(`Vencord.Plugins.plugins.CameraOverlay.${method}(...${JSON.stringify(args)})`).catch(() => { });
}

function workAreaFor(b: Rectangle) {
    return screen.getDisplayMatching(b).workArea;
}

function clampToWorkArea(b: Rectangle): Rectangle {
    const wa = workAreaFor(b);
    const width = Math.round(Math.min(Math.max(b.width, MIN_WIDTH), wa.width - 2 * margin));
    const height = Math.round(Math.min(width / aspect, wa.height - 2 * margin));
    const w = Math.round(Math.min(width, height * aspect));
    return {
        width: w,
        height,
        x: Math.round(Math.min(Math.max(b.x, wa.x), wa.x + wa.width - w)),
        y: Math.round(Math.min(Math.max(b.y, wa.y), wa.y + wa.height - height))
    };
}

function defaultBounds(): Rectangle {
    const wa = screen.getPrimaryDisplay().workArea;
    const width = 320;
    const height = Math.round(width / aspect);
    return { width, height, x: wa.x + wa.width - width - margin, y: wa.y + wa.height - height - margin };
}

function isOnSomeScreen(b: Rectangle) {
    return screen.getAllDisplays().some(({ workArea: wa }) =>
        b.x + b.width / 2 >= wa.x && b.x + b.width / 2 <= wa.x + wa.width &&
        b.y + b.height / 2 >= wa.y && b.y + b.height / 2 <= wa.y + wa.height);
}

/** The corner of the work area the window is closest to; resizing keeps that corner in place */
function nearestCorner(b: Rectangle): Corner {
    const wa = workAreaFor(b);
    const left = b.x + b.width / 2 < wa.x + wa.width / 2;
    const top = b.y + b.height / 2 < wa.y + wa.height / 2;
    return `${top ? "t" : "b"}${left ? "l" : "r"}` as Corner;
}

function resizeAnchored(b: Rectangle, width: number, anchor: Corner): Rectangle {
    const height = width / aspect;
    const right = b.x + b.width, bottom = b.y + b.height;
    return clampToWorkArea({
        width,
        height,
        x: anchor[1] === "l" ? b.x : right - width,
        y: anchor[0] === "t" ? b.y : bottom - height
    });
}

function setBounds(b: Rectangle) {
    if (!win || win.isDestroyed()) return;
    stopAnim();
    win.setBounds(b);
}

function stopAnim() {
    if (animTimer) clearInterval(animTimer);
    animTimer = null;
}

function animateTo(target: Rectangle, ms = 160) {
    if (!win) return;
    stopAnim();
    const from = win.getBounds();
    const start = Date.now();
    animTimer = setInterval(() => {
        if (!win || win.isDestroyed()) return stopAnim();
        const t = Math.min(1, (Date.now() - start) / ms);
        const k = 1 - Math.pow(1 - t, 3);
        win.setBounds({
            x: Math.round(from.x + (target.x - from.x) * k),
            y: Math.round(from.y + (target.y - from.y) * k),
            width: target.width,
            height: target.height
        });
        if (t === 1) {
            stopAnim();
            emit("onBoundsChanged", win.getBounds());
        }
    }, 10);
}

function snapped(b: Rectangle): Rectangle {
    const wa = workAreaFor(b);
    const r = { ...b };
    const left = r.x - wa.x, right = wa.x + wa.width - (r.x + r.width);
    const top = r.y - wa.y, bottom = wa.y + wa.height - (r.y + r.height);
    if (left < SNAP_DISTANCE + margin) r.x = wa.x + margin;
    else if (right < SNAP_DISTANCE + margin) r.x = wa.x + wa.width - r.width - margin;
    if (top < SNAP_DISTANCE + margin) r.y = wa.y + margin;
    else if (bottom < SNAP_DISTANCE + margin) r.y = wa.y + wa.height - r.height - margin;
    return clampToWorkArea(r);
}

function updateVisibility() {
    if (!win || win.isDestroyed()) return;
    const visible = !userHidden && !(hideWhenDiscordFocused && discordFocused);
    if (visible && !win.isVisible()) win.showInactive();
    else if (!visible && win.isVisible()) win.hide();
}

function startPoll() {
    stopPoll();
    pollTimer = setInterval(() => {
        if (!win || win.isDestroyed() || !win.isVisible()) {
            if (lastInside) emit("onHover", false, 0, 0);
            lastInside = false;
            return;
        }
        const c = screen.getCursorScreenPoint();
        const b = win.getBounds();
        const inside = c.x >= b.x && c.x < b.x + b.width && c.y >= b.y && c.y < b.y + b.height;
        // Normalised, because Discord's zoom level makes CSS pixels differ from screen pixels
        if (inside || inside !== lastInside) emit("onHover", inside, (c.x - b.x) / b.width, (c.y - b.y) / b.height);
        lastInside = inside;
    }, POLL_MS);
}

function stopPoll() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
}

function onWindowCreated(_: unknown, w: BrowserWindow) {
    if (w.webContents.mainFrame.name !== WINDOW_KEY) return;
    win = w;
    // Must happen before the window is shown, otherwise opening it steals focus from whatever app you're in
    w.setFocusable(false);
    w.setSkipTaskbar(true);
    w.setAlwaysOnTop(true, "screen-saver");
    w.setIgnoreMouseEvents(true, { forward: true });
    // Chromium can mark this window hidden (occlusion) while it's on screen; Discord then stops receiving video
    // after 30s (WindowVisibilityVideoManager) and the camera freezes. This keeps the page "visible"
    w.webContents.setBackgroundThrottling(false);
    // Discord applies its own persisted always-on-top state right after opening
    setTimeout(() => !w.isDestroyed() && w.setAlwaysOnTop(true, "screen-saver"), 500);
    w.once("ready-to-show", () => updateVisibility());
    w.on("closed", () => {
        if (win === w) win = null;
        // "Hide" lasts until the camera goes away; the next call starts visible again
        userHidden = false;
        stopPoll();
        stopAnim();
        stopDrag();
    });
    const b = pendingBounds && isOnSomeScreen(pendingBounds) ? snapped(clampToWorkArea(pendingBounds)) : defaultBounds();
    w.setBounds(b);
    startPoll();
}

export function init(e: IpcMainInvokeEvent) {
    discord = e.sender;
    mainWindow = BrowserWindow.fromWebContents(e.sender);
    app.removeListener("browser-window-created", onWindowCreated);
    app.on("browser-window-created", onWindowCreated);
    if (mainWindow) {
        discordFocused = mainWindow.isFocused();
        mainWindow.removeListener("focus", onMainFocus);
        mainWindow.removeListener("blur", onMainBlur);
        mainWindow.on("focus", onMainFocus);
        mainWindow.on("blur", onMainBlur);
    }
}

function onMainFocus() {
    discordFocused = true;
    updateVisibility();
}

function onMainBlur() {
    discordFocused = false;
    updateVisibility();
}

export function dispose() {
    app.removeListener("browser-window-created", onWindowCreated);
    mainWindow?.removeListener("focus", onMainFocus);
    mainWindow?.removeListener("blur", onMainBlur);
    unregisterHotkeys();
    stopPoll();
    stopDrag();
    stopAnim();
}

/** Bounds to use the next time the overlay window opens */
export function prepare(_: IpcMainInvokeEvent, bounds: Rectangle | null, newAspect: number) {
    pendingBounds = bounds;
    aspect = newAspect;
}

export function setOptions(_: IpcMainInvokeEvent, opts: { hideWhenDiscordFocused?: boolean; edgeMargin?: number; }) {
    hideWhenDiscordFocused = opts.hideWhenDiscordFocused ?? hideWhenDiscordFocused;
    if (opts.edgeMargin != null && opts.edgeMargin !== margin) {
        margin = opts.edgeMargin;
        // A window docked to an edge moves to the new gap right away
        if (win && !win.isDestroyed()) animateTo(snapped(win.getBounds()), 120);
    }
    updateVisibility();
}

/** Only ours: unregisterAll() would also drop shortcuts other plugins registered in this process */
let registered: string[] = [];

function unregisterHotkeys() {
    for (const accel of registered) globalShortcut.unregister(accel);
    registered = [];
}

export function setHotkeys(_: IpcMainInvokeEvent, toggle: string, edit: string) {
    unregisterHotkeys();
    const failed: string[] = [];
    const register = (accel: string, cb: () => void) => {
        if (!accel) return;
        try {
            if (globalShortcut.register(accel, cb)) registered.push(accel);
            else failed.push(accel);
        } catch {
            failed.push(accel);
        }
    };
    register(toggle, () => setHidden(null, !userHidden));
    register(edit, () => emit("onEditHotkey"));
    return failed;
}

export function setHidden(_: unknown, hidden: boolean) {
    userHidden = hidden;
    updateVisibility();
    emit("onHiddenChanged", userHidden);
}

export function isHidden() {
    return userHidden;
}

export function setInteractive(_: IpcMainInvokeEvent, interactive: boolean) {
    if (!win) return;
    win.setIgnoreMouseEvents(!interactive, { forward: true });
    // Electron 44 keeps dropping clicks after un-ignoring until the window is resized; a 1px nudge refreshes it
    if (interactive && !animTimer && !dragTimer) {
        const b = win.getBounds();
        win.setBounds({ ...b, width: b.width + 1 });
        win.setBounds(b);
    }
}

/** Changes the aspect ratio, optionally the width too, keeping the nearest screen corner in place */
export function setShape(_: IpcMainInvokeEvent, newAspect: number, width?: number) {
    aspect = newAspect;
    if (!win) return null;
    const b = win.getBounds();
    const next = resizeAnchored(b, width ?? b.width, nearestCorner(b));
    setBounds(next);
    return next;
}

export function scaleBy(_: IpcMainInvokeEvent, factor: number) {
    if (!win) return null;
    const b = win.getBounds();
    const next = resizeAnchored(b, b.width * factor, nearestCorner(b));
    setBounds(next);
    return next;
}

let resizeAnchor: { corner: Corner; bounds: Rectangle; } | null = null;

/** Starts a resize by dragging `corner`; the opposite corner stays put */
export function beginResize(_: IpcMainInvokeEvent, corner: Corner) {
    if (!win) return;
    const opposite = `${corner[0] === "t" ? "b" : "t"}${corner[1] === "l" ? "r" : "l"}` as Corner;
    resizeAnchor = { corner: opposite, bounds: win.getBounds() };
}

export function resizeTo(_: IpcMainInvokeEvent) {
    if (!win || !resizeAnchor) return;
    const { corner, bounds: b } = resizeAnchor;
    const c = screen.getCursorScreenPoint();
    const fixedX = corner[1] === "l" ? b.x : b.x + b.width;
    const width = Math.max(MIN_WIDTH, Math.abs(c.x - fixedX));
    setBounds(resizeAnchored(b, width, corner));
}

export function endResize() {
    resizeAnchor = null;
    if (win) emit("onBoundsChanged", win.getBounds());
}

let dragSize: { width: number; height: number; } | null = null;

function stopDrag() {
    if (dragTimer) clearInterval(dragTimer);
    dragTimer = null;
}

export function beginDrag() {
    if (!win) return;
    stopAnim();
    const start = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const offset = { x: start.x - b.x, y: start.y - b.y };
    dragSize = { width: b.width, height: b.height };
    let last = start;
    stopDrag();
    // Polling the cursor from here keeps the window glued to it even when the pointer outruns the window
    dragTimer = setInterval(() => {
        if (!win || win.isDestroyed()) return stopDrag();
        const c = screen.getCursorScreenPoint();
        if (c.x === last.x && c.y === last.y) return;
        last = c;
        // Size from drag start: re-reading getBounds() at 125% scaling rounds the size up a pixel per move
        win.setBounds({ ...dragSize!, x: c.x - offset.x, y: c.y - offset.y });
    }, 8);
}

export function endDrag() {
    stopDrag();
    if (!win) return;
    const { x, y } = win.getBounds();
    animateTo(snapped({ ...(dragSize ?? win.getBounds()), x, y }), 120);
    dragSize = null;
}

/** Moves the window out of the cursor's way: mirrors it to the other side of the screen */
export function dodge() {
    if (!win || animTimer) return;
    const b = win.getBounds();
    const wa = workAreaFor(b);
    const c = screen.getCursorScreenPoint();
    const mirroredX = wa.x + wa.width - (b.x - wa.x) - b.width;
    let target = { ...b, x: mirroredX };
    // Mirroring horizontally isn't enough when the window sits in the middle; flip vertically then
    if (c.x >= target.x && c.x < target.x + b.width) {
        target = { ...target, y: wa.y + wa.height - (b.y - wa.y) - b.height };
    }
    animateTo(snapped(target), 180);
}

export function getBounds() {
    return win?.getBounds() ?? null;
}

/** The face model for follow mode; fetched from here because Discord's CSP blocks its host in the page */
export async function getFaceModel() {
    const res = await fetch(FACE_MODEL);
    if (!res.ok) throw new Error(`Face model: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
}
