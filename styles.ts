/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Inlined into the popout: Equicord's managed styles only live in the main window's document
export const css = `
html, body { background: transparent !important; margin: 0; overflow: hidden; }

.co-root { position: fixed; inset: 0; user-select: none; font-family: "gg sans", system-ui, sans-serif; }

.co-frame {
    position: absolute; inset: 0; overflow: hidden; background: #000;
    border-radius: var(--co-radius);
    transition: opacity .15s ease;
}
.co-video { position: absolute; pointer-events: none; object-fit: fill; }
.co-follow .co-video { transition: left 1.2s ease-in-out, top 1.2s ease-in-out; }

.co-ring {
    position: absolute; inset: 0; pointer-events: none; opacity: 0;
    border-radius: var(--co-radius);
    box-shadow: inset 0 0 0 2px #23a55a, inset 0 0 14px rgba(35, 165, 90, .5);
    transition: opacity .12s ease;
}
.co-ring.on { opacity: 1; }

/* Inset grows with the rounding so the badge stays inside rounded corners and circles (50% -> 15%) */
.co-muted {
    position: absolute; pointer-events: none;
    top: calc(6px + var(--co-radius) * .3); right: calc(6px + var(--co-radius) * .3);
    width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center;
    background: rgba(17, 18, 20, .8); color: #f23f43;
}
.co-muted svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
.co-interactive .co-muted { display: none; }

/* Own camera, mirrored like Discord's own preview */
.co-self {
    position: absolute; width: 26%;
    left: calc(6px + var(--co-radius) * .3); bottom: calc(6px + var(--co-radius) * .3);
    border-radius: 6px; transform: scaleX(-1); background: #000;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, .5), 0 2px 8px rgba(0, 0, 0, .45);
    pointer-events: none;
}
.co-self.big { inset: 0; width: 100%; height: 100%; border-radius: 0; box-shadow: none; object-fit: cover; }
.co-interactive .co-self { pointer-events: auto; cursor: pointer; }

.co-grip {
    position: absolute; top: 6px; left: 50%; transform: translateX(-50%);
    display: flex; align-items: center; justify-content: center;
    width: 40px; height: 16px; border-radius: 999px;
    background: rgba(17, 18, 20, .88); color: #fff;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, .55), 0 2px 8px rgba(0, 0, 0, .45);
    opacity: 0; transition: opacity .15s ease; pointer-events: none;
}
.co-grip svg { width: 14px; height: 8px; fill: currentColor; }
.co-grip.on { opacity: 1; }

.co-interactive .co-frame { cursor: grab; }
.co-dragging .co-frame { cursor: grabbing; }

.co-bar {
    position: absolute; left: 50%; bottom: 8px; display: flex; gap: 2px; padding: 4px;
    border-radius: 999px; background: rgba(17, 18, 20, .72); backdrop-filter: blur(8px);
    transform: translate(-50%, 4px); opacity: 0; pointer-events: none;
    transition: opacity .15s ease, transform .15s ease;
}
.co-interactive .co-bar { opacity: 1; transform: translate(-50%, 0); pointer-events: auto; }

.co-btn {
    width: 28px; height: 28px; padding: 0; border: 0; border-radius: 50%;
    display: grid; place-items: center; color: #fff; background: transparent; cursor: pointer;
}
.co-btn:hover { background: rgba(255, 255, 255, .14); }
.co-btn.off { color: #f23f43; }
.co-btn svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

/* Visible corner brackets while grabbed, so it's obvious the window can be resized from there */
.co-handle { position: absolute; width: 22px; height: 22px; display: none; }
.co-handle::before {
    content: ""; position: absolute; width: 10px; height: 10px; border: 0 solid rgba(255, 255, 255, .95);
    filter: drop-shadow(0 0 1px rgba(0, 0, 0, .8));
}
.co-interactive:not(.co-cropping) .co-handle { display: block; }
.co-handle.tl { top: 0; left: 0; cursor: nwse-resize; }
.co-handle.tr { top: 0; right: 0; cursor: nesw-resize; }
.co-handle.bl { bottom: 0; left: 0; cursor: nesw-resize; }
.co-handle.br { bottom: 0; right: 0; cursor: nwse-resize; }
.co-handle.tl::before { top: 5px; left: 5px; border-top-width: 2px; border-left-width: 2px; border-top-left-radius: 4px; }
.co-handle.tr::before { top: 5px; right: 5px; border-top-width: 2px; border-right-width: 2px; border-top-right-radius: 4px; }
.co-handle.bl::before { bottom: 5px; left: 5px; border-bottom-width: 2px; border-left-width: 2px; border-bottom-left-radius: 4px; }
.co-handle.br::before { bottom: 5px; right: 5px; border-bottom-width: 2px; border-right-width: 2px; border-bottom-right-radius: 4px; }

.co-crop {
    position: absolute; cursor: move;
    box-shadow: 0 0 0 9999px rgba(0, 0, 0, .55);
    outline: 1.5px solid rgba(255, 255, 255, .95);
}
.co-crop i { position: absolute; width: 12px; height: 12px; background: #fff; border-radius: 3px; box-shadow: 0 0 0 1px rgba(0, 0, 0, .4); }
.co-crop i[data-h="nw"] { top: 2px; left: 2px; cursor: nwse-resize; }
.co-crop i[data-h="ne"] { top: 2px; right: 2px; cursor: nesw-resize; }
.co-crop i[data-h="sw"] { bottom: 2px; left: 2px; cursor: nesw-resize; }
.co-crop i[data-h="se"] { bottom: 2px; right: 2px; cursor: nwse-resize; }
`;
