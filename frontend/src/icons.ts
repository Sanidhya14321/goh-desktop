const paths: Record<string, string> = {
  alert: "M12 3 2 21h20L12 3ZM12 9v5m0 3h.01",
  search: "m21 21-4.3-4.3M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
  sidebar: "M4 5h16v14H4zM9 5v14",
  terminal: "m5 7 5 5-5 5m8 0h6",
  settings: "M4 7h16M4 17h16M8 4v6m8 4v6",
  folder: "M3 6h6l2 2h10v10H3z",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  split: "M3 5h18v14H3zM12 5v14",
  edit: "m14 6 4 4M5 19l4-1L20 7l-4-4L5 14z",
  arrow: "M5 12h14m-5-5 5 5-5 5",
  close: "m6 6 12 12M18 6 6 18",
  activity: "M3 12h4l3-6 4 12 2-6h5",
  session: "M4 5h16v11H9l-5 4z",
  pin: "m10 4 10 10m-8-8-4 4-3 1 8 8 1-3 4-4M5 19l4-4",
  terminalExit: "M4 4h16v16H4z",
};

export function icon(name: string) {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(namespace, "path");
  path.setAttribute("d", paths[name] ?? "");
  svg.append(path);
  return svg;
}
