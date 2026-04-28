const landing = document.querySelector("#landing");
const game = document.querySelector("#game");
const video = document.querySelector("#video");
const canvas = document.querySelector("#overlay");
const ctx = canvas.getContext("2d");

const startBtn = document.querySelector("#startBtn");
const retryBtn = document.querySelector("#retryBtn");
const homeBtn = document.querySelector("#homeBtn");
const shareBtn = document.querySelector("#shareBtn");

const scoreEl = document.querySelector("#score");
const timerEl = document.querySelector("#timer");
const statusText = document.querySelector("#statusText");
const meterFill = document.querySelector("#meterFill");
const countdownEl = document.querySelector("#countdown");
const resultEl = document.querySelector("#result");
const finalScore = document.querySelector("#finalScore");
const resultMessage = document.querySelector("#resultMessage");
const errorBanner = document.querySelector("#errorBanner");

let PoseLandmarker;
let HandLandmarker;
let FilesetResolver;
let DrawingUtils;
let poseLandmarker;
let handLandmarker;

const MEDIAPIPE_MODULE_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/vision_bundle.mjs";
const MEDIAPIPE_WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";
const POSE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const HAND_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

let stream;
let running = false;
let challengeActive = false;
let animationId = null;
let timerInterval = null;

let score = 0;
let lastVideoTime = -1;
let challengeStart = 0;
let lastWaveScoreTime = 0;
let waveHits = 0;
let waveIntensity = 0;
let noseHoldFrames = 0;
let noseCovered = false;
let poseFrames = 0;
let lastStatusKey = null;
let handTracks = [];
let nextHandTrackId = 1;
let noseHandId = null;
const waveStates = new Map();

const GAME_SECONDS = 30;
const COUNTDOWN_SECONDS = 3;

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

function showError(message) {
  if (!errorBanner) {
    alert(message);
    return;
  }
  errorBanner.textContent = message;
  errorBanner.classList.remove("hidden");
}

function clearError() {
  if (!errorBanner) return;
  errorBanner.textContent = "";
  errorBanner.classList.add("hidden");
}

function preflightCheck() {
  if (location.protocol === "file:") {
    return (
      "This game will not work by double-clicking index.html.\n\n" +
      "Use VS Code Live Server, or run:\n\n" +
      "python -m http.server 8000\n\n" +
      "Then open http://localhost:8000"
    );
  }

  if (!window.isSecureContext) {
    return "Camera access requires HTTPS or localhost. Use Live Server or deploy to an HTTPS host.";
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    return "This browser does not support camera access. Try Chrome, Edge, or Safari.";
  }

  return null;
}

const firstPreflightError = preflightCheck();
if (firstPreflightError) showError(firstPreflightError);

async function loadMediaPipeLibrary() {
  if (FilesetResolver) return;

  statusText.textContent = "Loading motion tracker...";
  const mod = await import(MEDIAPIPE_MODULE_URL);

  PoseLandmarker = mod.PoseLandmarker;
  HandLandmarker = mod.HandLandmarker;
  FilesetResolver = mod.FilesetResolver;
  DrawingUtils = mod.DrawingUtils;
}

async function loadModels() {
  if (poseLandmarker && handLandmarker) return;

  await loadMediaPipeLibrary();
  statusText.textContent = "Preparing hand tracker...";
  const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_URL);

  const makePose = async (delegate) => PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: POSE_MODEL_URL,
      delegate
    },
    runningMode: "VIDEO",
    numPoses: 1,
    minPoseDetectionConfidence: 0.35,
    minPosePresenceConfidence: 0.35,
    minTrackingConfidence: 0.35
  });

  const makeHands = async (delegate) => HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: HAND_MODEL_URL,
      delegate
    },
    runningMode: "VIDEO",
    numHands: 2,
    minHandDetectionConfidence: 0.35,
    minHandPresenceConfidence: 0.35,
    minTrackingConfidence: 0.35
  });

  try {
    poseLandmarker = await makePose("GPU");
    handLandmarker = await makeHands("GPU");
  } catch (gpuError) {
    poseLandmarker = await makePose("CPU");
    handLandmarker = await makeHands("CPU");
  }
}

async function startCamera() {
  stream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 60, min: 30 },
      facingMode: "user"
    },
    audio: false
  });

  video.srcObject = stream;

  await new Promise((resolve) => {
    video.onloadedmetadata = resolve;
  });

  await video.play();
}

async function enterFullscreen() {
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
    }
  } catch {
    // Not fatal.
  }
}

