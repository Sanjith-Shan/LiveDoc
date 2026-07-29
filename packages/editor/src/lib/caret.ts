/**
 * Pixel coordinates of a caret index inside a <textarea>.
 *
 * Textareas don't expose per-character geometry, so this mirrors the
 * textarea into an off-screen div with identical typography and box model,
 * then measures where a marker span lands. Well-worn technique (the same
 * one "textarea-caret-position" uses); reimplemented here to avoid a dep.
 */
const MIRRORED_PROPS: (keyof CSSStyleDeclaration)[] = [
  "boxSizing",
  "width",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderStyle",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "fontStretch",
  "fontSize",
  "lineHeight",
  "fontFamily",
  "textAlign",
  "textTransform",
  "textIndent",
  "textDecoration",
  "letterSpacing",
  "wordSpacing",
  "tabSize",
];

let mirror: HTMLDivElement | null = null;

function getMirror(): HTMLDivElement {
  if (!mirror) {
    mirror = document.createElement("div");
    mirror.style.position = "absolute";
    mirror.style.visibility = "hidden";
    mirror.style.top = "0";
    mirror.style.left = "-9999px";
    mirror.style.whiteSpace = "pre-wrap";
    mirror.style.wordWrap = "break-word";
    mirror.style.overflow = "hidden";
    document.body.appendChild(mirror);
  }
  return mirror;
}

export interface CaretCoords {
  left: number;
  top: number;
  height: number;
}

export function getCaretCoordinates(el: HTMLTextAreaElement, position: number): CaretCoords {
  const div = getMirror();
  const computed = window.getComputedStyle(el);
  for (const prop of MIRRORED_PROPS) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (div.style as any)[prop] = computed[prop] as string;
  }
  div.style.width = computed.width;
  div.style.height = "auto";

  const clamped = Math.max(0, Math.min(position, el.value.length));
  div.textContent = el.value.substring(0, clamped);
  const span = document.createElement("span");
  span.textContent = el.value.substring(clamped) || ".";
  div.appendChild(span);

  const left = span.offsetLeft - el.scrollLeft;
  const top = span.offsetTop - el.scrollTop;
  const height = parseFloat(computed.lineHeight) || span.offsetHeight || 16;

  div.removeChild(span);
  div.textContent = "";

  return { left, top, height };
}

export interface SelectionRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function getSelectionRects(el: HTMLTextAreaElement, start: number, end: number): SelectionRect[] {
  if (start === end) return [];
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const text = el.value;
  const rects: SelectionRect[] = [];
  let cursor = lo;
  while (cursor < hi) {
    const nlIndex = text.indexOf("\n", cursor);
    const lineEnd = nlIndex === -1 || nlIndex > hi ? hi : nlIndex;
    const startCoord = getCaretCoordinates(el, cursor);
    const endCoord = getCaretCoordinates(el, lineEnd);
    rects.push({
      left: startCoord.left,
      top: startCoord.top,
      width: Math.max(4, endCoord.left - startCoord.left),
      height: startCoord.height,
    });
    if (nlIndex === -1) break;
    cursor = lineEnd + 1;
  }
  return rects;
}
