/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { classes } from "@utils/misc";
import { findByCodeLazy, findByPropsLazy, findStoreLazy } from "@webpack";
import { MediaEngineStore, React, useEffect, useRef, useState, useStateFromStores, UserStore, VoiceStateStore } from "@webpack/common";

import { findFace } from "./faceFollow";
import { Crop, FULL_FRAME, Native, settings } from "./settings";
import { css } from "./styles";

/** Discord's ref-counted stream for a remote video: sharing it with Discord's own tiles costs nothing extra */
const getDirectStream: (streamId: string) => { stream: MediaStream; release(): void; } = findByCodeLazy("addDirectVideoOutputSink(", "release()");
const SpeakingStore = findStoreLazy("SpeakingStore");
const VideoStreamStore = findStoreLazy("VideoStreamStore");
const AudioActions = findByPropsLazy("toggleSelfMute");
const VideoActions = findByPropsLazy("setVideoEnabled");

/** Events from the main process and the plugin: "hover", "edit", "target" */
export const overlayEvents = new EventTarget();

/** Cursor position over the window, as fractions of its size */
export interface Hover {
    inside: boolean;
    x: number;
    y: number;
}

type Corner = "tl" | "tr" | "bl" | "br";

const logger = new Logger("CameraOverlay");

const MIN_CROP = 0.1;
/** Moves smaller than this share of the shown region are left alone, so the picture doesn't wobble */
const FOLLOW_DEAD_ZONE = 0.1;
// Corners only: edge handles would end up under the button bar
const CROP_HANDLES = ["nw", "ne", "sw", "se"];

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/** For the circle shape the shown region has to be square in pixels, centred on the crop */
function displayRegion(crop: Crop, vw: number, vh: number, circle: boolean): Crop {
    if (!circle) return crop;
    const side = Math.min(crop.w * vw, crop.h * vh);
    const w = side / vw, h = side / vh;
    return {
        x: clamp(crop.x + crop.w / 2 - w / 2, 0, 1 - w),
        y: clamp(crop.y + crop.h / 2 - h / 2, 0, 1 - h),
        w,
        h
    };
}

function adjustCrop(c: Crop, handle: string, dx: number, dy: number): Crop {
    if (handle === "move") return { ...c, x: clamp(c.x + dx, 0, 1 - c.w), y: clamp(c.y + dy, 0, 1 - c.h) };
    let l = c.x, t = c.y, r = c.x + c.w, b = c.y + c.h;
    if (handle.includes("w")) l = clamp(l + dx, 0, r - MIN_CROP);
    if (handle.includes("e")) r = clamp(r + dx, l + MIN_CROP, 1);
    if (handle.includes("n")) t = clamp(t + dy, 0, b - MIN_CROP);
    if (handle.includes("s")) b = clamp(b + dy, t + MIN_CROP, 1);
    return { x: l, y: t, w: r - l, h: b - t };
}

/** Plays a stream in the element; returns the cleanup */
function attachStream(el: HTMLVideoElement, streamId: string) {
    const s = getDirectStream(streamId);
    el.srcObject = s.stream;
    el.play().catch(() => { });
    return () => {
        el.srcObject = null;
        s.release();
    };
}

const isFullFrame =(c: Crop) => c.x <= 0.001 && c.y <= 0.001 && c.w >= 0.999 && c.h >= 0.999;

function saveBounds(b: typeof settings.store.bounds) {
    if (b) settings.store.bounds = b;
}

// Icons are functions: JSX can't run at module load, React isn't available yet then
const Icon = ({ children }: { children: React.ReactNode; }) => <svg viewBox="0 0 24 24" aria-hidden="true">{children}</svg>;
const slash = () => <path d="M4 4l16 16" />;
const icons = {
    mic: () => <><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" /><path d="M19 11a7 7 0 0 1-14 0M12 18v3" /></>,
    headphones: () => <path d="M4 18v-6a8 8 0 0 1 16 0v6M4 15h3v5H5a1 1 0 0 1-1-1v-4ZM20 15h-3v5h2a1 1 0 0 0 1-1v-4Z" />,
    camera: () => <><rect x="3" y="7" width="13" height="10" rx="2" /><path d="m16 11 5-3v8l-5-3" /></>,
    crop: () => <path d="M6 2v14a2 2 0 0 0 2 2h14M2 6h14a2 2 0 0 1 2 2v14" />,
    hide: () => <path d="M3 3l18 18M10.6 6.1A9.9 9.9 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-2.4 3M6.6 6.6C4.2 8.2 3 12 3 12s4 6 9 6a9 9 0 0 0 4.4-1.1" />,
    apply: () => <path d="M5 12l5 5L20 7" />,
    full: () => <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
    cancel: () => <path d="M6 6l12 12M18 6 6 18" />
};

