// Print/PDF export page. Renders a Doc bucket's markdown body with screenshots
// resolved from IndexedDB (their permanent home — Drive only ever stages a
// temporary copy during Google Docs sync), then opens the print dialog where
// "Save as PDF" produces the file. Everything is local; works offline.

import { getBuckets } from "./src/buckets.js";
import { getImage } from "./src/db.js";
import { renderMarkdown } from "./src/markdown.js";
import { getBody, seedIfEmpty } from "./src/docBody.js";

const els = {
  title: document.getElementById("doc-title"),
  sub: document.getElementById("doc-sub"),
  doc: document.getElementById("doc"),
  printBtn: document.getElementById("print-btn"),
};

async function init() {
  const bucketId = new URLSearchParams(location.search).get("bucket");
  const bucket = (await getBuckets()).find((b) => b.id === bucketId && b.kind === "doc");
  if (!bucket) {
    els.title.textContent = "Doc not found";
    els.sub.textContent = "This export link points at a bucket that no longer exists.";
    return;
  }

  document.title = `${bucket.name} — Dumpster export`;
  els.title.textContent = bucket.name;
  els.sub.textContent = `Exported from Dumpster · ${new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  })}`;

  await seedIfEmpty(bucketId);
  const md = await getBody(bucketId);

  // Resolve each local screenshot to a blob URL for rendering.
  const urls = new Map();
  const ids = [...md.matchAll(/dumpster:img:([\w-]+)/g)].map((m) => m[1]);
  for (const id of new Set(ids)) {
    const blob = await getImage(id);
    if (blob instanceof Blob) urls.set(id, URL.createObjectURL(blob));
  }
  els.doc.innerHTML = renderMarkdown(md, { imageUrl: (id) => urls.get(id) });

  els.printBtn.addEventListener("click", () => window.print());

  // Give images a beat to decode, then open the dialog automatically. Cap the
  // wait so a broken image can never hang the export.
  const imagesReady = Promise.all(
    [...document.images].map((img) =>
      img.complete ? null : new Promise((r) => ((img.onload = r), (img.onerror = r)))
    )
  );
  await Promise.race([imagesReady, new Promise((r) => setTimeout(r, 1500))]);
  setTimeout(() => window.print(), 150); // the panel already counts this export
}

init();
