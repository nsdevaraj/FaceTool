const paths = {
  "tool-select": "M5 3 L19 13 L12 14 L9 21 Z",
  "tool-navigate": "M8 12 V6 Q8 3 10 5 V11 M10 5 V3 Q12 1 13 3 V11 M13 5 Q15 3 16 5 V12 M16 8 Q19 6 19 9 V15 Q19 21 13 21 H11 Q8 21 6 17 L3 12 Q3 9 5 10 L8 13",
  "tool-eyedropper": "M14 4 L20 10 M12 6 L18 12 M14 8 L5 17 L4 21 L8 20 L17 11 M15 7 L18 4 Q21 2 22 5 L19 9",
  "tool-fill": "M5 8 L12 2 L20 10 L12 18 L4 10 Z M5 10 H19 M8 3 L13 8 M19 15 Q15 20 19 21 Q23 20 19 15",
  "tool-gradient": "M3 3 H21 V21 H3 Z M6 3 V21 M9 3 V21 M13 3 V21 M18 3 V21",
  "tool-pen": "M4 20 L7 11 L16 3 L21 8 L13 17 Z M7 11 L13 17 M4 20 L10 14",
  "tool-freehand": "M3 17 C20 0 22 3 12 13 S7 22 21 17",
  "tool-spline": "M3 18 C8 18 8 6 13 6 S17 18 21 6 M2 16 H5 V20 H2 Z M11 4 H15 V8 H11 Z M19 4 H22 V8 H19 Z",
  "tool-line": "M4 20 L20 4 M3 18 L6 21 M18 3 L21 6",
  "tool-ellipse": "M21 12 A9 7 0 1 0 3 12 A9 7 0 1 0 21 12",
  "tool-rect": "M3 5 H21 V19 H3 Z",
  "tool-polygon": "M12 3 L21 10 L17 21 H7 L3 10 Z",
  "tool-star": "M12 2 L15 9 L22 10 L17 15 L18 22 L12 18 L6 22 L7 15 L2 10 L9 9 Z",
  "tool-arrow": "M3 9 H14 V4 L22 12 L14 20 V15 H3 Z",
  "tool-spiral": "M12 12 C8 8 17 5 18 12 C19 20 4 22 3 12 C2 1 22 0 22 12",
  "tool-grid": "M3 3 H21 V21 H3 Z M9 3 V21 M15 3 V21 M3 9 H21 M3 15 H21",
  "tool-text": "M4 6 V3 H20 V6 M12 3 V21 M8 21 H16",
  fillNone: "M3 3 H21 V21 H3 Z M3 21 L21 3",
  strokeNone: "M4 12 H20 M4 20 L20 4",
  dup: "M8 8 H21 V21 H8 Z M16 5 V3 H3 V16 H5",
  del: "M3 6 H21 M9 6 V3 H15 V6 M5 6 L6 21 H18 L19 6 M10 10 V17 M14 10 V17",
  undo: "M8 4 L3 9 L8 14 M3 9 H14 C23 9 23 20 14 20",
  redo: "M16 4 L21 9 L16 14 M21 9 H10 C1 9 1 20 10 20",
  clear: "M3 6 H21 M5 6 L6 21 H18 L19 6 M9 3 H15 M9 10 L15 17 M15 10 L9 17",
  "align-left": "M3 3 V21 M7 5 H21 V10 H7 Z M7 14 H16 V19 H7 Z",
  "align-center": "M12 2 V22 M3 5 H21 V10 H3 Z M7 14 H17 V19 H7 Z",
  "align-right": "M21 3 V21 M3 5 H17 V10 H3 Z M8 14 H17 V19 H8 Z",
  "align-top": "M3 3 H21 M5 7 H10 V21 H5 Z M14 7 H19 V16 H14 Z",
  "align-middle": "M2 12 H22 M5 3 H10 V21 H5 Z M14 7 H19 V17 H14 Z",
  "align-bottom": "M3 21 H21 M5 3 H10 V17 H5 Z M14 8 H19 V17 H14 Z",
  "distribute-x": "M2 3 V21 M22 3 V21 M9 5 H15 V19 H9 Z M3 12 H8 M16 12 H21",
  "distribute-y": "M3 2 H21 M3 22 H21 M5 9 H19 V15 H5 Z M12 3 V8 M12 16 V21",
  importSvg: "M14 3 H4 V21 H20 V13 M12 12 L21 3 M15 3 H21 V9",
  raise: "M5 12 L12 5 L19 12 M12 5 V21 M4 2 H20",
  lower: "M5 12 L12 19 L19 12 M12 3 V19 M4 22 H20",
};

export function mountArtworkToolbar(host) {
  for (const button of host.querySelectorAll("button[title]")) {
    const role = button.dataset.ed.split(":")[1];
    if (!paths[role]) throw new Error(`Missing artwork icon: ${role}`);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", paths[role]);
    svg.append(path);
    button.type = "button";
    button.classList.add("artwork-icon-button");
    button.replaceChildren(svg);
  }
  const controller = new AbortController();
  const { signal } = controller;
  const tooltip = document.createElement("div");
  tooltip.className = "artwork-tooltip";
  tooltip.id = `${host.id}-tooltip`;
  tooltip.setAttribute("role", "tooltip");
  tooltip.hidden = true;
  document.body.append(tooltip);
  let active;
  const hide = () => {
    active?.removeAttribute("aria-describedby");
    active = null;
    tooltip.hidden = true;
  };
  for (const control of host.querySelectorAll("button[title], input:not([type=file]), select")) {
    const label = control.title || control.parentElement.title;
    if (!label) throw new Error(`Missing artwork tooltip: ${control.dataset.ed}`);
    control.setAttribute("aria-label", label);
    control.dataset.tooltip = label;
    control.removeAttribute("title");
    const show = () => {
      hide();
      active = control;
      tooltip.textContent = label;
      tooltip.hidden = false;
      control.setAttribute("aria-describedby", tooltip.id);
      const bounds = control.getBoundingClientRect();
      const width = tooltip.offsetWidth, height = tooltip.offsetHeight;
      tooltip.style.left = `${Math.max(8, Math.min(bounds.left, innerWidth - width - 8))}px`;
      tooltip.style.top = `${bounds.bottom + height + 8 < innerHeight
        ? bounds.bottom + 6 : Math.max(8, bounds.top - height - 6)}px`;
    };
    control.addEventListener("pointerenter", show, { signal });
    control.addEventListener("focus", show, { signal });
    for (const event of ["pointerleave", "blur", "pointerdown"]) {
      control.addEventListener(event, () => { if (active === control) hide(); }, { signal });
    }
    control.addEventListener("keydown", event => {
      if (event.key === "Escape" && !tooltip.hidden) {
        event.preventDefault();
        event.stopPropagation();
        hide();
      }
    }, { signal });
  }
  window.addEventListener("resize", hide, { signal });
  window.addEventListener("scroll", hide, { capture: true, signal });
  return () => {
    hide();
    controller.abort();
    tooltip.remove();
  };
}
