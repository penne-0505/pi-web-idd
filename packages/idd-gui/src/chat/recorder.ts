/**
 * The browser's own recorder: one MediaRecorder over the default microphone. It is handed to the store from `App`
 * so a test can drive the voice path with a stand-in (DEC-118-7), and it holds no key and no network of its own.
 */

import type { Recorder, Recording } from "./store";

/** the first audio type the browser will record in, or the browser's own default when none is named */
function pickMime(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  for (const type of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(type)) return type;
  }
  return "";
}

export const browserRecorder: Recorder = {
  async start(): Promise<Recording> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = pickMime();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    recorder.start();
    const stopTracks = () => stream.getTracks().forEach((track) => track.stop());
    const finish = (): Promise<Blob> => new Promise((resolve) => {
      recorder.onstop = () => {
        stopTracks();
        resolve(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
      };
      recorder.stop();
    });
    return {
      async stop() {
        const audio = await finish();
        return { audio, contentType: audio.type || "audio/webm" };
      },
      cancel() {
        try {
          if (recorder.state !== "inactive") recorder.stop();
        } catch { /* already stopped */ }
        stopTracks();
      },
    };
  },
};