function describeError(error) {
  const name = error?.name;
  const msg = error?.message || String(error);

  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "Camera permission was denied. Click the camera icon in the address bar, allow camera access, then try again.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No camera was found. Plug in or enable your webcam, then try again.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "Your camera is being used by another app. Close Zoom, Meet, OBS, or other camera apps, then try again.";
  }
  if (msg.includes("Failed to fetch") || msg.includes("dynamically imported module")) {
    return "The hand tracker could not load from the internet. Check your connection, then refresh.";
  }

  return `Could not start: ${msg}`;
}

async function startGame() {
  clearError();

  const preflightError = preflightCheck();
  if (preflightError) {
    showError(preflightError);
    return;
  }

  startBtn.disabled = true;
  startBtn.textContent = "Starting...";

  try {
    landing.classList.add("hidden");
    game.classList.remove("hidden");
    resultEl.classList.add("hidden");

    statusText.textContent = "Requesting camera access...";
    enterFullscreen();

    await startCamera();

    running = true;
    resetChallenge();
    if (!animationId) animationId = requestAnimationFrame(detectLoop);

    statusText.textContent = "Camera ready. Loading hand tracker...";
    await loadModels();

    await runCountdown();
    beginChallenge();
  } catch (error) {
    console.error(error);
    cleanupRound();
    landing.classList.remove("hidden");
    game.classList.add("hidden");
    showError(describeError(error));
  } finally {
    startBtn.disabled = false;
    startBtn.textContent = "Start Scuba Challenge";
  }
}

function resetChallenge() {
  score = 0;
  waveHits = 0;
  poseFrames = 0;
  lastWaveScoreTime = 0;
  waveIntensity = 0;
  noseHoldFrames = 0;
  noseCovered = false;
  noseHandId = null;
  handTracks = [];
  waveStates.clear();
  nextHandTrackId = 1;
  lastStatusKey = null;
  challengeActive = false;
  challengeStart = 0;

  scoreEl.textContent = "0";
  timerEl.textContent = GAME_SECONDS.toFixed(1);
  meterFill.style.width = "0%";
  statusText.textContent = "Stand back so your face and both hands are visible.";
}

function runCountdown() {
  return new Promise((resolve) => {
    let current = COUNTDOWN_SECONDS;
    countdownEl.textContent = current;
    countdownEl.classList.remove("hidden");

    const interval = setInterval(() => {
      current -= 1;

      if (current > 0) {
        countdownEl.textContent = current;
      } else {
        countdownEl.textContent = "SCUBA!";
        clearInterval(interval);

        setTimeout(() => {
          countdownEl.classList.add("hidden");
          resolve();
        }, 550);
      }
    }, 1000);
  });
}

function beginChallenge() {
  challengeActive = true;
  challengeStart = performance.now();
  statusText.textContent = "Keep one marker on your nose. Move the WAVE marker side to side.";

  clearInterval(timerInterval);
  timerInterval = setInterval(updateTimer, 50);
  updateTimer();
}

function detectLoop() {
  if (!running) return;

  resizeCanvas();
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!poseLandmarker || !handLandmarker) {
    drawCameraGuide();
    animationId = requestAnimationFrame(detectLoop);
    return;
  }

  if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;

    try {
      const now = performance.now();
      const poseDetection = poseLandmarker.detectForVideo(video, now);
      const handDetection = handLandmarker.detectForVideo(video, now);

      const pose = poseDetection.landmarks?.[0] || null;
      const rawHands = handDetection.landmarks || [];
      const tracks = updateHandTracks(rawHands, now);

      if (pose) poseFrames += 1;
      drawTrackingView(pose, tracks);

      if (challengeActive) {
        if (pose && tracks.length > 0) {
          scoreMove(pose, tracks, now);
        } else if (!pose) {
          setStatus("no_pose", "I cannot see your face/body clearly. Step back and face the camera.");
        } else {
          setStatus("no_hands", "I need to see your hands. Open your hands toward the camera.");
        }
      }
    } catch (error) {
      console.error(error);
      if (challengeActive) setStatus("tracker_glitch", "Tracker had a small glitch. Keep moving.");
    }
  } else {
    drawTrackingView(null, getFreshHandTracks(performance.now()));
  }

  animationId = requestAnimationFrame(detectLoop);
}

function drawCameraGuide() {
  drawMirroredReadableText(
    "Camera is on. Loading hand tracker...",
    canvas.width / 2,
    canvas.height / 2,
    {
      font: "700 22px system-ui",
      fillStyle: "rgba(255,255,255,0.9)",
      strokeStyle: null,
      lineWidth: 0
    }
  );
}

