const $ = (selector) => document.querySelector(selector);
const form = $("#eventForm");
const posterInput = $("#posterInput");
const audioInput = $("#audioInput");
const resultContent = $("#resultContent");
const emptyState = $("#emptyState");
const loadingState = $("#loadingState");
const analyzeButton = $("#analyzeButton");
const languageSelect = $("#language");
let currentResult = null;
const previewUrls = new Map();

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]));

function showFile(input, selected, drop) {
  const oldUrl = previewUrls.get(input.id);
  if (oldUrl) URL.revokeObjectURL(oldUrl);
  previewUrls.delete(input.id);
  const file = input.files?.[0];
  const zone = drop.querySelector(".drop-zone");
  const selectedLine = drop.querySelector(".file-selected");
  if (!file) {
    zone.hidden = false;
    selectedLine.hidden = true;
    if (input.id === "posterInput") { $("#posterThumb").hidden = true; $("#posterTypeBadge").hidden = true; }
    if (input.id === "audioInput") { $("#audioPreview").hidden = true; $("#audioPreview").removeAttribute("src"); }
    return;
  }
  zone.hidden = true;
  selectedLine.hidden = false;
  selectedLine.querySelector(".file-name").textContent = `${file.name} · ${formatBytes(file.size)}`;
  const previewUrl = URL.createObjectURL(file);
  previewUrls.set(input.id, previewUrl);
  if (input.id === "posterInput") {
    const image = $("#posterThumb");
    const badge = $("#posterTypeBadge");
    if (file.type.startsWith("image/")) {
      image.src = previewUrl; image.hidden = false; badge.hidden = true;
    } else {
      image.hidden = true; badge.hidden = false;
    }
  }
  if (input.id === "audioInput") {
    const audio = $("#audioPreview"); audio.src = previewUrl; audio.hidden = false;
    $("#recordStatus").textContent = "Preview the clip before checking it";
  }
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function connectFileInput(input, selected, drop) {
  input.addEventListener("change", () => showFile(input, selected, drop));
  drop.querySelector(".remove-file").addEventListener("click", () => {
    input.value = "";
    showFile(input, selected, drop);
  });
  const zone = drop.querySelector(".drop-zone");
  ["dragenter", "dragover"].forEach((eventName) => zone.addEventListener(eventName, (event) => {
    event.preventDefault(); drop.classList.add("dragging");
  }));
  ["dragleave", "drop"].forEach((eventName) => zone.addEventListener(eventName, (event) => {
    event.preventDefault(); drop.classList.remove("dragging");
  }));
  zone.addEventListener("drop", (event) => {
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    const transfer = new DataTransfer(); transfer.items.add(file); input.files = transfer.files;
    showFile(input, selected, drop);
  });
}

connectFileInput(posterInput, $("#posterSelected"), $("#posterDrop"));
connectFileInput(audioInput, $("#audioSelected"), $("#audioDrop"));

const recordButton = $("#recordButton");
const recordStatus = $("#recordStatus");
let mediaRecorder = null;
let recordingStream = null;
let recordingChunks = [];
let recordingClock = null;
let recordingSeconds = 0;

recordButton.addEventListener("click", async () => {
  if (mediaRecorder?.state === "recording") {
    mediaRecorder.stop();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    recordStatus.textContent = "Recording isn’t supported here. Upload an audio clip instead.";
    return;
  }
  try {
    recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordingChunks = [];
    mediaRecorder = new MediaRecorder(recordingStream);
    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data?.size) recordingChunks.push(event.data);
    });
    mediaRecorder.addEventListener("stop", () => {
      const type = mediaRecorder.mimeType || "audio/webm";
      const extension = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
      const audioBlob = new Blob(recordingChunks, { type });
      if (!audioBlob.size) {
        recordingStream?.getTracks().forEach((track) => track.stop());
        recordingStream = null;
        clearInterval(recordingClock); recordingClock = null;
        recordButton.classList.remove("recording"); recordButton.setAttribute("aria-pressed", "false");
        recordStatus.classList.remove("record-status-live");
        recordStatus.textContent = "No audio was captured. Try again or upload an audio clip.";
        return;
      }
      const audioFile = new File([audioBlob], `announcement.${extension}`, { type });
      const transfer = new DataTransfer(); transfer.items.add(audioFile); audioInput.files = transfer.files;
      showFile(audioInput, $("#audioSelected"), $("#audioDrop"));
      recordingStream?.getTracks().forEach((track) => track.stop());
      recordingStream = null;
      clearInterval(recordingClock); recordingClock = null;
      recordButton.classList.remove("recording"); recordButton.setAttribute("aria-pressed", "false");
      recordButton.querySelector("span:last-child").textContent = "Record again";
      recordStatus.classList.remove("record-status-live"); recordStatus.textContent = "Recording ready · up to 30 seconds";
    });
    mediaRecorder.start();
    recordingSeconds = 0;
    recordButton.classList.add("recording"); recordButton.setAttribute("aria-pressed", "true");
    recordButton.querySelector("span:last-child").textContent = "Stop recording · 30s";
    recordStatus.classList.add("record-status-live"); recordStatus.textContent = "Recording… tap stop when finished";
    recordingClock = window.setInterval(() => {
      recordingSeconds += 1;
      const remaining = 30 - recordingSeconds;
      recordButton.querySelector("span:last-child").textContent = `Stop recording · ${remaining}s`;
      if (remaining <= 0 && mediaRecorder?.state === "recording") mediaRecorder.stop();
    }, 1000);
  } catch {
    recordingStream?.getTracks().forEach((track) => track.stop());
    recordingStream = null;
    recordStatus.textContent = "Microphone access wasn’t available. You can upload an audio clip instead.";
  }
});

