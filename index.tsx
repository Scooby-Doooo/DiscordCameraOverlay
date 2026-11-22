/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin from "@utils/types";
import { findStoreLazy } from "@webpack";
import { PopoutActions, PopoutWindowStore, SelectedChannelStore, showToast, useEffect, UserStore, useState, VoiceStateStore } from "@webpack/common";

import { Overlay, overlayEvents } from "./Overlay";
import { applyHotkeys, FULL_FRAME, Native, settings } from "./settings";

// Keep in sync with native.ts, which recognises the window by this frame name.
// The call tile popout prefix makes Discord count the window as a visible call view: otherwise it stops
// receiving video 30s after its own window is hidden (WindowVisibilityVideoManager)
const WINDOW_KEY = "DISCORD_CALL_TILE_POPOUT_CAMERA_OVERLAY";

const VideoStreamStore = findStoreLazy("VideoStreamStore");
const SpeakingStore = findStoreLazy("SpeakingStore");

interface Target {
    userId: string;
    streamId: string;
}

/** How long someone else has to keep talking before the overlay switches to them */
const SWITCH_DELAY = 1500;

let current: Target | null = null;
let opening = false;
/** Who started talking while the shown person was silent, and when */
let pending: { userId: string; since: number; } | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | undefined;

/** Whose camera to show: the other person in a 1:1 call, otherwise whoever with a camera spoke last */
function pickTarget(): Target | null {
    const channelId = SelectedChannelStore.getVoiceChannelId();
    if (!channelId) return null;
    const me = UserStore.getCurrentUser()?.id;
    const withVideo = Object.values(VoiceStateStore.getVoiceStatesForChannel(channelId))
        .filter(s => s.userId !== me && s.selfVideo && VideoStreamStore.getStreamId(s.userId))
        .map(s => s.userId);
    if (!withVideo.length) return null;
    const target = (userId: string) => ({ userId, streamId: VideoStreamStore.getStreamId(userId) });
    const speaker = withVideo.find(id => SpeakingStore.isSpeaking(id));

    if (!current || !withVideo.includes(current.userId)) {
        pending = null;
        return target(speaker ?? withVideo[0]);
    }
    if (SpeakingStore.isSpeaking(current.userId)) {
        pending = null;
        return target(current.userId);
    }

    const now = Date.now();
    // A stale entry from an earlier short remark starts over
    if (speaker && (speaker !== pending?.userId || now - pending.since > SWITCH_DELAY * 3)) {
        pending = { userId: speaker, since: now };
        clearTimeout(pendingTimer);
        pendingTimer = setTimeout(update, SWITCH_DELAY);
    }
    // Only switch to someone still talking after the delay, so a short "yeah" doesn't move the window
    if (pending && speaker === pending.userId && now - pending.since >= SWITCH_DELAY) {
        pending = null;
        return target(speaker);
    }
    return target(current.userId);
}

function OverlayRoot() {
    const [target, setTarget] = useState(current);
    useEffect(() => {
        const onTarget = () => setTarget(current);
        overlayEvents.addEventListener("target", onTarget);
        return () => overlayEvents.removeEventListener("target", onTarget);
    }, []);
    const win = PopoutWindowStore.getWindow(WINDOW_KEY);
    if (!target || !win) return null;
    return <Overlay key={target.userId} userId={target.userId} streamId={target.streamId} win={win} />;
}

/**
 * Discord copies every stylesheet it lazy-loads (settings, profiles, menus) into each popout, and restyling
 * this window stalls the main one for seconds. It only needs its inline css, so it gets none of them
 */
function blockStylesheets(win: Window) {
    const { head } = win.document;
    head.querySelectorAll('link[rel="stylesheet"]').forEach(l => l.remove());
    const append = head.appendChild;
    head.appendChild = function <T extends Node>(node: T): T {
        if (node.nodeName === "LINK" && (node as Node as HTMLLinkElement).rel === "stylesheet") return node;
        return append.call(this, node) as T;
    };
}

async function openOverlay(target: Target) {
    opening = true;
    try {
        const crop = settings.store.crops[target.userId] ?? FULL_FRAME;
        const { bounds } = settings.store;
        // Settings values are proxies, which IPC can't clone
        await Native.prepare(bounds && { ...bounds }, (16 * crop.w) / (9 * crop.h));
        // Discord calls this once, right after copying its current stylesheets in
        PopoutActions.open(WINDOW_KEY, key => {
            blockStylesheets(PopoutWindowStore.getWindow(key)!);
            return <ErrorBoundary noop><OverlayRoot /></ErrorBoundary>;
        }, {
            defaultWidth: 320,
            defaultHeight: 180,
            defaultAlwaysOnTop: true,
            frame: false,
            transparent: true,
            resizable: false,
            skipTaskbar: true,
            hasShadow: false,
            backgroundColor: "#00000000"
        });
    } finally {
        opening = false;
    }
}

function update() {
    const next = pickTarget();
    const open = PopoutWindowStore.getWindowOpen(WINDOW_KEY);
    const same = next?.userId === current?.userId && next?.streamId === current?.streamId;
    if (same && (open || !next)) return;
    current = next;
    overlayEvents.dispatchEvent(new Event("target"));
    if (!next) {
        if (open) PopoutActions.close(WINDOW_KEY);
    } else if (!open && !opening) {
        openOverlay(next);
    }
}

// A function: the common stores are only assigned once Discord's webpack has loaded
const watchedStores = () => [VoiceStateStore, SelectedChannelStore, VideoStreamStore, SpeakingStore];

export default definePlugin({
    name: "CameraOverlay",
    description: "Shows the other person's camera in a small always-on-top window that never gets in the way",
    authors: [{ name: "dimav", id: 0n }],
    settings,

    async start() {
        await Native.init();
        await Native.setOptions({ hideWhenDiscordFocused: settings.store.hideWhenDiscordFocused, edgeMargin: Math.round(settings.store.edgeMargin) });
        await applyHotkeys();
        for (const store of watchedStores()) store.addChangeListener(update);
        update();
    },

    stop() {
        for (const store of watchedStores()) store.removeChangeListener(update);
        current = null;
        pending = null;
        clearTimeout(pendingTimer);
        PopoutActions.close(WINDOW_KEY);
        Native.dispose();
    },

    // Called from native.ts
    onHover(inside: boolean, x: number, y: number) {
        overlayEvents.dispatchEvent(new CustomEvent("hover", { detail: { inside, x, y } }));
    },
    onEditHotkey() {
        overlayEvents.dispatchEvent(new Event("edit"));
    },
    onHiddenChanged(hidden: boolean) {
        const { toggleHotkey } = settings.store;
        if (hidden) showToast({ text: toggleHotkey ? `Camera hidden. ${toggleHotkey} brings it back` : "Camera hidden until the next call" });
    },
    onBoundsChanged(bounds: typeof settings.store.bounds) {
        if (bounds) settings.store.bounds = bounds;
    }
});
