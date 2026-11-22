/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Native } from "./settings";

// Keep in sync with the import below, which has to be a plain string
const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm";
/** Detection runs on a frame scaled down to this width: the model itself only looks at 128×128 */
const FRAME_WIDTH = 320;

interface Box { originX: number; originY: number; width: number; height: number; }
interface Detector { detect(image: ImageBitmap): { detections: { boundingBox?: Box; }[]; }; }

let detector: Promise<Detector> | null = null;

/** MediaPipe loads on first use; a failed load is tried again on the next call */
function getDetector() {
    return detector ??= (async () => {
        // @ts-expect-error
        const { FaceDetector, FilesetResolver } = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/vision_bundle.mjs");
        const [fileset, model] = await Promise.all([FilesetResolver.forVisionTasks(WASM), Native.getFaceModel()]);
        return FaceDetector.createFromOptions(fileset, { baseOptions: { modelAssetBuffer: model }, runningMode: "IMAGE" });
    })().catch(e => {
        detector = null;
        throw e;
    });
}

/** Centre of the biggest face in the video, as fractions of the frame; null when there's none */
export async function findFace(video: HTMLVideoElement) {
    if (!video.videoWidth) return null;
    const d = await getDetector();
    const w = FRAME_WIDTH, h = Math.round(FRAME_WIDTH * video.videoHeight / video.videoWidth);
    const frame = await createImageBitmap(video, { resizeWidth: w, resizeHeight: h });
    try {
        const boxes = d.detect(frame).detections.flatMap(x => x.boundingBox ?? []);
        const box = boxes.sort((a, b) => b.width * b.height - a.width * a.height)[0];
        return box ? { x: (box.originX + box.width / 2) / w, y: (box.originY + box.height / 2) / h } : null;
    } finally {
        frame.close();
    }
}