function setLoadingStep(step) {
  const labels = {
    poster: ["Reading your event poster…", "Looking for the title, time, venue and instructions.", "24%"],
    audio: ["Listening to the announcement…", "Turning the spoken details into a transcript.", "58%"],
    compare: ["Checking the details…", "Comparing both sources and flagging anything that needs confirmation.", "86%"],
  };
  const [title, text, progress] = labels[step];
  $("#loadingTitle").textContent = title;
  $("#loadingText").textContent = text;
  $("#loadingProgress").style.width = progress;
  const order = ["poster", "audio", "compare"];
  document.querySelectorAll(".loading-step").forEach((el) => {
    const currentIndex = order.indexOf(el.dataset.step);
    const activeIndex = order.indexOf(step);
    el.classList.toggle("active", currentIndex === activeIndex);
    el.classList.toggle("done", currentIndex < activeIndex);
  });
}

function setBusy(isBusy) {
  analyzeButton.disabled = isBusy;
  analyzeButton.querySelector("span:nth-child(2)").textContent = isBusy ? "Checking both sources…" : "Check my event";
  if (isBusy) emptyState.hidden = true;
  loadingState.hidden = !isBusy;
  if (isBusy) resultContent.hidden = true;
}

function getFields(review) {
  if (Array.isArray(review?.fields)) return review.fields;
  return [];
}

function statusLabel(status) {
  return ({
    match: "Confirmed",
    conflict: "Mismatch",
    poster_only: "Poster only",
    announcement_only: "Audio only",
    unclear: "Check this",
  })[status] || "Check this";
}

