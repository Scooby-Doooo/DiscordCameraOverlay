/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType, PluginNative } from "@utils/types";
import { showToast } from "@webpack/common";

export const Native = VencordNative.pluginHelpers.CameraOverlay as PluginNative<typeof import("./native")>;

/** Part of the camera frame to show, as fractions of the full frame */
export interface Crop {
    x: number;
    y: number;
    w: number;
    h: number;
}

export const FULL_FRAME: Crop = { x: 0, y: 0, w: 1, h: 1 };

export async function applyHotkeys() {
    const failed = await Native.setHotkeys(settings.store.toggleHotkey, settings.store.editHotkey);
    if (failed.length) showToast({ text: `CameraOverlay: couldn't register ${failed.join(", ")}`, variant: "critical" });
}

const hotkeyHint = "Electron accelerator, e.g. CommandOrControl+Alt+Shift+C. Leave empty to disable.";

export const settings = definePluginSettings({
    hoverBehavior: {
        type: OptionType.SELECT,
        description: "What the camera does when the cursor moves over it",
        options: [
            { label: "Fade out, so you can see and click what's behind it", value: "fade", default: true },
            { label: "Move to the other side of the screen", value: "dodge" }
        ]
    },
    hoverOpacity: {
        type: OptionType.SLIDER,
        description: "How visible the camera stays while the cursor is over it (fade mode)",
        markers: [0.05, 0.1, 0.15, 0.25, 0.4, 0.6],
        default: 0.15,
        stickToMarkers: false
    },
    shape: {
        type: OptionType.SELECT,
        description: "Window shape",
        options: [
            { label: "Rectangle", value: "rect", default: true },
            { label: "Circle", value: "circle" }
        ]
    },
    cornerRadius: {
        type: OptionType.SLIDER,
        description: "Corner rounding of the rectangle",
        markers: [0, 4, 8, 12, 16, 24, 32],
        default: 12
    },
    edgeMargin: {
        type: OptionType.SLIDER,
        description: "Gap between the overlay and the screen edges it sticks to, in pixels (0 = right against the edge)",
        markers: [0, 4, 8, 12, 16, 24, 32],
        default: 8,
        stickToMarkers: false,
        onChange: (value: number) => Native.setOptions({ edgeMargin: Math.round(value) })
    },
    speakingRing: {
        type: OptionType.BOOLEAN,
        description: "Light up the border while the other person is talking",
        default: true
    },
    followFace: {
        type: OptionType.BOOLEAN,
        description: "Keep the person centred in a cropped frame (downloads a ~14 MB face detector the first time)",
        default: true
    },
    followInterval: {
        type: OptionType.SLIDER,
        description: "How often to look for the face, in seconds (each check takes a few tens of milliseconds)",
        markers: [2, 3, 5, 10, 15, 30],
        default: 5,
        stickToMarkers: false
    },
    showSelf: {
        type: OptionType.BOOLEAN,
        description: "Show your own camera in a small corner of the overlay while it's on (click it while the overlay is grabbed to enlarge)",
        default: true
    },
    hideWhenDiscordFocused: {
        type: OptionType.BOOLEAN,
        description: "Hide the overlay while the Discord window itself is focused",
        default: true,
        onChange: (value: boolean) => Native.setOptions({ hideWhenDiscordFocused: value })
    },
    toggleHotkey: {
        type: OptionType.STRING,
        description: `Global shortcut to hide / show the overlay. ${hotkeyHint}`,
        default: "CommandOrControl+Alt+Shift+C",
        onChange: applyHotkeys
    },
    editHotkey: {
        type: OptionType.STRING,
        description: `Global shortcut to grab the overlay to move, resize or crop it (handy in "move away" mode). ${hotkeyHint}`,
        default: "CommandOrControl+Alt+Shift+E",
        onChange: applyHotkeys
    },
    bounds: {
        type: OptionType.CUSTOM,
        description: "Last overlay position and size",
        default: null as null | { x: number; y: number; width: number; height: number; },
        hidden: true
    },
    crops: {
        type: OptionType.CUSTOM,
        description: "Saved crop per person (user id -> crop)",
        default: {} as Record<string, Crop>,
        hidden: true
    }
});
