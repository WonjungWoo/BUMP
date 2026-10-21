(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let motionEnabled = !reducedMotion.matches;
  let explicitMotionChoice = false;
  const groups = $$("[data-video-group]").map((element) => ({
    element, videos: $$("video", element), visible: false,
  }));
  const groupByVideo = new Map(groups.flatMap((group) => group.videos.map((video) => [video, group])));
  const editGroup = groups.find((group) => group.element.id === "edit-player");
  const processGroup = groups.find((group) => group.element.classList.contains("method-process"));
  const roleGroup = groups.find((group) => group.element.classList.contains("role-movie"));
  let editBatchReady = false;
  let processBatchReady = false;
  let roleReplaying = false;

  function activeVideo(video) {
    const layer = video.closest(".video-layer");
    const sample = video.closest("[data-edit-panel]");
    return (!layer || layer.classList.contains("is-active")) && (!sample || !sample.hidden);
  }
  function eligible(video) {
    const group = groupByVideo.get(video);
    return motionEnabled && !document.hidden && group.visible && activeVideo(video) && (group !== editGroup || editBatchReady) && (group !== processGroup || processBatchReady) && (group !== roleGroup || !roleReplaying);
  }
  function mediaMessage(video, message) {
    const status = video.parentElement.querySelector(".media-error");
    if (status) { status.textContent = message; status.hidden = false; }
  }
  function startVideo(video) {
    if (!eligible(video) || video.ended || !video.paused) return;
    video.play().catch((error) => {
      if (error.name === "AbortError" || !eligible(video)) return;
      if (error.name === "NotAllowedError") {
        mediaMessage(video, "Automatic playback is blocked. Use the Play motion button.");
        setMotion(false);
      } else {
        mediaMessage(video, "This clip could not play. Try Play motion or another browser.");
      }
    });
  }
  function refreshGroup(group) {
    group.videos.forEach((video) => {
      if (eligible(video)) startVideo(video);
      else if (!video.paused) video.pause();
    });
  }
  function refreshPlayback() { groups.forEach(refreshGroup); }
  function publishMotionState() {
    document.documentElement.dataset.motion = motionEnabled ? "playing" : "paused";
    $("#motion-label").textContent = motionEnabled ? "Pause motion" : "Play motion";
    $("#motion-toggle .motion-icon").textContent = motionEnabled ? "Ⅱ" : "▷";
    $("#motion-toggle").setAttribute("aria-pressed", String(motionEnabled));
    $$("[data-motion-toggle]").forEach((button) => {
      button.textContent = motionEnabled ? "Ⅱ Pause motion" : "▷ Play motion";
      button.setAttribute("aria-pressed", String(motionEnabled));
    });
    document.dispatchEvent(new CustomEvent("bump-motion-change", { detail: { enabled: motionEnabled } }));
  }
  function setMotion(enabled, explicit = false) {
    motionEnabled = enabled;
    explicitMotionChoice ||= explicit;
    publishMotionState();
    refreshPlayback();
  }

  groups.forEach((group) => group.videos.forEach((video) => {
    video.muted = true;
    video.controls = false;
    video.disablePictureInPicture = true;
    video.tabIndex = -1;
    video.autoplay = false;
    video.pause();
    video.addEventListener("loadeddata", () => startVideo(video));
    video.addEventListener("playing", () => {
      const status = video.parentElement.querySelector(".media-error");
      if (status) status.hidden = true;
      video.dataset.playback = "playing";
    });
    video.addEventListener("ended", () => { if (!video.loop) video.dataset.playback = "held"; });
    video.addEventListener("error", () => mediaMessage(video, "Video unavailable. Please try another browser."));
  }));
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const group = groups.find((item) => item.element === entry.target);
        group.visible = entry.isIntersecting;
        // Visibility changes never seek or reload a clip, or disturb another group.
        refreshGroup(group);
      });
    }, { threshold: 0.05 });
    groups.forEach((group) => observer.observe(group.element));
  } else {
    groups.forEach((group) => { group.visible = true; });
  }
  $("#motion-toggle").hidden = false;
  $("#motion-toggle").addEventListener("click", () => setMotion(!motionEnabled, true));
  $$("[data-motion-toggle]").forEach((button) => {
    button.hidden = false;
    button.addEventListener("click", () => setMotion(!motionEnabled, true));
  });
  document.addEventListener("visibilitychange", refreshPlayback);
  reducedMotion.addEventListener("change", () => {
    if (!explicitMotionChoice) setMotion(!reducedMotion.matches);
  });
  publishMotionState();
  refreshPlayback();

  const preparation = new WeakMap();
  function prepare(video) {
    // Atomic selections need a buffered next frame, not only decoded frame zero.
    if (video.readyState >= 3) return Promise.resolve(video);
    if (preparation.has(video)) return preparation.get(video);
    const pending = new Promise((resolve, reject) => {
      let timer;
      function finish(error) {
        clearTimeout(timer);
        video.removeEventListener("canplay", ready);
        video.removeEventListener("error", failed);
        preparation.delete(video);
        if (error) reject(error); else resolve(video);
      }
      const ready = () => finish();
      const failed = () => finish(new Error("The requested clip is unavailable."));
      video.addEventListener("canplay", ready, { once: true });
      video.addEventListener("error", failed, { once: true });
      timer = setTimeout(() => finish(new Error("The requested clip is still loading. Please try again.")), 15000);
      // Only warm an unprepared clip. Its URL and the currently visible surface stay intact.
      if (video.preload !== "auto") { video.preload = "auto"; video.load(); }
    });
    preparation.set(video, pending);
    return pending;
  }
  Promise.allSettled(processGroup.videos.map(prepare)).then(() => {
    processBatchReady = true;
    refreshGroup(processGroup);
  });
  async function resetForReplay(video) {
    await prepare(video);
    video.pause();
    if (video.currentTime <= 0.005) return;
    await new Promise((resolve, reject) => {
      let timer;
      const done = () => {
        clearTimeout(timer);
        video.removeEventListener("seeked", done);
        resolve();
      };
      video.addEventListener("seeked", done, { once: true });
      timer = setTimeout(() => {
        video.removeEventListener("seeked", done);
        reject(new Error("The clip could not restart. Please try again."));
      }, 7000);
      // Seeking occurs only for an explicit replay/selection, never during automatic refresh.
      video.currentTime = 0;
    });
  }
  class VideoDeck {
    constructor(element) { this.element = element; this.layers = $$(".video-layer", element); }
    video(key) { return $("video", this.layers.find((layer) => layer.dataset.key === key)); }
    commit(key) {
      this.layers.forEach((layer) => {
        const active = layer.dataset.key === key;
        layer.classList.toggle("is-active", active);
        layer.setAttribute("aria-hidden", String(!active));
        layer.inert = !active;
        $("video", layer).tabIndex = -1;
      });
      this.element.dataset.active = key;
    }
  }

  const teaserDeck = new VideoDeck($("#teaser-deck"));
  const teaserKeys = ["tea", "kick", "domino", "tray"];
  const teaserNames = { tray: "Carry a tray", domino: "Topple dominoes", kick: "Kick a basket", tea: "Pour tea" };
  let teaserIndex = 0;
  let requestedTeaserIndex = 0;
  let teaserRequest = 0;
  async function selectTeaser(index) {
    const nextIndex = (index + teaserKeys.length) % teaserKeys.length;
    requestedTeaserIndex = nextIndex;
    const key = teaserKeys[nextIndex];
    const ticket = ++teaserRequest;
    teaserDeck.element.setAttribute("aria-busy", "true");
    $("#teaser-status").textContent = "Preparing this example…";
    try {
      const video = await prepare(teaserDeck.video(key));
      if (ticket !== teaserRequest) return;
      await resetForReplay(video);
      if (ticket !== teaserRequest) return;
      teaserDeck.commit(key);
      teaserIndex = nextIndex;
      $("#teaser-label").textContent = teaserNames[key];
      $("#teaser-count").textContent = `${String(teaserKeys.indexOf(key) + 1).padStart(2, "0")} / ${String(teaserKeys.length).padStart(2, "0")}`;
      $("[data-teaser-driver]").hidden = key === "kick";
      $("#teaser-status").textContent = "";
      refreshPlayback();
    } catch (error) {
      if (ticket === teaserRequest) {
        requestedTeaserIndex = teaserIndex;
        $("#teaser-status").textContent = error.message;
      }
    }
    finally { if (ticket === teaserRequest) teaserDeck.element.setAttribute("aria-busy", "false"); }
  }
  $$("[data-teaser-step]").forEach((button) => {
    button.hidden = false;
    button.addEventListener("click", () => selectTeaser(requestedTeaserIndex + Number(button.dataset.teaserStep)));
  });

  $$("[data-replay]").forEach((button) => {
    button.hidden = false;
    button.addEventListener("click", async () => {
      const group = groups.find((item) => item.element.contains(button));
      const videos = group.videos.filter(activeVideo);
      button.disabled = true;
      if (group === editGroup) editBatchReady = false;
      if (group === processGroup) processBatchReady = false;
      try {
        if (group === roleGroup) await replayRoleScene();
        else await Promise.all(videos.map(resetForReplay));
        if (group === editGroup) editBatchReady = true;
        if (group === processGroup) processBatchReady = true;
        setMotion(true, true);
        refreshGroup(group);
      } catch (error) { videos.forEach((video) => mediaMessage(video, error.message)); }
      finally {
        if (group === editGroup) editBatchReady = true;
        if (group === processGroup) processBatchReady = true;
        button.disabled = false;
      }
    });
  });

  const roleDeck = new VideoDeck($("#role-deck"));
  const roleIntro = roleDeck.video("intro");
  const roleWalk = roleDeck.video("walk");
  let roleRequest = 0;
  function updateRoleAnchors(video, mediaTime = video.currentTime) {
    const phase = video === roleIntro ? "intro" : "walk";
    if (roleDeck.element.dataset.active !== phase) return;
    const tracks = window.BUMP_ROLE_ANCHORS?.[phase];
    if (!tracks?.length) return;
    const frame = tracks[Math.min(tracks.length - 1, Math.max(0, Math.floor(mediaTime * 30)))];
    const bounds = roleDeck.element.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    ["human", "driver", "responder"].forEach((name, index) => {
      const x = frame[1 + index * 2], y = frame[2 + index * 2];
      const callout = $(`[data-callout="${name}"]`, roleDeck.element);
      const label = $(`[data-role="${name}"]`, roleDeck.element).getBoundingClientRect();
      const leadX = ((name === "human" ? label.right + 8 : label.left - 8) - bounds.left) * 1620 / bounds.width;
      const leadY = (label.top + label.height / 2 - bounds.top) * 780 / bounds.height;
      $("path", callout).setAttribute("d", `M${leadX} ${leadY} H${(leadX + x) / 2} L${x} ${y}`);
      $("circle", callout).setAttribute("cx", x);
      $("circle", callout).setAttribute("cy", y);
    });
  }
  function updateCallouts() {
    // Keep descriptions visible during the extended upright walking lead-in.
    roleGroup.element.classList.toggle("show-callouts", roleDeck.element.dataset.active === "walk" || roleIntro.currentTime >= Number(roleIntro.dataset.calloutStart || 3.35));
    updateRoleAnchors(roleDeck.element.dataset.active === "intro" ? roleIntro : roleWalk);
  }
  async function replayRoleScene() {
    const ticket = ++roleRequest;
    roleReplaying = true;
    refreshGroup(roleGroup);
    try {
      await Promise.all([roleIntro, roleWalk].map(resetForReplay));
      if (ticket !== roleRequest) return;
      roleDeck.commit("intro");
      roleGroup.element.dataset.rolePhase = "intro";
      updateCallouts();
    } finally { if (ticket === roleRequest) roleReplaying = false; }
  }
  roleIntro.addEventListener("loadeddata", () => {
    // Decode the walking surface while the introduction is still visible.
    prepare(roleWalk).catch((error) => mediaMessage(roleWalk, error.message));
  });
  roleIntro.addEventListener("ended", async () => {
    // Ignore a queued end from before an explicit replay/reset or inactive phase.
    if (roleReplaying || !roleIntro.ended || roleDeck.element.dataset.active !== "intro") return;
    const ticket = ++roleRequest;
    try {
      await prepare(roleWalk);
      if (ticket !== roleRequest) return;
      roleDeck.commit("walk");
      roleGroup.element.dataset.rolePhase = "walk";
      updateCallouts();
      refreshGroup(roleGroup);
    } catch (error) { mediaMessage(roleIntro, error.message); }
  });
  updateCallouts();
  ["loadeddata", "playing", "timeupdate", "seeked"].forEach((event) => roleIntro.addEventListener(event, updateCallouts));
  [roleIntro, roleWalk].forEach((video) => {
    if ("requestVideoFrameCallback" in video) {
      video.requestVideoFrameCallback(function trackFrame(_, metadata) {
        updateRoleAnchors(video, metadata.mediaTime);
        video.requestVideoFrameCallback(trackFrame);
      });
    } else {
      video.addEventListener("timeupdate", () => updateRoleAnchors(video));
    }
  });
  if (roleIntro.readyState >= 2) prepare(roleWalk).catch((error) => mediaMessage(roleWalk, error.message));

  const samplePanels = $$("[data-edit-panel]");
  const sampleButtons = $$("[data-edit-sample]");
  const sampleNames = { pan: "Frying pan · Original + 4 edits", tennis: "Tennis racket · Original + 2 edits" };
  let editRequest = 0;
  async function selectEditSample(sample) {
    const panel = samplePanels.find((item) => item.dataset.editPanel === sample);
    if (!panel) return;
    const ticket = ++editRequest;
    const previouslyReady = editBatchReady;
    editBatchReady = false;
    editGroup.videos.filter(activeVideo).forEach((video) => video.pause());
    editGroup.element.setAttribute("aria-busy", "true");
    $("#edit-status").textContent = "Preparing all videos for this sample…";
    try {
      const videos = await Promise.all($$("video", panel).map(prepare));
      if (ticket !== editRequest) return;
      await Promise.all(videos.map(resetForReplay));
      if (ticket !== editRequest) return;
      // Commit the whole decoded sample at once. No source or video node is replaced.
      samplePanels.forEach((item) => {
        const active = item === panel;
        item.hidden = !active;
        item.inert = !active;
        $$("video", item).forEach((video) => { video.tabIndex = -1; });
      });
      sampleButtons.forEach((button) => {
        const active = button.dataset.editSample === sample;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-pressed", String(active));
      });
      editGroup.element.dataset.activeSample = sample;
      $("#edit-summary").textContent = sampleNames[sample];
      $("#edit-status").textContent = "";
      editBatchReady = true;
      refreshPlayback();
    } catch (error) {
      if (ticket === editRequest) {
        $("#edit-status").textContent = error.message;
        editBatchReady = previouslyReady;
        refreshPlayback();
      }
    } finally {
      if (ticket === editRequest) editGroup.element.setAttribute("aria-busy", "false");
    }
  }
  sampleButtons.forEach((button) => button.addEventListener("click", () => selectEditSample(button.dataset.editSample)));
  selectEditSample("pan");

  const bibtexCopy = $("#bibtex-copy");
  const bibtexEntry = $("#bibtex-entry");
  bibtexCopy.addEventListener("click", async () => {
    const label = bibtexCopy.textContent;
    try {
      await navigator.clipboard.writeText(bibtexEntry.textContent.trim());
      bibtexCopy.textContent = "Copied";
    } catch {
      bibtexCopy.textContent = "Copy failed";
    }
    setTimeout(() => { bibtexCopy.textContent = label; }, 1600);
  });

})();
