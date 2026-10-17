export {};

const bridge = window.captureBridge;
let token: string | null = null;
let stream: MediaStream | null = null;
let stopping = false;

const video = document.createElement('video');
video.setAttribute('playsinline', 'true');
video.muted = true;
video.style.display = 'none';
document.body.appendChild(video);

function cleanup(): void {
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  video.pause();
  video.srcObject = null;
  video.removeAttribute('src');
  video.load();
  const c = document.createElement('canvas');
  c.width = 0;
  c.height = 0;
}

function watchEnded(s: MediaStream): void {
  const videoTrack = s.getVideoTracks()[0];
  if (!videoTrack) return;
  videoTrack.addEventListener('ended', () => {
    if (!stopping && token) {
      cleanup();
      bridge.lost('camera stream ended');
    }
  });
}

async function startCamera(t: string): Promise<void> {
  token = t;
  stopping = false;
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { width: 640, height: 480 },
    });
    if (stopping || token !== t) {
      for (const track of s.getTracks()) track.stop();
      return;
    }
    stream = s;
    watchEnded(s);
    video.srcObject = s;
    const loaded = new Promise<void>((resolve, reject) => {
      const timeout=setTimeout(()=>reject(new Error("video load timed out")),10000);
      video.onloadeddata = () => {clearTimeout(timeout);resolve();};
      video.onerror = () => reject(new Error('video load failed'));

    });
    await video.play();
    await loaded;
    if (stopping || token !== t) {
      cleanup();
      return;
    }
    bridge.ready(t);
  } catch (err) {
    cleanup();
    bridge.ready(t, err instanceof Error ? err.message : 'camera start failed');
  }
}

async function takeFrame(t: string): Promise<void> {
  if (token !== t) return;
  try {
    if (!stream || stream.getVideoTracks().every((tr) => !tr.readyState.startsWith('live')) || video.readyState < 2) {
      bridge.frame(t, undefined, 'camera stream is not live');
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bridge.frame(t, undefined, 'canvas unavailable');
      return;
    }
    ctx.drawImage(video, 0, 0, 640, 480);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.75);
    if (!dataUrl.startsWith('data:image/jpeg;base64,') || dataUrl.length >= 3_000_000) {
      bridge.frame(t, undefined, 'camera frame invalid or too large');
      return;
    }
    bridge.frame(t, dataUrl);
  } catch (err) {
    bridge.frame(t, undefined, err instanceof Error ? err.message : 'frame capture failed');
  }
}

function stopCapture(t: string): void {
  stopping = true;
  token=null;
  cleanup();
  bridge.ready(t);
}

bridge.onCommand((type, t) => {
  if (type === 'start') void startCamera(t);
  else if (type === 'frame') void takeFrame(t);
  else if (type === 'stop') stopCapture(t);
});
