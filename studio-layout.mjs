import { $, $$ } from "./ui.mjs";

const panelSettingsKey = "littlea-character-panel-layout";
const panels = {
  assets: { selector: ".asset-rail", heading: ".asset-heading", label: "Workspace assets", side: "left" },
  navigator: { selector: ".sidebar", heading: ".panel-heading", label: "Scene navigator", side: "left" },
  inspector: { selector: ".inspector", heading: ".inspector-dock", label: "Inspector", side: "right" },
  timeline: { selector: ".timeline", heading: ".transport", label: "Timeline", side: "bottom" },
};

function setPanelCollapsed(id, collapsed, persist = true) {
  const panel = $(panels[id].selector);
  const button = $(`[data-panel-toggle="${id}"]`);
  panel.classList.toggle("is-collapsed", collapsed);
  $(".workspace").setAttribute(`data-collapsed-${id}`, String(collapsed));
  button.setAttribute("aria-expanded", String(!collapsed));
  button.setAttribute("aria-label", `${collapsed ? "Expand" : "Collapse"} ${panels[id].label.toLowerCase()}`);
  button.title = button.getAttribute("aria-label");
  setButtonIcon(button, `panel-${panels[id].side}-${collapsed ? "open" : "close"}`);
  if (persist) {
    try {
      localStorage.setItem(panelSettingsKey, JSON.stringify(Object.fromEntries(Object.entries(panels)
        .map(([key, value]) => [key, $(value.selector).classList.contains("is-collapsed")]))));
    } catch {}
  }
}

