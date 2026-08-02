// One-time microphone grant page. The side panel can't show the mic prompt
// itself (Chrome auto-dismisses getUserMedia there), so the panel opens this
// page in a tab; the grant then sticks for the whole extension origin. The
// stream is stopped immediately — nothing is recorded.
const status = document.getElementById("status");
const retry = document.getElementById("retry");

async function ask() {
  retry.hidden = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const t of stream.getTracks()) t.stop();
    status.className = "status ok";
    status.innerHTML =
      "<b>Microphone enabled.</b> Back in the Dumpster panel, click the mic button to start dictating. This tab will close itself.";
    setTimeout(() => window.close(), 2200);
  } catch {
    status.innerHTML =
      "Microphone access was <b>blocked</b>. Click the mic icon in the address bar (or Ask again), choose Allow, then return to the Dumpster panel.";
    retry.hidden = false;
  }
}

retry.addEventListener("click", ask);
ask();