function renderResult(data, sample = false) {
  currentResult = data;
  const review = data.review || {};
  const fields = getFields(review);
  const concern = Boolean(review.needs_confirmation) || fields.some((field) => field.status !== "match");
  const title = review.event_title || "Campus event";
  const tableRows = fields.length ? fields.map((field) => {
    const status = ["match", "conflict", "poster_only", "announcement_only", "unclear"].includes(field.status) ? field.status : "unclear";
    return `<div class="detail-row"><span class="detail-label">${escapeHtml(field.label || "Detail")}</span><span class="detail-value">${escapeHtml(field.poster_value || "—")}</span><span class="detail-value">${escapeHtml(field.announcement_value || "—")}</span><span class="status-pill status-${status}">${escapeHtml(statusLabel(status))}</span></div>${field.note ? `<div class="evidence-row"><span class="evidence-tag">EVIDENCE</span><span>${escapeHtml(field.note)}</span></div>` : ""}`;
  }).join("") : `<div class="detail-row"><span class="detail-label">Review</span><span class="detail-value" style="grid-column:span 3">${escapeHtml(review.raw_review || review.summary || "Please confirm the event details with the organiser.")}</span></div>`;

  const textBox = data.transcript ? `<details class="source-box"><summary>What Saaras heard <span>OPEN</span></summary><p class="transcript-text">${escapeHtml(data.transcript)}</p></details>` : "";
  const calendar = review.calendar || {};
  const calendarControls = `<div class="calendar-panel" id="calendarPanel" hidden>
      <div class="calendar-grid">
        <label class="title-field">EVENT TITLE<input id="calendarTitle" value="${escapeHtml(title)}" maxlength="100" /></label>
        <label>DATE<input id="calendarDate" type="date" value="${escapeHtml(validDate(calendar.date))}" /></label>
        <label>START<input id="calendarStart" type="time" value="${escapeHtml(validTime(calendar.start_time))}" /></label>
        <label>END (OPTIONAL)<input id="calendarEnd" type="time" value="${escapeHtml(validTime(calendar.end_time))}" /></label>
        <label class="title-field">VENUE<input id="calendarVenue" value="${escapeHtml(calendar.venue || matchedVenue(fields))}" maxlength="120" /></label>
      </div>
      ${concern ? `<label class="confirm-organizer"><input id="organizerConfirmed" type="checkbox" /> I confirmed the flagged detail with the organiser and entered the correct value.</label>` : ""}
      <p id="calendarError" class="calendar-error" hidden></p>
      <button class="action-button primary-small" id="downloadCalendar" type="button">↓ Download calendar invite</button>
      <p class="calendar-help">This creates a local .ics file. Review the date and time before adding it to your calendar.</p>
    </div>`;
  resultContent.innerHTML = `
    ${sample ? `<div class="sample-label" style="display:inline-block;margin-bottom:8px">SAMPLE PREVIEW · NO API CALL</div>` : ""}
    <div class="result-banner ${concern ? "needs-confirmation" : ""}"><span class="banner-icon">${concern ? "!" : "✓"}</span><div class="banner-copy"><strong>${concern ? "One detail needs a second look" : "The sources line up"}</strong><p>${escapeHtml(review.summary || (concern ? "Check the highlighted mismatch with the event organiser." : "Poster and announcement agree on the event details."))}</p></div></div>
    <div class="result-title-row"><div><span class="result-kicker">YOUR EVENT CARD</span><h3>${escapeHtml(title)}</h3></div>${sample ? "" : `<span class="sample-label">${escapeHtml(languageName(data.language || "en-IN"))}</span>`}</div>
    <div class="detail-list"><div class="detail-row detail-head"><span>DETAIL</span><span>POSTER</span><span>ANNOUNCEMENT</span><span>CHECK</span></div>${tableRows}</div>
    ${textBox}
    <div class="result-actions"><div class="action-row"><button class="action-button" id="copyCardButton" type="button">▣ Copy event card</button><button class="action-button" id="organizerQuestionButton" type="button" ${concern ? "" : "hidden"}>? Copy organiser question</button></div><div class="action-row"><button class="action-button" id="translateButton" type="button">↻ Translate card</button><button class="action-button" id="speakButton" type="button">♫ Listen</button>${data.translated_text ? `<button class="action-button primary-small" id="playTranslatedButton" type="button">▶ Play translated</button>` : ""}<button class="action-button" id="calendarToggle" type="button">＋ Add to calendar</button></div></div>
    <div id="translatedCard" class="translated-card" ${data.translated_text ? "" : "hidden"}>${data.translated_text ? escapeHtml(data.translated_text) : ""}</div>
    ${calendarControls}
    <audio id="spokenAudio" controls hidden></audio>`;
  emptyState.hidden = true;
  loadingState.hidden = true;
  resultContent.hidden = false;
  $("#translateButton").addEventListener("click", translateCard);
  $("#speakButton").addEventListener("click", () => speakText(data.card_text || buildCardText(review), "en-IN"));
  $("#copyCardButton").addEventListener("click", copyEventCard);
  $("#organizerQuestionButton").addEventListener("click", copyOrganizerQuestion);
  $("#calendarToggle").addEventListener("click", () => {
    const panel = $("#calendarPanel");
    panel.hidden = !panel.hidden;
    if (!panel.hidden) panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  $("#downloadCalendar").addEventListener("click", downloadCalendarInvite);
  const playTranslatedButton = $("#playTranslatedButton");
  if (playTranslatedButton) playTranslatedButton.addEventListener("click", () => speakText(data.translated_text, data.language || "hi-IN"));
}

function validDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? value : ""; }
function validTime(value) { return /^\d{2}:\d{2}$/.test(String(value || "")) ? value : ""; }
function matchedVenue(fields) {
  const venue = fields.find((field) => String(field.label || "").toLowerCase() === "venue" && field.status === "match");
  return venue?.poster_value || "";
}

async function copyText(text, button, successLabel) {
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = `✓ ${successLabel}`;
  } catch {
    button.textContent = "Clipboard unavailable";
  }
}

