import { initBioPipe3D, type Pipe3DController, type PipeCameraPreset } from "./pipe3d";

interface GroundingSource {
  title: string;
  uri: string;
}

interface ResearchSearchResponse {
  query: string;
  answer: string;
  sources: GroundingSource[];
  webSearchQueries?: string[];
  grounded?: boolean;
  modelUsed?: string;
  error?: string;
}

function initPipeViewSwitcher() {
  const switchBtns = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-pipe-view]"));
  const view2d = document.getElementById("pipe-compare-view");
  const view3d = document.getElementById("pipe-3d-view");
  const canvas = document.getElementById("pipe-3d-canvas") as HTMLCanvasElement | null;
  const cutawaySlider = document.getElementById("pipe-3d-cutaway") as HTMLInputElement | null;
  const cutawayValue = document.getElementById("pipe-3d-cutaway-val");
  const presetBtns = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-pipe-preset]"));
  const flowBtn = document.getElementById("pipe-3d-flow-btn") as HTMLButtonElement | null;
  const dock = document.getElementById("pipe-3d-dock");
  const dockToggle = document.getElementById("pipe-3d-dock-toggle") as HTMLButtonElement | null;

  if (!switchBtns.length || !view2d || !view3d || !canvas) return;

  let controller: Pipe3DController | null = null;
  let flowActive = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function ensure3D() {
    if (!controller && canvas) {
      try {
        controller = initBioPipe3D(canvas);
        if (cutawaySlider) {
          controller.setCutawayAmount(Number(cutawaySlider.value));
        }
        controller.setWaterFlow(flowActive);
        requestAnimationFrame(() => controller?.resize());
      } catch (err) {
        console.error("Failed to initialize 3D Bioplastic Pipe view:", err);
      }
    } else if (controller) {
      requestAnimationFrame(() => controller?.resize());
    }
  }

  function setMode(mode: "2d" | "3d") {
    switchBtns.forEach((btn) => {
      const active = btn.dataset.pipeView === mode;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
      btn.setAttribute("tabindex", active ? "0" : "-1");
    });

    if (mode === "3d") {
      view2d!.hidden = true;
      view3d!.hidden = false;
      ensure3D();
    } else {
      view3d!.hidden = true;
      view2d!.hidden = false;
    }
  }

  switchBtns.forEach((btn, idx) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.pipeView === "3d" ? "3d" : "2d";
      setMode(mode);
    });
    btn.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const nextBtn = switchBtns[(idx + 1) % switchBtns.length];
        const nextMode = nextBtn.dataset.pipeView === "3d" ? "3d" : "2d";
        setMode(nextMode);
        nextBtn.focus();
      }
    });
  });

  // Resize if user switches studio tab back to tab-pipes while 3D is selected
  document.querySelectorAll<HTMLButtonElement>('[data-tab="tab-pipes"]').forEach((tabBtn) => {
    tabBtn.addEventListener("click", () => {
      if (!view3d.hidden && controller) {
        requestAnimationFrame(() => controller?.resize());
      }
    });
  });

  if (cutawaySlider) {
    cutawaySlider.addEventListener("input", () => {
      const pct = Number(cutawaySlider.value);
      if (cutawayValue) cutawayValue.textContent = `${pct}% Open`;
      controller?.setCutawayAmount(pct);
    });
  }

  presetBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const preset = (btn.dataset.pipePreset || "iso") as PipeCameraPreset;
      presetBtns.forEach((b) => b.classList.toggle("is-active", b === btn));
      controller?.setPreset(preset);
    });
  });

  if (flowBtn) {
    const syncFlowBtn = () => {
      flowBtn.textContent = flowActive ? "Water Flow: On" : "Water Flow: Off";
      flowBtn.classList.toggle("is-active", flowActive);
      flowBtn.setAttribute("aria-pressed", flowActive ? "true" : "false");
    };
    syncFlowBtn();
    flowBtn.addEventListener("click", () => {
      flowActive = !flowActive;
      syncFlowBtn();
      controller?.setWaterFlow(flowActive);
    });
  }

  if (dock && dockToggle) {
    dockToggle.addEventListener("click", () => {
      const collapsed = dock.classList.toggle("is-collapsed");
      dockToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
      dockToggle.textContent = collapsed ? "Controls" : "Hide";
    });
  }

  window.addEventListener("beforeunload", () => {
    controller?.dispose();
    controller = null;
  });
}