function drawMirroredReadableText(text, x, y, options = {}) {
  const {
    font = "900 14px system-ui",
    fillStyle = "white",
    strokeStyle = "rgba(0, 0, 0, 0.65)",
    lineWidth = 5,
    textAlign = "center",
    textBaseline = "middle"
  } = options;

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(-1, 1);
  ctx.font = font;
  ctx.textAlign = textAlign;
  ctx.textBaseline = textBaseline;
  if (strokeStyle && lineWidth > 0) {
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = strokeStyle;
    ctx.strokeText(text, 0, 0);
  }
  ctx.fillStyle = fillStyle;
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

function clearOverlay() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function exitFullscreenIfNeeded() {
  if (document.fullscreenElement && document.exitFullscreen) {
    document.exitFullscreen().catch(() => {});
  }
}

function drawTrackingView(pose, tracks) {
  drawPoseGuide(pose);
  drawHandMarkers(tracks);
}

function drawPoseGuide(landmarks) {
  if (!landmarks || !DrawingUtils || !PoseLandmarker) return;

  const drawingUtils = new DrawingUtils(ctx);
  ctx.save();
  ctx.scale(canvas.width, canvas.height);

  drawingUtils.drawConnectors(
    landmarks,
    PoseLandmarker.POSE_CONNECTIONS,
    { color: "rgba(255,255,255,0.25)", lineWidth: 0.003 }
  );


  drawingUtils.drawLandmarks(
    [landmarks[0], landmarks[11], landmarks[12]],
    { color: "rgba(255,255,255,0.65)", radius: 0.006 }
  );

  ctx.restore();
}

function drawHandMarkers(tracks) {
  const now = performance.now();
  const fresh = tracks.filter((track) => now - track.lastSeen < 220);

  for (const track of fresh) {
    const isNoseHand = track.id === noseHandId;
    const label = isNoseHand ? "NOSE" : "WAVE";
    const x = track.x * canvas.width;
    const y = track.y * canvas.height;

    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, isNoseHand ? 25 : 29, 0, Math.PI * 2);
    ctx.fillStyle = isNoseHand ? "rgba(142, 234, 255, 0.28)" : "rgba(255, 255, 255, 0.30)";
    ctx.fill();
    ctx.lineWidth = isNoseHand ? 5 : 6;
    ctx.strokeStyle = isNoseHand ? "#8eeaff" : "#ffffff";
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = isNoseHand ? "#8eeaff" : "#ffffff";
    ctx.fill();

    ctx.restore();

    drawMirroredReadableText(label, x, y - 43, {
      font: "900 14px system-ui",
      fillStyle: "white",
      strokeStyle: "rgba(0, 0, 0, 0.65)",
      lineWidth: 5
    });
  }
}

function getHandCenter(handLandmarks) {
  const ids = [0, 5, 9, 13, 17, 8, 12, 16, 20];
  let x = 0;
  let y = 0;
  for (const id of ids) {
    x += handLandmarks[id].x;
    y += handLandmarks[id].y;
  }
  return { x: x / ids.length, y: y / ids.length };
}

function updateHandTracks(rawHands, now) {
  const rawCenters = rawHands.map((landmarks) => ({
    center: getHandCenter(landmarks),
    landmarks
  }));

  const usedTrackIds = new Set();
  const matchedTracks = [];

  for (const raw of rawCenters) {
    let bestTrack = null;
    let bestDist = Infinity;

    for (const track of handTracks) {
      if (usedTrackIds.has(track.id)) continue;
      const age = now - track.lastSeen;
      if (age > 350) continue;

      const d = Math.hypot(raw.center.x - track.x, raw.center.y - track.y);
      if (d < bestDist) {
        bestDist = d;
        bestTrack = track;
      }
    }

    if (!bestTrack || bestDist > 0.24) {
      bestTrack = {
        id: nextHandTrackId++,
        x: raw.center.x,
        y: raw.center.y,
        rawX: raw.center.x,
        rawY: raw.center.y,
        lastSeen: now,
        history: [],
        recentActivity: 0
      };
      handTracks.push(bestTrack);
    } else {
      const smoothing = 0.78;
      bestTrack.x = bestTrack.x + (raw.center.x - bestTrack.x) * smoothing;
      bestTrack.y = bestTrack.y + (raw.center.y - bestTrack.y) * smoothing;
      const dx = raw.center.x - bestTrack.rawX;
      bestTrack.recentActivity = bestTrack.recentActivity * 0.85 + Math.abs(dx) * 0.15;
      bestTrack.rawX = raw.center.x;
      bestTrack.rawY = raw.center.y;
      bestTrack.lastSeen = now;
    }

    bestTrack.history.push({ t: now, x: bestTrack.rawX, y: bestTrack.rawY });
    while (bestTrack.history.length > 1 && now - bestTrack.history[0].t > 450) {
      bestTrack.history.shift();
    }

    usedTrackIds.add(bestTrack.id);
    matchedTracks.push(bestTrack);
  }

  handTracks = handTracks.filter((track) => now - track.lastSeen < 600);
  return getFreshHandTracks(now);
}