function copyEventCard() {
  const button = $("#copyCardButton");
  const text = currentResult?.translated_text || currentResult?.card_text || buildCardText(currentResult?.review || {});
  copyText(text, button, "Copied");
}

function copyOrganizerQuestion() {
  const review = currentResult?.review || {};
  const conflicts = getFields(review).filter((field) => field.status !== "match");
  const details = conflicts.map((field) => `${field.label}: poster says “${field.poster_value || "not shown"}”; announcement says “${field.announcement_value || "not mentioned"}”.`).join("\n");
  const question = `Hi, could you confirm the event details for ${review.event_title || "this event"}?\n${details || review.summary || "One or more details need confirmation."}\nThank you!`;
  copyText(question, $("#organizerQuestionButton"), "Question copied");
}

function downloadCalendarInvite() {
  const date = $("#calendarDate").value;
  const startTime = $("#calendarStart").value;
  const endTime = $("#calendarEnd").value;
  const error = $("#calendarError");
  error.hidden = true;
  if (!date || !startTime) {
    error.textContent = "Add the confirmed event date and start time first.";
    error.hidden = false;
    return;
  }
  const review = currentResult?.review || {};
  const needsHumanCheck = Boolean(review.needs_confirmation) || getFields(review).some((field) => field.status !== "match");
  if (needsHumanCheck && !$("#organizerConfirmed")?.checked) {
    error.textContent = "Confirm the flagged details with the organiser before creating an invite.";
    error.hidden = false;
    return;
  }
  const start = new Date(`${date}T${startTime}`);
  const end = endTime ? new Date(`${date}T${endTime}`) : new Date(start.getTime() + 60 * 60 * 1000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start.toLocaleDateString("en-CA") !== date || end <= start) {
    error.textContent = "Check the start and end times. The end must be after the start.";
    error.hidden = false;
    return;
  }
  const utcStamp = (value) => value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const escapeIcs = (value) => String(value || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
  const uid = `${crypto.randomUUID()}@noticesahi.local`;
  const content = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//NoticeSahi//Campus event//EN", "CALSCALE:GREGORIAN", "BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:${utcStamp(new Date())}`, `DTSTART:${utcStamp(start)}`, `DTEND:${utcStamp(end)}`, `SUMMARY:${escapeIcs($("#calendarTitle").value)}`, `LOCATION:${escapeIcs($("#calendarVenue").value)}`, `DESCRIPTION:${escapeIcs(currentResult?.review?.summary || "Event details checked with NoticeSahi.")}`, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const url = URL.createObjectURL(new Blob([content], { type: "text/calendar;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = "noticesahi-event.ics"; link.click();
  URL.revokeObjectURL(url);
  $("#downloadCalendar").textContent = "✓ Calendar invite downloaded";
}

function languageName(code) {
  const options = [...languageSelect.options];
  return options.find((option) => option.value === code)?.textContent || "English";
}

function buildCardText(review) {
  const lines = [review.event_title || "Campus event"];
  getFields(review).forEach((field) => {
    if (field.status === "match") lines.push(`${field.label}: ${field.poster_value}`);
    else if (field.poster_value || field.announcement_value) lines.push(`${field.label}: Please confirm. Poster says ${field.poster_value || "not shown"}; announcement says ${field.announcement_value || "not mentioned"}.`);
  });
  lines.push(review.summary || "Please confirm any flagged details with the organiser.");
  return lines.join("\n");
}

function showError(message) {
  currentResult = null;
  loadingState.hidden = true;
  emptyState.hidden = true;
  resultContent.hidden = false;
  resultContent.innerHTML = `<div class="error-message"><b>We couldn’t finish this check.</b><br />${escapeHtml(message)}</div><button class="action-button" id="resetError" type="button" style="margin-top:10px">Try again</button>`;
  $("#resetError").addEventListener("click", () => { resultContent.hidden = true; emptyState.hidden = false; });
}

function fileToFormData() {
  const data = new FormData();
  data.append("poster", posterInput.files[0]);
  data.append("audio", audioInput.files[0]);
  data.append("language", languageSelect.value);
  return data;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!posterInput.files[0] || !audioInput.files[0]) {
    showError("Please add both a poster and a short spoken announcement.");
    return;
  }
  if (posterInput.files[0].size + audioInput.files[0].size > 4 * 1024 * 1024) {
    showError("Keep the poster and audio together under 4 MB for this deployment.");
    return;
  }
  if (audioInput.files[0].size > 3 * 1024 * 1024) {
    showError("Keep the audio clip under 3 MB and the combined upload under 4 MB.");
    return;
  }
  if (audioInput.files[0].type.startsWith("video/") && audioInput.files[0].type !== "video/webm") {
    showError("Please upload an audio file or a WebM recording.");
    return;
  }
  setBusy(true);
  setLoadingStep("poster");
  const audioStep = window.setTimeout(() => setLoadingStep("audio"), 4500);
  const compareStep = window.setTimeout(() => setLoadingStep("compare"), 9000);
  try {
    const response = await fetch("/api/analyze", { method: "POST", body: fileToFormData() });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Please try again.");
    renderResult(payload);
  } catch (error) {
    showError(error.message || "Check your connection and try again.");
  } finally {
    clearTimeout(audioStep); clearTimeout(compareStep);
    setBusy(false);
  }
});