function Button({ label, off, onClick, children }: { label: string; off?: boolean; onClick(): void; children: React.ReactNode; }) {
    return (
        <button className={classes("co-btn", off && "off")} title={label} aria-label={label} onClick={onClick}>
            <Icon>{children}</Icon>
        </button>
    );
}

export function Overlay({ userId, streamId, win }: { userId: string; streamId: string; win: Window; }) {
    const { hoverBehavior, hoverOpacity, shape, cornerRadius, speakingRing, crops, showSelf, followFace, followInterval } =
        settings.use(["hoverBehavior", "hoverOpacity", "shape", "cornerRadius", "speakingRing", "crops", "showSelf", "followFace", "followInterval"]);

    const [hover, setHover] = useState<Hover>({ inside: false, x: 0, y: 0 });
    const [interactive, setInteractive] = useState(false);
    const [edit, setEdit] = useState(false);
    const [dragging, setDragging] = useState(false);
    const [draft, setDraft] = useState<Crop | null>(null);
    const [video, setVideo] = useState({ w: 16, h: 9 });
    const [intro, setIntro] = useState(true);
    const [selfBig, setSelfBig] = useState(false);
    /** Where follow mode moved the shown region to; its size stays the user's */
    const [follow, setFollow] = useState<{ x: number; y: number; } | null>(null);

    const videoRef = useRef<HTMLVideoElement>(null);
    const selfRef = useRef<HTMLVideoElement>(null);
    const frameRef = useRef<HTMLDivElement>(null);
    const nextWidth = useRef<number | null>(null);
    const editEntered = useRef(false);
    const cropDrag = useRef<{ handle: string; start: Crop; px: number; py: number; } | null>(null);

    const speaking = useStateFromStores([SpeakingStore], () => SpeakingStore.isSpeaking(userId));
    // Self or server; deafening mutes too, so it wins
    const theyOff = useStateFromStores([VoiceStateStore], () => {
        const s = VoiceStateStore.getVoiceStateForUser(userId);
        if (!s) return null;
        return s.selfDeaf || s.deaf ? "deaf" : s.selfMute || s.mute ? "mute" : null;
    });
    const muted = useStateFromStores([MediaEngineStore], () => MediaEngineStore.isSelfMute());
    const cameraOn = useStateFromStores([MediaEngineStore], () => MediaEngineStore.isVideoEnabled());
    const selfStreamId: string | undefined = useStateFromStores([VideoStreamStore],
        () => showSelf && cameraOn ? VideoStreamStore.getStreamId(UserStore.getCurrentUser().id) : undefined,
        [showSelf, cameraOn]);

    const fade = hoverBehavior === "fade";
    const cropping = draft != null;
    const circle = shape === "circle";
    const crop = crops[userId] ?? FULL_FRAME;
    const shown = displayRegion(crop, video.w, video.h, circle);
    const following = followFace && !cropping && !isFullFrame(shown);
    const region = cropping ? FULL_FRAME : following && follow ? { ...shown, ...follow } : shown;
    const aspect = (video.w * region.w) / (video.h * region.h);

    useEffect(() => {
        setFollow(null);
        if (!following) return;
        let live = true;
        const tick = () => findFace(videoRef.current!).then(face => {
            if (!live || !face) return;
            const x = clamp(face.x - shown.w / 2, 0, 1 - shown.w);
            // Face a bit above the middle, leaving room for the shoulders
            const y = clamp(face.y - shown.h * 0.4, 0, 1 - shown.h);
            setFollow(f => {
                const cur = f ?? shown;
                const small = Math.abs(x - cur.x) < shown.w * FOLLOW_DEAD_ZONE && Math.abs(y - cur.y) < shown.h * FOLLOW_DEAD_ZONE;
                return small ? f : { x, y };
            });
        }).catch(e => logger.error("Face detection failed", e));
        // The first frame takes a moment to arrive
        const first = setTimeout(tick, 1000);
        const timer = setInterval(tick, followInterval * 1000);
        return () => {
            live = false;
            clearTimeout(first);
            clearInterval(timer);
        };
    }, [following, followInterval, shown.x, shown.y, shown.w, shown.h]);

    // Show where to grab the window for a moment when it first appears
    useEffect(() => {
        const t = setTimeout(() => setIntro(false), 3000);
        return () => clearTimeout(t);
    }, []);

    useEffect(() => {
        const onHover = (e: Event) => setHover((e as CustomEvent<Hover>).detail);
        const onEdit = () => setEdit(e => !e);
        overlayEvents.addEventListener("hover", onHover);
        overlayEvents.addEventListener("edit", onEdit);
        return () => {
            overlayEvents.removeEventListener("hover", onHover);
            overlayEvents.removeEventListener("edit", onEdit);
        };
    }, []);

    useEffect(() => {
        const el = videoRef.current!;
        const onSize = () => el.videoWidth && setVideo({ w: el.videoWidth, h: el.videoHeight });
        el.addEventListener("loadedmetadata", onSize);
        el.addEventListener("resize", onSize);
        const detach = attachStream(el, streamId);
        return () => {
            el.removeEventListener("loadedmetadata", onSize);
            el.removeEventListener("resize", onSize);
            detach();
        };
    }, [streamId]);

    useEffect(() => {
        if (!selfStreamId) return setSelfBig(false);
        return attachStream(selfRef.current!, selfStreamId);
    }, [selfStreamId]);

    // The window always has exactly the shape of what it shows, so there are no black bars
    useEffect(() => {
        Native.setShape(aspect, nextWidth.current ?? undefined).then(saveBounds);
        nextWidth.current = null;
    }, [aspect]);

    useEffect(() => {
        editEntered.current = false;
        if (edit) setInteractive(true);
        else if (!dragging) {
            setInteractive(false);
            setDraft(null);
        }
    }, [edit]);

    useEffect(() => void Native.setInteractive(interactive), [interactive]);

    // The pill (40×16 at top 6px, see styles.ts) plus a few pixels, so it's easy to hit
    const overGrip = hover.inside
        && hover.y * win.innerHeight < 26
        && Math.abs(hover.x * win.innerWidth - win.innerWidth / 2) < 24;

    useEffect(() => {
        if (interactive || edit) return;
        if (fade && overGrip) setInteractive(true);
        else if (!fade && hover.inside) Native.dodge();
    }, [hover, fade, interactive, edit]);

    if (edit && hover.inside) editEntered.current = true;

    // Let go once the cursor leaves; after the edit hotkey only once it has actually been over the window
    useEffect(() => {
        if (!interactive || hover.inside || dragging || cropping) return;
        if (edit && !editEntered.current) return;
        const t = setTimeout(() => {
            setInteractive(false);
            setEdit(false);
        }, 350);
        return () => clearTimeout(t);
    }, [interactive, hover.inside, dragging, cropping, edit]);

    async function startCrop() {
        const b = await Native.getBounds();
        nextWidth.current = b && b.width / region.w;
        setDraft({ ...crop });
    }

    async function finishCrop(result: Crop | null) {
        const b = await Native.getBounds();
        const kept = result ?? crop;
        nextWidth.current = b && b.width * displayRegion(kept, video.w, video.h, circle).w;
        if (result) {
            const { [userId]: _, ...rest } = crops;
            settings.store.crops = isFullFrame(result) ? rest : { ...rest, [userId]: result };
        }
        setDraft(null);
    }

    function onFramePointerDown(e: React.PointerEvent) {
        if (!interactive || cropping || e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
        Native.beginDrag();
    }

    function onFramePointerUp() {
        if (!dragging) return;
        setDragging(false);
        Native.endDrag();
    }

    function onWheel(e: React.WheelEvent) {
        if (!interactive || cropping) return;
        Native.scaleBy(e.deltaY < 0 ? 1.08 : 1 / 1.08).then(saveBounds);
    }

    const resizeHandlers = (corner: Corner) => ({
        onPointerDown(e: React.PointerEvent) {
            e.stopPropagation();
            e.currentTarget.setPointerCapture(e.pointerId);
            setDragging(true);
            Native.beginResize(corner);
        },
        onPointerMove(e: React.PointerEvent) {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) Native.resizeTo();
        },
        onPointerUp() {
            setDragging(false);
            Native.endResize();
        }
    });

    const cropHandlers = {
        onPointerDown(e: React.PointerEvent) {
            e.stopPropagation();
            e.currentTarget.setPointerCapture(e.pointerId);
            cropDrag.current = { handle: (e.target as HTMLElement).dataset.h ?? "move", start: draft!, px: e.clientX, py: e.clientY };
        },
        onPointerMove(e: React.PointerEvent) {
            const d = cropDrag.current;
            if (!d) return;
            const r = frameRef.current!.getBoundingClientRect();
            setDraft(adjustCrop(d.start, d.handle, (e.clientX - d.px) / r.width, (e.clientY - d.py) / r.height));
        },
        onPointerUp() {
            cropDrag.current = null;
        },
        onDoubleClick() {
            setDraft(FULL_FRAME);
        }
    };

    const faded = fade && hover.inside && !interactive;
    const radius = cropping ? "4px" : circle ? "50%" : `${cornerRadius}px`;

    return (
        <div
            className={classes("co-root", interactive && "co-interactive", dragging && "co-dragging", cropping && "co-cropping", following && "co-follow")}
            style={{ "--co-radius": radius } as React.CSSProperties}        >
            <style>{css}</style>
            <div
                ref={frameRef}
                className="co-frame"
                title={interactive && !cropping ? "Drag to move · scroll or drag a corner to resize" : undefined}
                style={{ opacity: faded ? hoverOpacity : 1 }}
                onPointerDown={onFramePointerDown}
                onPointerUp={onFramePointerUp}
                onWheel={onWheel}
            >
                <video
                    ref={videoRef}
                    className="co-video"
                    autoPlay
                    muted
                    playsInline
                    style={{
                        width: `${100 / region.w}%`,
                        height: `${100 / region.h}%`,
                        left: `${-region.x / region.w * 100}%`,
                        top: `${-region.y / region.h * 100}%`
                    }}
                />
                {draft && (
                    <div
                        className="co-crop"
                        style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.w * 100}%`, height: `${draft.h * 100}%` }}
                        {...cropHandlers}
                    >
                        {CROP_HANDLES.map(h => <i key={h} data-h={h} />)}
                    </div>
                )}
                {selfStreamId && (
                    <video
                        ref={selfRef}
                        // Hidden, not unmounted: the stream is attached once per selfStreamId, a remounted element would stay empty
                        hidden={cropping}
                        className={classes("co-self", selfBig && "big")}
                        title={selfBig ? "Click to shrink" : "Click to enlarge"}
                        autoPlay
                        muted
                        playsInline
                        onPointerDown={e => e.stopPropagation()}
                        onClick={() => setSelfBig(b => !b)}
                    />
                )}
                <div className={classes("co-ring", speakingRing && speaking && !cropping && "on")} />
                {theyOff && !cropping && (
                    <div className="co-muted" title={theyOff === "deaf" ? "Their sound is off" : "Their microphone is off"}>
                        <Icon>{theyOff === "deaf" ? icons.headphones() : icons.mic()}{slash()}</Icon>
                    </div>
                )}
            </div>
            <div className={classes("co-grip", (faded || (intro && !interactive)) && "on")}>
                <svg viewBox="0 0 18 10" aria-hidden="true">
                    {[3, 9, 15].flatMap(x => [2.5, 7.5].map(y => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.6" />))}
                </svg>
            </div>
            {(["tl", "tr", "bl", "br"] as const).map(c => <div key={c} className={`co-handle ${c}`} {...resizeHandlers(c)} />)}
            <div className="co-bar" onPointerDown={e => e.stopPropagation()}>
                {draft ? <>
                    <Button label="Apply crop" onClick={() => finishCrop(draft)}>{icons.apply()}</Button>
                    <Button label="Show the whole frame" onClick={() => setDraft(FULL_FRAME)}>{icons.full()}</Button>
                    <Button label="Cancel" onClick={() => finishCrop(null)}>{icons.cancel()}</Button>
                </> : <>
                    <Button label={muted ? "Unmute" : "Mute"} off={muted} onClick={() => AudioActions.toggleSelfMute()}>
                        {icons.mic()}{muted && slash()}
                    </Button>
                    <Button label={cameraOn ? "Turn off your camera" : "Turn on your camera"} off={!cameraOn} onClick={() => VideoActions.setVideoEnabled(!cameraOn)}>
                        {icons.camera()}{!cameraOn && slash()}
                    </Button>
                    <Button label="Crop" onClick={startCrop}>{icons.crop()}</Button>
                    <Button label="Hide until the next call (or press the hide hotkey)" onClick={() => Native.setHidden(true)}>{icons.hide()}</Button>
                </>}
            </div>
        </div>
    );
}