function sanitizeHttpUrl(rawUri: unknown): string | null {
  if (typeof rawUri !== "string") return null;
  try {
    const parsed = new URL(rawUri, window.location.origin);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}

function sanitizeSingleLine(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").trim();
}

function renderFormattedAnswer(container: HTMLElement, text: string) {
  container.replaceChildren();
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let currentList: HTMLUListElement | null = null;

  for (const line of lines) {
    const cleaned = line.replace(/\*\*(.+?)\*\*/g, "$1");
    if (/^[-*•]\s+/.test(cleaned)) {
      if (!currentList) {
        currentList = document.createElement("ul");
        currentList.className = "grounding-bullets";
        container.appendChild(currentList);
      }
      const li = document.createElement("li");
      li.textContent = cleaned.replace(/^[-*•]\s+/, "");
      currentList.appendChild(li);
    } else {
      currentList = null;
      const p = document.createElement("p");
      p.textContent = cleaned;
      container.appendChild(p);
    }
  }
}

function initResearchGrounding() {
  const form = document.getElementById("research-grounding-form") as HTMLFormElement | null;
  const input = document.getElementById("research-query-input") as HTMLInputElement | null;
  const honeypot = document.getElementById("research-hp") as HTMLInputElement | null;
  const submitBtn = document.getElementById("research-search-btn") as HTMLButtonElement | null;
  const statusEl = document.getElementById("research-status");
  const answerEl = document.getElementById("research-answer");
  const sourcesEl = document.getElementById("research-sources");
  const presetChips = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-research-prompt]"));

  if (!form || !input || !submitBtn || !statusEl || !answerEl || !sourcesEl) return;

  let lastRequestAt = 0;

  async function runQuery(query: string) {
    // Reject automated bot fills on the hidden honeypot input
    if (honeypot && honeypot.value.trim().length > 0) {
      return;
    }

    const cleaned = sanitizeSingleLine(query).slice(0, 360);
    if (cleaned.length < 2) {
      statusEl!.textContent = "Please enter at least 2 characters before searching.";
      statusEl!.className = "grounding-status is-error";
      return;
    }

    const now = Date.now();
    if (now - lastRequestAt < 1500) {
      statusEl!.textContent = "Please wait a moment before sending another query.";
      statusEl!.className = "grounding-status is-error";
      return;
    }
    lastRequestAt = now;

    submitBtn!.disabled = true;
    submitBtn!.textContent = "Asking Gemini...";
    statusEl!.textContent = "Querying Gemini scientific research engine...";
    statusEl!.className = "grounding-status";
    answerEl!.replaceChildren();
    sourcesEl!.replaceChildren();

    try {
      const resp = await fetch("/api/research/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: cleaned,
          topic: "FloraCycle bioplastic pipes, floral bioplastic, and floral biochar",
          website: honeypot ? honeypot.value : ""
        })
      });

      const rawText = await resp.text();
      let data: ResearchSearchResponse;
      try {
        data = JSON.parse(rawText) as ResearchSearchResponse;
      } catch {
        throw new Error(
          resp.ok
            ? "Received an unexpected non-JSON response from the search server."
            : `Search endpoint returned HTTP ${resp.status}. Please try again shortly.`
        );
      }

      if (!resp.ok) {
        throw new Error(data.error || `Search request failed (${resp.status})`);
      }

      const displayQuery = typeof data.query === "string" ? sanitizeSingleLine(data.query) : cleaned;
      const displayAnswer = typeof data.answer === "string" ? data.answer : "";
      statusEl!.textContent = data.grounded
        ? `Grounded findings via Gemini + Web Search for: "${displayQuery}"`
        : `Gemini scientific response for: "${displayQuery}"`;
      renderFormattedAnswer(answerEl!, displayAnswer);

      if (Array.isArray(data.sources) && data.sources.length > 0) {
        const validSources = data.sources
          .map((src) => ({
            title: typeof src?.title === "string" ? sanitizeSingleLine(src.title) : "",
            uri: sanitizeHttpUrl(src?.uri)
          }))
          .filter((src): src is { title: string; uri: string } => Boolean(src.uri))
          .slice(0, 6);

        if (validSources.length > 0) {
          const heading = document.createElement("span");
          heading.className = "grounding-sources-label";
          heading.textContent = "Verified Web Sources:";
          sourcesEl!.appendChild(heading);

          validSources.forEach((src) => {
            const link = document.createElement("a");
            link.className = "grounding-source-chip";
            link.href = src.uri;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.textContent = src.title || src.uri;
            sourcesEl!.appendChild(link);
          });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unable to reach Gemini research service.";
      statusEl!.textContent = msg;
      statusEl!.className = "grounding-status is-error";
    } finally {
      submitBtn!.disabled = false;
      submitBtn!.textContent = "Ask Gemini";
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void runQuery(input.value);
  });

  presetChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      const q = chip.dataset.researchPrompt || "";
      input.value = q;
      void runQuery(q);
    });
  });
}

function bootstrapStudioModules() {
  try {
    initPipeViewSwitcher();
  } catch (err) {
    console.error("Failed to initialize pipe view switcher:", err);
  }
  try {
    initResearchGrounding();
  } catch (err) {
    console.error("Failed to initialize research grounding module:", err);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrapStudioModules);
} else {
  bootstrapStudioModules();
}