function getFreshHandTracks(now) {
  return handTracks.filter((track) => now - track.lastSeen < 260);
}

function visibilityOk(point, min = 0.2) {
  if (!point) return false;
  if (typeof point.x !== "number" || typeof point.y !== "number") return false;
  if (typeof point.visibility !== "number") return true;
  return point.visibility >= min;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function addScore(points) {
  score += points;
  scoreEl.textContent = String(score);
}

function setStatus(key, message) {
  if (lastStatusKey === key) return;
  lastStatusKey = key;
  statusText.textContent = message;
}

function scoreMove(pose, tracks, now) {
  const nose = pose[0];
  const leftShoulder = pose[11];
  const rightShoulder = pose[12];

  const visible =
    visibilityOk(nose, 0.25) &&
    visibilityOk(leftShoulder, 0.15) &&
    visibilityOk(rightShoulder, 0.15);

  if (!visible) {
    setStatus("no_pose", "Move back or improve lighting so I can see your face and shoulders.");
    noseCovered = false;
    noseHandId = null;
    return;
  }

  const shoulderWidth = Math.max(0.16, distance(leftShoulder, rightShoulder));
  const enterCoverDist = shoulderWidth * 0.95;
  const exitCoverDist = shoulderWidth * 1.25;

  let currentNoseTrack = tracks.find((track) => track.id === noseHandId);
  let currentNoseDist = currentNoseTrack ? distance(currentNoseTrack, nose) : Infinity;

  if (!noseCovered || !currentNoseTrack || currentNoseDist > exitCoverDist) {
    const closest = tracks
      .map((track) => ({ track, d: distance(track, nose) }))
      .sort((a, b) => a.d - b.d)[0];

    if (closest && closest.d < enterCoverDist) {
      noseCovered = true;
      noseHandId = closest.track.id;
      currentNoseTrack = closest.track;
      currentNoseDist = closest.d;
    } else {
      noseCovered = false;
      noseHandId = null;
    }
  }

  if (noseCovered) {
    noseHoldFrames = Math.min(noseHoldFrames + 1, 200);
  } else {
    noseHoldFrames = Math.max(0, noseHoldFrames - 2);
  }

  const waveTrack = tracks
    .filter((track) => track.id !== noseHandId)
    .sort((a, b) => (b.recentActivity || 0) - (a.recentActivity || 0))[0];

  let gotWave = false;
  if (noseCovered && waveTrack) {
    gotWave = updateWaveFromHandMarker(waveTrack, shoulderWidth, now);
  }

  if (gotWave && now - lastWaveScoreTime > 50) {
    addScore(1);
    waveHits += 1;
    waveIntensity = Math.min(60, waveIntensity + 16);
    lastWaveScoreTime = now;
  }

  waveIntensity = Math.max(0, waveIntensity - 0.55);

  const coverPercent = Math.min(40, noseHoldFrames * 1.4);
  const wavePercent = Math.min(60, waveIntensity);
  const formScore = Math.min(100, Math.round(coverPercent + wavePercent));
  meterFill.style.width = `${formScore}%`;

  if (tracks.length < 2) {
    setStatus("need_two_hands", "I can see one hand marker. Show both hands so one can be NOSE and one can be WAVE.");
  } else if (!noseCovered) {
    setStatus("no_cover", "Move one hand marker onto your nose.");
  } else if (!waveTrack) {
    setStatus("no_wave_hand", "Good nose marker. Now show your other hand for the WAVE marker.");
  } else if (waveIntensity < 12) {
    setStatus("cover_only", "Good cover. Move the WAVE marker left and right faster.");
  } else {
    setStatus("doing_it", "Recognized! Keep the WAVE marker moving side to side.");
  }
}

function updateWaveFromHandMarker(track, shoulderWidth, now) {
  // Frame-to-frame direction tracker on the RAW hand position.
  //
  // Why not velocity-over-window like before? At fast fan speeds (~5 Hz, one
  // half-cycle = 100 ms), any velocity window longer than the half-cycle
  // averages forward and reverse motion together → net velocity collapses to
  // near zero → detector sees nothing. The faster you go, the worse it gets.
  //
  // Frame-to-frame direction tracking has no time window. It only needs:
  //   - direction of this frame's delta vs last frame
  //   - cumulative travel since the last reversal
  // A reversal scores when the cumulative travel before the reversal cleared
  // the amplitude threshold. Works at any speed up to (camera fps / 2) Hz.
  const rawX = track.rawX;

  let state = waveStates.get(track.id);
  if (!state) {
    waveStates.set(track.id, {
      dir: 0,                   // -1 = moving left, +1 = moving right, 0 = undecided
      lastX: rawX,
      travelInDir: 0,           // accumulated |dx| since the last reversal
      lastScoreTime: 0
    });
    return false;
  }

  const dx = rawX - state.lastX;
  state.lastX = rawX;

  // Per-frame jitter floor. Tiny enough that real motion is never gated out
  // (a fast fan moves ~3-6% of shoulder-width per frame at 60 fps), big
  // enough to ignore MediaPipe landmark noise on a stationary hand.
  const jitterFloor = shoulderWidth * 0.012;
  if (Math.abs(dx) < jitterFloor) return false;

  const newDir = dx > 0 ? 1 : -1;

  if (state.dir === 0) {
    state.dir = newDir;
    state.travelInDir = Math.abs(dx);
    return false;
  }

  if (newDir === state.dir) {
    // Still going the same way — keep accumulating travel.
    state.travelInDir += Math.abs(dx);
    return false;
  }


  const minTravel = shoulderWidth * 0.10;     // ~10% of shoulder-width
  const minPeriodMs = 50;                     // ~20 events/sec ceiling

  const enoughTravel = state.travelInDir > minTravel;
  const enoughTime = now - state.lastScoreTime > minPeriodMs;

  state.dir = newDir;
  state.travelInDir = Math.abs(dx);

  if (enoughTravel && enoughTime) {
    state.lastScoreTime = now;
    return true;
  }
  return false;
}

function updateTimer() {
  if (!challengeActive) return;

  const elapsed = (performance.now() - challengeStart) / 1000;
  const remaining = Math.max(0, GAME_SECONDS - elapsed);

  timerEl.textContent = remaining.toFixed(1);

  if (remaining <= 0) endChallenge();
}

function endChallenge() {
  challengeActive = false;
  clearInterval(timerInterval);
  timerInterval = null;

  resultEl.classList.remove("hidden");
  finalScore.textContent = String(score);

  if (score >= 180) {
    resultMessage.textContent = "Legend level. The scuba speed is unreal.";
  } else if (score >= 110) {
    resultMessage.textContent = "Strong rhythm. You understood the assignment.";
  } else if (score >= 50) {
    resultMessage.textContent = "Good start. Try fanning faster — speed is the whole game.";
  } else {
    resultMessage.textContent = "Warm-up round. Keep one hand on your nose and fan the other faster.";
  }
}

function cleanupRound() {
  challengeActive = false;
  running = false;

  clearInterval(timerInterval);
  timerInterval = null;

  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }

  stopCamera();
}

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  if (video) video.srcObject = null;
}

function goHome() {
  cleanupRound();
  exitFullscreenIfNeeded();
  resetChallenge();
  resultEl.classList.add("hidden");
  game.classList.add("hidden");
  landing.classList.remove("hidden");
  clearOverlay();
  shareBtn.textContent = "Copy Score Text";
}

async function playAgain() {
  resultEl.classList.add("hidden");
  resetChallenge();
  await runCountdown();
  beginChallenge();
}

async function copyScoreText() {
  const text = `I scored ${score} on Scuba Speed. Can you beat me?`;

  try {
    await navigator.clipboard.writeText(text);
    shareBtn.textContent = "Copied!";
    setTimeout(() => (shareBtn.textContent = "Copy Score Text"), 1200);
  } catch {
    alert(text);
  }
}

startBtn.addEventListener("click", startGame);
retryBtn.addEventListener("click", playAgain);
homeBtn.addEventListener("click", goHome);
shareBtn.addEventListener("click", copyScoreText);

window.addEventListener("beforeunload", () => {
  cleanupRound();
});