function initializePanelControls() {
  const dock = document.createElement("div");
  dock.className = "inspector-dock";
  const tabs = $(".inspector-tabs");
  tabs.before(dock);
  dock.append(tabs);
  for (const [id, settings] of Object.entries(panels)) {
    const panel = $(settings.selector);
    panel.id ||= `studio-${id}-panel`;
    panel.dataset.panelTitle = settings.label;
    const heading = $(settings.heading, panel);
    if (id === "assets" || id === "navigator") {
      const title = document.createElement("span");
      title.className = "panel-title";
      title.textContent = id === "navigator" ? "Scene & Rig Navigator" : settings.label;
      heading.replaceChildren(title);
    }
    if (id === "inspector") {
      const title = document.createElement("span");
      title.className = "collapsed-panel-title";
      title.textContent = settings.label;
      heading.prepend(title);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "panel-toggle";
    button.dataset.panelToggle = id;
    button.setAttribute("aria-controls", panel.id);
    heading.append(button);
    setPanelCollapsed(id, false, false);
    button.addEventListener("click", () => setPanelCollapsed(id, !panel.classList.contains("is-collapsed")));
  }
}

function icon(name) {
  const element = document.createElement("span");
  element.dataset.studioIcon = name;
  element.setAttribute("aria-hidden", "true");
  element.style.setProperty("--studio-icon", `url("${new URL(`./assets/icons/${name}.svg`, import.meta.url).href}")`);
  return element;
}

export function setButtonIcon(button, name) {
  button.replaceChildren(icon(name));
}

export async function toggleStageFullscreen() {
  const stage = $(".canvas-wrap");
  if (document.fullscreenElement === stage) await document.exitFullscreen();
  else if (stage.requestFullscreen) await stage.requestFullscreen();
  else throw new Error("Stage fullscreen is not supported in this browser.");
}

export function showInspector(view, focus = false) {
  const tab = $(`[data-inspector-view="${view}"]`);
  if (!tab) return;
  if ($(".inspector").classList.contains("is-collapsed")) setPanelCollapsed("inspector", false);
  $$('[data-inspector-view]').forEach(button => {
    const selected = button === tab;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  $$('[data-inspector-content]').forEach(element => {
    element.hidden = !element.dataset.inspectorContent.split(" ").includes(view);
  });
  $("#inspector-content").setAttribute("aria-labelledby", tab.id);
  if (focus) {
    tab.focus();
    tab.scrollIntoView({ block: "nearest" });
  }
}

export function updateStudioSummary(project) {
  $("#asset-character-count").textContent = project.characters.length;
  $("#asset-scene-count").textContent = project.scenes.length;
  $("#asset-audio-count").textContent = project.scenes.filter(scene => scene.audio).length;
  $("#asset-artwork-count").textContent = [...project.characters, ...project.scenes].reduce((count, owner) =>
    count + Object.values(owner.artwork ?? {}).reduce((total, parts) => total + parts.length, 0), 0);
}

export function initializeStudioLayout() {
  let savedPanels;
  try { savedPanels = JSON.parse(localStorage.getItem(panelSettingsKey)); } catch {}
  $$('[data-studio-icon]').forEach(element => element.replaceWith(icon(element.dataset.studioIcon)));
  initializePanelControls();
  const updateFullscreenControl = () => {
    const active = document.fullscreenElement === $(".canvas-wrap");
    const button = $('[data-action="fit"]');
    const label = active ? "Exit stage fullscreen" : "Enter stage fullscreen";
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", String(active));
    button.title = label;
    setButtonIcon(button, active ? "minimize" : "maximize");
  };
  document.addEventListener("fullscreenchange", updateFullscreenControl);
  for (const [selector, name] of [
    ['[data-action="rewind"]', "skip-back"], ['#play-button', "play"],
    ['[data-action="grid"]', "grid-2x2"], ['[data-action="fit"]', "maximize"],
    ['[data-action="reset-pose"]', "rotate-ccw"], ['[data-action="delete-cue"]', "trash-2"],
  ]) {
    const button = $(selector);
    const label = button.getAttribute("aria-label") || button.textContent.trim();
    button.setAttribute("aria-label", label);
    button.title = label;
    setButtonIcon(button, name);
  }
  for (const [selector, name] of [
    ['[data-action="import-project"]', "folder-open"], ['[data-action="import-audio"]', "file-audio"],
    ['[data-action="preview"]', "play"], ['[data-modal-open="#export-modal"]', "download"],
    ['[data-action="align"]', "sparkles"], ['[data-action="regenerate"]', "sparkles"],
  ]) $(selector).prepend(icon(name));

  $$('[data-inspector-view]').forEach(button => {
    button.addEventListener("click", () => showInspector(button.dataset.inspectorView));
    button.addEventListener("keydown", event => {
      const tabs = $$('[data-inspector-view]');
      let index = tabs.indexOf(button);
      if (event.key === "ArrowRight") index = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") index = (index + tabs.length - 1) % tabs.length;
      else if (event.key === "Home") index = 0;
      else if (event.key === "End") index = tabs.length - 1;
      else return;
      event.preventDefault();
      showInspector(tabs[index].dataset.inspectorView, true);
    });
  });
  function navigate(destination) {
    $$('[data-navigate]').forEach(button => {
      if (button.dataset.navigate === destination) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    });
    if (destination === "audio") { showInspector("scene", true); return; }
    setPanelCollapsed("navigator", false);
    const section = $(`#${destination}-section`);
    section.scrollIntoView({ block: "nearest" });
    $("button", section)?.focus({ preventScroll: true });
  }
  $$('[data-navigate]').forEach(button => button.addEventListener("click", () => navigate(button.dataset.navigate)));
  $$('[data-workspace-view]').forEach(button => button.addEventListener("click", () => {
    $$('[data-workspace-view]').forEach(item => {
      if (item === button) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    });
    const view = button.dataset.workspaceView;
    if (view === "audio") navigate("audio");
    else if (view === "library") { showInspector("scene"); navigate("scenes"); }
    else {
      showInspector("lip", view === "rigging");
      if (view === "studio") $(".canvas-wrap").scrollIntoView({ block: "nearest" });
    }
  }));
  showInspector("lip");
  for (const id of Object.keys(panels)) setPanelCollapsed(id, savedPanels?.[id] === true, false);
  updateFullscreenControl();
}