async function translateCard() {
  if (!currentResult) return;
  const target = languageSelect.value;
  const button = $("#translateButton");
  const card = $("#translatedCard");
  if (target === "en-IN") {
    card.hidden = false;
    card.textContent = currentResult.card_text || buildCardText(currentResult.review || {});
    button.textContent = "✓ English card shown";
    return;
  }
  button.disabled = true; button.textContent = "Translating…";
  try {
    const response = await fetch("/api/translate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: currentResult.card_text || buildCardText(currentResult.review || {}), language: target }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Translation failed.");
    currentResult.translated_text = payload.translated_text;
    currentResult.language = target;
    card.textContent = payload.translated_text; card.hidden = false;
    button.textContent = "✓ Translated";
    renderResult(currentResult);
  } catch (error) {
    button.textContent = "↻ Translate card";
    showInlineError(error.message);
  } finally {
    button.disabled = false;
  }
}

function showInlineError(message) {
  const card = $("#translatedCard");
  card.hidden = false; card.textContent = message; card.classList.add("inline-error");
}

async function speakText(text, language) {
  if (!text) return;
  const button = $("#speakButton");
  if (button) { button.disabled = true; button.textContent = "Preparing audio…"; }
  try {
    const response = await fetch("/api/speak", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, language }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Audio could not be created.");
    const audio = $("#spokenAudio");
    audio.src = `data:${payload.mime_type};base64,${payload.audio_base64}`;
    audio.hidden = false; await audio.play();
    if (button) button.textContent = "♫ Listen";
  } catch (error) {
    showInlineError(error.message);
  } finally {
    if (button) button.disabled = false;
  }
}

$("#sampleButton").addEventListener("click", () => {
  const sample = {
    language: "en-IN",
    transcript: "The Design Showcase starts at 5 PM on Friday, 20 November 2026 at Innovation Hall. Bring your college ID.",
    card_text: "Design Showcase\nDate: Friday, 20 November 2026\nTime: Please confirm. Poster says 4:00 PM; announcement says 5:00 PM.\nVenue: Innovation Hall\nBring: College ID\nOne detail needs confirmation before you go.",
    review: {
      event_title: "Design Showcase",
      summary: "The time differs between the poster and the spoken announcement. Confirm the start time with the organiser.",
      needs_confirmation: true,
      calendar: { date: "2026-11-20", start_time: null, end_time: null, venue: "Innovation Hall" },
      fields: [
        { label: "Date", poster_value: "Friday, 20 November 2026", announcement_value: "Friday, 20 November 2026", status: "match", note: "The poster and announcement show the same date." },
        { label: "Time", poster_value: "4:00 PM", announcement_value: "5:00 PM", status: "conflict", note: "Poster: 4:00 PM · Announcement: 5:00 PM" },
        { label: "Venue", poster_value: "Innovation Hall", announcement_value: "Innovation Hall", status: "match", note: "Both sources say Innovation Hall." },
        { label: "Bring", poster_value: "College ID", announcement_value: "College ID", status: "match", note: "Both sources mention a college ID." },
      ],
    },
  };
  renderResult(sample, true);
  $("#resultPanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
});

$("#aboutButton").addEventListener("click", () => $("#aboutDialog").showModal());
$("#closeAbout").addEventListener("click", () => $("#aboutDialog").close());
$("#aboutDialog").addEventListener("click", (event) => {
  if (event.target === $("#aboutDialog")) $("#aboutDialog").close();
});
