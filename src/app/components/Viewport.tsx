import { useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo } from 'react';
import type { WindowLevel, MeasurementTool, Measurement, PointUpdater } from './MedicalImageViewer';
import { Slider } from './ui/slider';

function sanitizeWindowLevel(windowVal: number, levelVal: number, fallback: WindowLevel): WindowLevel {
  const ww = Number.isFinite(windowVal) && windowVal > 0 ? Math.max(1, Math.round(windowVal)) : fallback.window;
  const wc = Number.isFinite(levelVal) ? Math.round(levelVal) : fallback.level;
  return { window: ww, level: wc };
}

const VIEWPORT_ZOOM_MIN = 1;
const VIEWPORT_ZOOM_MAX = 20;
const VIEWPORT_ZOOM_STEP = 1.18;
const VIEWPORT_ZOOM_ANIM_MS = 140;

// Slider ranges for per-viewport window/level controls.
// Values are in the 8-bit normalised intensity space (0–255) with generous
// headroom so edge cases (very bright/dark images) remain adjustable.
const WL_MIN_CENTER = -128;
const WL_MAX_CENTER = 384;
const WL_MIN_WIDTH = 1;
const WL_MAX_WIDTH = 512;

interface ViewportProps {
  imageData: Uint8Array;
  header: any;
  plane: 'axial' | 'sagittal' | 'coronal';
  /** When set (e.g. DICOM multi-sequence), shown in the info overlay instead of `plane`. */
  planeLabel?: string;
  /** Acquisition / window id stored on measurements (defaults to `plane`). Use for stacked 2D viewers. */
  measurementPlane?: 'axial' | 'sagittal' | 'coronal';
  currentSlice: number;
  onSliceChange: (slice: number) => void;
  /** Initial VOI for this viewer only; window/level and brightness live in local `Viewport` state (not shared across viewers). */
  defaultWindowLevel: WindowLevel;
  activeTool: MeasurementTool;
  measurements: Measurement[];
  onMeasurementAdd: (measurement: Measurement) => void;
  onMeasurementUpdate?: (id: string, newPoints: PointUpdater, value?: string, imageScale?: { x: number; y: number; offsetX?: number; offsetY?: number }) => void;
  selectedMeasurementId?: string | null;
  onMeasurementSelect?: (id: string | null) => void;
  applyWeighting: (pixelValue: number) => number;
  showCrosshair?: boolean;
  pixelSpacing?: { x: number; y: number };
  measurementUnits?: 'mm' | 'px';
  parentWindowHeight?: number;
  /** Restore upload defaults for this viewer only (slice/WL/measurements handled in parent). */
  onViewportReset?: () => void;
  /** Multi-viewer: hide this viewer (same as window chrome close). */
  onClose?: () => void;
  /** Reports the viewport's display size when it changes so the parent can
   *  compute the CSS→image-pixel scale for physical-unit conversions. */
  onDisplaySizeChange?: (size: { width: number; height: number }) => void;
  /** When set, renders a horizontal dotted reference line at a given mm offset
   *  above a measurement point.  Used for cross-plane protocols (e.g. 3 cm
   *  superior to the joint line).  The viewport computes the Y position and,
   *  for sagittal planes, the corresponding axial slice for navigation. */
  referenceLine?: {
    fromPoint: { x: number; y: number };
    offsetMm: number;
    label: string;
    imageScale?: { x: number; y: number; offsetX?: number; offsetY?: number };
  } | null;
  /** Called when the user clicks the reference line.  For sagittal viewports
   *  the callback receives the Z-position fraction (0–1) and the Z extent in
   *  image pixels so the parent can map to the axial volume's actual slice
   *  count.  For non-sagittal planes both values are -1. */
  onReferenceLineClick?: (refImgY: number, imgH: number) => void;
  /** When false, creating new measurements (lines, points, angles) is
   *  blocked on this viewport.  Existing measurements can still be selected
   *  and dragged.  Defaults to true. */
  allowNewMeasurements?: boolean;
}

export function Viewport({
  imageData,
  header,
  plane,
  planeLabel,
  measurementPlane = plane,
  currentSlice,
  onSliceChange,
  defaultWindowLevel,
  activeTool,
  measurements,
  onMeasurementAdd,
  onMeasurementUpdate,
  selectedMeasurementId,
  onMeasurementSelect,
  applyWeighting,
  showCrosshair = false,
  parentWindowHeight,
  onViewportReset,
  onClose,
  measurementUnits = 'mm',
  pixelSpacing,
  onDisplaySizeChange,
  referenceLine,
  onReferenceLineClick,
  allowNewMeasurements = true,
}: ViewportProps) {
  const [wl, setWl] = useState<WindowLevel>(() =>
    sanitizeWindowLevel(defaultWindowLevel.window, defaultWindowLevel.level, defaultWindowLevel),
  );
  /** Linear gain after weighting, before W/L — isolated per viewer instance. */
  const [brightness, setBrightness] = useState(1);
  const brightnessRef = useRef(brightness);
  brightnessRef.current = brightness;
  /** When true, brightness slider row is shown. */
  const [isBrightnessMode, setIsBrightnessMode] = useState(false);
  /** Per-viewer window center (level) slider panel. */
  const [isWlMode, setIsWlMode] = useState(false);
  /** Per-viewer window width slider panel. */
  const [isWwMode, setIsWwMode] = useState(false);
  const wlDefaultsRef = useRef<WindowLevel>(
    sanitizeWindowLevel(defaultWindowLevel.window, defaultWindowLevel.level, defaultWindowLevel),
  );

  const setWlSafe = useCallback((next: WindowLevel | ((prev: WindowLevel) => WindowLevel)) => {
    setWl((prev) => {
      const raw = typeof next === 'function' ? next(prev) : next;
      const sanitized = sanitizeWindowLevel(raw.window, raw.level, wlDefaultsRef.current);
      if (sanitized.window === prev.window && sanitized.level === prev.level) return prev;
      return sanitized;
    });
  }, []);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  // container for responsive sizing
  const containerRef = useRef<HTMLDivElement>(null);
  const [displaySize, setDisplaySize] = useState({ width: 0, height: 0 });
  const displaySizeRef = useRef(displaySize);
  // Propagate display size to parent so imageScale can be computed for protocol mm conversions.
  // useLayoutEffect fires synchronously (before paint) so the parent's viewportDisplaySizes
  // state is guaranteed to be updated before any useEffect (e.g. repositioning) runs,
  // eliminating a one-frame flicker in protocol-computed values like TT-TG.
  useLayoutEffect(() => {
    if (displaySize.width > 0 && displaySize.height > 0) {
      onDisplaySizeChange?.({ width: displaySize.width, height: displaySize.height });
    }
  }, [displaySize, onDisplaySizeChange]);
  // for debugging: container rect seen by ResizeObserver
  const [containerRect, setContainerRect] = useState({ width: 0, height: 0 });
  const [ancestorRects, setAncestorRects] = useState<{ parent: { width: number; height: number } | null; grandParent: { width: number; height: number } | null }>({ parent: null, grandParent: null });
  const sliderRef = useRef<HTMLDivElement | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawingPoints, setDrawingPoints] = useState<{ x: number; y: number }[]>([]);
  const [overlayTick, setOverlayTick] = useState(0);
  const [draggingPoint, setDraggingPoint] = useState<{ measurementId: string; pointIndex: number } | null>(null);
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const [hoveredLineId, setHoveredLineId] = useState<string | null>(null);
  const draggingPointRef = useRef<{ measurementId: string; pointIndex: number } | null>(null);
  const pendingLineDragRef = useRef<{
    measurementId: string;
    startX: number;
    startY: number;
    initialPoints: { x: number; y: number }[];
  } | null>(null);
  const lineDragMovedRef = useRef(false);
  const draggingPerpendicularRef = useRef<{ measurementId: string; startX: number; startY: number; baseLineId?: string | null } | null>(null);
  const perpendicularBaseLineRef = useRef<string | null>(null);
  const measurementsRef = useRef(measurements);
  const suppressClickRef = useRef(false);
  const dragMovedRef = useRef(false);
  const lastDragTimestampRef = useRef<number>(0);
  const lastDraggedPointRef = useRef<{ id: string; pointIndex: number; x: number; y: number; ts: number } | null>(null);
  const lastBaselineUpdateRef = useRef<Map<string, number>>(new Map());
  const pointerActionRef = useRef<Map<number, { last: 'down' | 'move' | 'drag' | 'up'; ts: number }>>(new Map());
  const recentPointerDragRef = useRef<Map<number, number>>(new Map());
  const lastPointerIdRef = useRef<number | null>(null);
  useEffect(() => {
    setSelectedLineId(selectedMeasurementId ?? null);
  }, [selectedMeasurementId]);

  useEffect(() => {
    setHoveredLineId(null);
  }, [currentSlice, measurementPlane]);

  useEffect(() => {
    measurementsRef.current = measurements;
  }, [measurements]);

  // Force an explicit overlay redraw when the active slice or plane changes.
  useEffect(() => {
    setOverlayTick((t) => t + 1);
  }, [currentSlice, measurementPlane]);

  const SNAP_RADIUS = 8;

  const distanceToSegment = useCallback((pt: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(pt.x - a.x, pt.y - a.y);
    const t = Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2));
    const px = a.x + t * dx;
    const py = a.y + t * dy;
    return Math.hypot(pt.x - px, pt.y - py);
  }, []);

  const findSnapPoint = useCallback((x: number, y: number, excludeMeasurementId?: string | null) => {
    let best: { x: number; y: number; dist: number } | null = null;
    for (const measurement of measurementsRef.current) {
      if ((measurement.plane ?? measurementPlane) !== measurementPlane) continue;
      const propagate = measurement.propagateAcrossSlices ?? true;
      if (!propagate && measurement.slice !== currentSlice) continue;
      if (excludeMeasurementId && measurement.id === excludeMeasurementId) continue;
      for (const point of measurement.points) {
        const dist = Math.hypot(point.x - x, point.y - y);
        if (dist <= SNAP_RADIUS && (!best || dist < best.dist)) {
          best = { x: point.x, y: point.y, dist };
        }
      }
    }
    return best ? { x: best.x, y: best.y } : { x, y };
  }, [currentSlice]);

  const findNearbyLine = useCallback((x: number, y: number) => {
    let best: { measurement: Measurement; distance: number } | null = null;
    for (const measurement of measurementsRef.current) {
      if ((measurement.plane ?? measurementPlane) !== measurementPlane) continue;
      const propagate = measurement.propagateAcrossSlices ?? true;
      if (!propagate && measurement.slice !== currentSlice) continue;
      if (measurement.type !== 'distance' && measurement.type !== 'line') continue;
      if (measurement.points.length < 2) continue;
      const d = distanceToSegment({ x, y }, measurement.points[0], measurement.points[1]);
      if (d <= 10 && (!best || d < best.distance)) {
        best = { measurement, distance: d };
      }
    }
    return best?.measurement ?? null;
  }, [currentSlice, distanceToSegment]);

  const buildPerpendicularPoints = useCallback((baseLine: Measurement, cursor: { x: number; y: number }) => {
    if (baseLine.points.length < 2) return null;
    const p0 = baseLine.points[0];
    const p1 = baseLine.points[1];
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return null;

    const t = ((cursor.x - p0.x) * dx + (cursor.y - p0.y) * dy) / (len * len);
    const anchorX = p0.x + dx * Math.max(0, Math.min(1, t));
    const anchorY = p0.y + dy * Math.max(0, Math.min(1, t));
    const perpX = -dy / len;
    const perpY = dx / len;
    const offset = (cursor.x - anchorX) * perpX + (cursor.y - anchorY) * perpY;
    const stubLen = Math.max(1, Math.abs(offset));
    const sign = offset >= 0 ? 1 : -1;

    return {
      anchor: { x: anchorX, y: anchorY },
      tip: { x: anchorX + perpX * stubLen * sign, y: anchorY + perpY * stubLen * sign },
    };
  }, []);

  // Pan state
  const [panSrc, setPanSrc] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const panStartRef = useRef<{ clientX: number; clientY: number; startX: number; startY: number } | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [zoomScale, setZoomScale] = useState(1);
  const [axialTransform, setAxialTransform] = useState<{ rotation: number }>({
    rotation: 0,
  });
  const [isRotateMode, setIsRotateMode] = useState(false);
  const [isZoomMode, setIsZoomMode] = useState(false);
  /** Last pointer over the overlay (for wheel focal when clientX/Y on wheel is unreliable). */
  const lastPointerClientRef = useRef<{ x: number; y: number } | null>(null);
  const zoomScaleRef = useRef(zoomScale);
  const panSrcRef = useRef(panSrc);
  const zoomAnimRafRef = useRef<number | null>(null);
  useEffect(() => {
    zoomScaleRef.current = zoomScale;
    panSrcRef.current = panSrc;
  }, [zoomScale, panSrc]);
  useEffect(() => () => {
    if (zoomAnimRafRef.current != null) cancelAnimationFrame(zoomAnimRafRef.current);
  }, []);
  const rotateDragRef = useRef<{ dragging: boolean; startAngle: number; startRotation: number }>({
    dragging: false,
    startAngle: 0,
    startRotation: 0,
  });
  const sliceDimsRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const cropRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const isAxial = plane === 'axial';
  const normalizeAngle = useCallback((angle: number) => {
    return ((angle % 360) + 360) % 360;
  }, []);

  const getPlaneGeometry = useCallback(() => {
    const dims = header.dims;
    const pixDims = header.pixDims || header?.pixdim || [];
    const width = plane === 'sagittal' ? dims[2] : dims[1];
    const height = plane === 'axial' ? dims[2] : dims[3];

    const p1 = Number.isFinite(pixDims[1]) && pixDims[1] > 0 ? pixDims[1] : 1;
    const p2 = Number.isFinite(pixDims[2]) && pixDims[2] > 0 ? pixDims[2] : 1;
    /** In-plane voxel pitch (typical MRI: ~0.5–1 mm, matrix often 512×512). */
    const dInPlane = Math.min(p1, p2);

    let spacingX: number;
    let spacingY: number;
    if (plane === 'axial') {
      spacingX = p1;
      spacingY = p2;
    } else if (plane === 'coronal') {
      spacingX = p1;
      spacingY = dInPlane;
    } else {
      spacingX = p2;
      spacingY = dInPlane;
    }

    return { width, height, spacingX, spacingY };
  }, [header, plane]);

  // Get slice data based on orientation
  const getSliceData = useCallback(() => {
    const dims = header.dims;
    const { width, height } = getPlaneGeometry();
    const sliceSize = width * height;
    const sliceData = new Uint8Array(sliceSize);

    // Extract slice based on plane
    if (plane === 'axial') {
      const offset = currentSlice * dims[1] * dims[2];
      for (let i = 0; i < sliceSize; i++) {
        sliceData[i] = imageData[offset + i] || 0;
      }
    } else if (plane === 'sagittal') {
      for (let z = 0; z < dims[3]; z++) {
        for (let y = 0; y < dims[2]; y++) {
          const idx = z * dims[2] + y;
          const sourceIdx = z * dims[1] * dims[2] + y * dims[1] + currentSlice;
          sliceData[idx] = imageData[sourceIdx] || 0;
        }
      }
    } else { // coronal
      for (let z = 0; z < dims[3]; z++) {
        for (let x = 0; x < dims[1]; x++) {
          const idx = z * dims[1] + x;
          const sourceIdx = z * dims[1] * dims[2] + currentSlice * dims[1] + x;
          sliceData[idx] = imageData[sourceIdx] || 0;
        }
      }
    }

    return { sliceData, width, height };
  }, [imageData, header, plane, currentSlice, getPlaneGeometry]);

  // ResizeObserver to calculate fit-to-container display size while preserving aspect ratio
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const update = () => {
      const rect = container.getBoundingClientRect();
      setContainerRect({ width: Math.round(rect.width), height: Math.round(rect.height) });
      const parent = container.parentElement;
      const parentRect = parent?.getBoundingClientRect();
      const grandParentRect = parent?.parentElement?.getBoundingClientRect();
      setAncestorRects({
        parent: parentRect ? { width: Math.round(parentRect.width), height: Math.round(parentRect.height) } : null,
        grandParent: grandParentRect ? { width: Math.round(grandParentRect.width), height: Math.round(grandParentRect.height) } : null,
      });

      if (rect.width === 0 || rect.height === 0) {
        setDisplaySize({ width: 0, height: 0 });
        return;
      }

      let sliderWidth = 0;
      let sliderMarginLeft = 0;
      const sliderEl = sliderRef.current;
      if (sliderEl) {
        const sRect = sliderEl.getBoundingClientRect();
        sliderWidth = Math.round(sRect.width);
        const sStyle = window.getComputedStyle(sliderEl);
        sliderMarginLeft = parseFloat(sStyle.marginLeft || '0') || 0;
      }

      const paddingBuffer = 8;
      const { width: imgW, height: imgH, spacingX, spacingY } = getPlaneGeometry();
      const physicalW = imgW * spacingX;
      const physicalH = imgH * spacingY;

      const availW = Math.max(1, rect.width - sliderWidth - sliderMarginLeft - paddingBuffer * 2);
      const availH = Math.max(1, rect.height - paddingBuffer * 2);

      const safeImgW = Math.max(1, imgW || 1);
      const safeImgH = Math.max(1, imgH || 1);

      const safePhysicalW = Math.max(1, physicalW || 1);
      const safePhysicalH = Math.max(1, physicalH || 1);
      const scale = Math.min(availW / safePhysicalW, availH / safePhysicalH);
      const computedW = Math.max(1, Math.round(safePhysicalW * scale));
      const computedH = Math.max(1, Math.round(safePhysicalH * scale));

      const MIN_DISPLAY = 48;
      const maxW = Math.max(MIN_DISPLAY, Math.round(rect.width - paddingBuffer * 2));
      const maxH = Math.max(MIN_DISPLAY, Math.round(rect.height - paddingBuffer * 2));

      const finalW = Math.max(MIN_DISPLAY, Math.min(maxW, Math.round(computedW)));
      const finalH = Math.max(MIN_DISPLAY, Math.min(maxH, Math.round(computedH)));

      const deltaW = Math.max(2, Math.round(rect.width * 0.005));
      const deltaH = Math.max(2, Math.round(rect.height * 0.005));
      if (Math.abs(displaySizeRef.current.width - finalW) < deltaW && Math.abs(displaySizeRef.current.height - finalH) < deltaH) {
        return;
      }

      displaySizeRef.current = { width: finalW, height: finalH };
      setDisplaySize({ width: finalW, height: finalH });
    };

    let rafId: number | null = null;
    const debouncedUpdate = () => {
      if (rafId != null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        update();
      });
    };

    const ro = new ResizeObserver(debouncedUpdate);
    ro.observe(container);

    const onResize = () => debouncedUpdate();
    const onScroll = () => debouncedUpdate();

    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);

    update();

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
      if (rafId != null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };
  }, [getPlaneGeometry]);

  const emitMeasurementUpdate = useCallback((id: string, newPoints: PointUpdater, value?: string, imageScale?: { x: number; y: number; offsetX?: number; offsetY?: number }) => {
    onMeasurementUpdate?.(id, newPoints, value, imageScale);
    try {
      lastBaselineUpdateRef.current.set(id, Date.now());
    } catch {}
  }, [onMeasurementUpdate]);

  // Compute the current CSS→image-pixel scale factor from displaySize.
  // Mirrors the draw-area logic in the repositioning effect and
  // calculateMeasurementValue so it's always consistent.
  const computeImageScale = useCallback((): { x: number; y: number; offsetX: number; offsetY: number } => {
    const { width: imgW, height: imgH, spacingX: geomSpacingX, spacingY: geomSpacingY } = getPlaneGeometry();
    const spcX = (pixelSpacing && pixelSpacing.x > 0 ? pixelSpacing.x : geomSpacingX) || 1;
    const spcY = (pixelSpacing && pixelSpacing.y > 0 ? pixelSpacing.y : geomSpacingY) || 1;
    const dW = displaySize.width || imgW || 1;
    const dH = displaySize.height || imgH || 1;
    const physicalW = Math.max(1, imgW * spcX);
    const physicalH = Math.max(1, imgH * spcY);
    const fitScale = Math.min(dW / physicalW, dH / physicalH);
    const drawW = Math.max(1, Math.round(physicalW * fitScale));
    const drawH = Math.max(1, Math.round(physicalH * fitScale));
    const offsetX = (dW - drawW) / 2;
    const offsetY = (dH - drawH) / 2;
    return { x: imgW / drawW, y: imgH / drawH, offsetX, offsetY };
  }, [displaySize, getPlaneGeometry, pixelSpacing]);

  const emitMeasurementAdd = useCallback((m: Measurement) => {
    // Stamp the current imageScale on every new measurement so protocol
    // step results always have the correct px→mm conversion factor.
    const withScale: Measurement = { ...m, imageScale: m.imageScale ?? computeImageScale() };
    onMeasurementAdd(withScale);
    try {
      lastBaselineUpdateRef.current.set(m.id, Date.now());
    } catch {}
  }, [onMeasurementAdd, computeImageScale]);

  // ── Reference line computation (cross-plane protocol support) ──────────
  // When the active protocol step defines a referenceLineMm offset, compute
  // the CSS-pixel Y position of the reference line.  For sagittal viewports
  // the Y-axis is the Z-direction (superior-inferior); the spacing is the
  // row spacing of the sagittal acquisition (pixDims[2]), which is typically
  // the in-plane resolution (~0.35 mm), NOT the slice thickness.
  const computedReferenceLine = useMemo(() => {
    if (!referenceLine) return null;
    const { fromPoint, offsetMm, imageScale: rlImageScale } = referenceLine;
    const is = rlImageScale ?? computeImageScale();

    // Row spacing of this volume (Z-direction for sagittal, Y for axial).
    const pixDims: number[] = header.pixDims || header?.pixdim || [];
    const rowSpacing = Number.isFinite(pixDims[2]) && pixDims[2] > 0 ? pixDims[2] : 1;
    const { height: imgH } = getPlaneGeometry();

    const isSagittal = measurementPlane === 'sagittal';

    // Convert the source point from CSS to image-pixel coordinates.
    const imgY = (fromPoint.y - (is.offsetY ?? 0)) * (is.y || 1);

    // Compute the offset in image pixels (superior = smaller Y in image space).
    const offsetImgPx = offsetMm / rowSpacing;
    const refImgY = imgY - offsetImgPx;

    // Convert back to CSS coordinates.
    const refCssY = refImgY / (is.y || 1) + (is.offsetY ?? 0);

    return {
      cssY: refCssY,
      refImgY: isSagittal ? refImgY : -1,
      imgH: isSagittal ? imgH : -1,
      isSagittal,
    };
  }, [referenceLine, computeImageScale, getPlaneGeometry, measurementPlane, header]);

  const prevDisplaySizeRef = useRef<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const prev = prevDisplaySizeRef.current;
    const cur = displaySize;

    if (!prev || prev.width === 0 || prev.height === 0) {
      prevDisplaySizeRef.current = cur;
      return;
    }
    
    if (cur.width === 0 || cur.height === 0) {
        return;
    }

    if (prev.width === cur.width && prev.height === cur.height) return;

    if (
      draggingPointRef.current ||
      pendingLineDragRef.current ||
      draggingPerpendicularRef.current ||
      isPanning ||
      isDrawing
    ) {
      prevDisplaySizeRef.current = cur;
      return;
    }

    if (!onMeasurementUpdate) {
      prevDisplaySizeRef.current = cur;
      return;
    }

    // Compute the image draw area (size + centering offset) for a given display
    // size.  Measurements are stored in display-canvas CSS-pixel coordinates,
    // but the image is centered inside the canvas, so a naive display-ratio
    // scale corrupts positions when the aspect ratio changes.  We map each
    // point through image-fraction space instead:
    //   canvas px  →  fraction of draw area  →  new canvas px
    const { width: imgW, height: imgH, spacingX: geomSpacingX, spacingY: geomSpacingY } = getPlaneGeometry();
    // Match the spacing source used by calculateMeasurementValue so the draw
    // area is identical to the one used for px↔mm conversion.
    const spcX = (pixelSpacing && pixelSpacing.x > 0 ? pixelSpacing.x : geomSpacingX) || 1;
    const spcY = (pixelSpacing && pixelSpacing.y > 0 ? pixelSpacing.y : geomSpacingY) || 1;
    const physicalW = Math.max(1, imgW * spcX);
    const physicalH = Math.max(1, imgH * spcY);

    const drawArea = (dW: number, dH: number) => {
      const scale = Math.min(dW / physicalW, dH / physicalH);
      const drawW = Math.max(1, Math.round(physicalW * scale));
      const drawH = Math.max(1, Math.round(physicalH * scale));
      return { drawW, drawH, offsetX: (dW - drawW) / 2, offsetY: (dH - drawH) / 2 };
    };

    const oldArea = drawArea(prev.width, prev.height);
    const newArea = drawArea(cur.width, cur.height);
    const currentImageScale = computeImageScale();

    // Only remap baselines (distance / line / angle).  Perpendicular anchors
    // are automatically recalculated by handleMeasurementUpdate when their
    // parent baseline is moved, so emitting a second update for the same
    // perpendicular would conflict with the baseline’s update inside React’s
    // batched state processing and leave the baseline at its old coordinates.
    for (const m of measurements) {
      if (m.type === 'perpendicular') continue;
      emitMeasurementUpdate(m.id, (oldPoints) =>
        oldPoints.map((p) => ({
          x: ((p.x - oldArea.offsetX) / oldArea.drawW) * newArea.drawW + newArea.offsetX,
          y: ((p.y - oldArea.offsetY) / oldArea.drawH) * newArea.drawH + newArea.offsetY,
        })),
        undefined,
        currentImageScale,
      );
    }

    // Remap any perpendiculars whose baseline was NOT processed above
    // (e.g. the baseline belongs to a different plane / is hidden).
    const remappedIds = new Set(measurements.filter(m => m.type !== 'perpendicular').map(m => m.id));
    for (const m of measurements) {
      if (m.type !== 'perpendicular') continue;
      if (m.baseLineId && remappedIds.has(m.baseLineId)) continue;
      emitMeasurementUpdate(m.id, (oldPoints) =>
        oldPoints.map((p) => ({
          x: ((p.x - oldArea.offsetX) / oldArea.drawW) * newArea.drawW + newArea.offsetX,
          y: ((p.y - oldArea.offsetY) / oldArea.drawH) * newArea.drawH + newArea.offsetY,
        })),
        undefined,
        currentImageScale,
      );
    }

    prevDisplaySizeRef.current = cur;
  }, [displaySize, measurements, onMeasurementUpdate, isPanning, isDrawing, emitMeasurementUpdate, getPlaneGeometry, pixelSpacing]);

  // New volume buffer → reset this viewer’s W/L and brightness only (no cross-viewport state).
  const prevImageDataRef = useRef<Uint8Array | null>(null);
  useEffect(() => {
    if (prevImageDataRef.current === imageData) return;
    prevImageDataRef.current = imageData;
    const safeDefaults = sanitizeWindowLevel(
      defaultWindowLevel.window,
      defaultWindowLevel.level,
      defaultWindowLevel,
    );
    wlDefaultsRef.current = { ...safeDefaults };
    setWl(safeDefaults);
    setBrightness(1);
    setIsBrightnessMode(false);
    setIsWlMode(false);
    setIsWwMode(false);
  }, [imageData, defaultWindowLevel]);

  // Apply weighting, per-viewport brightness, then window/level
  const applyWindowLevel = useCallback((value: number): number => {
    const weighted = applyWeighting(value);
    const scaled = weighted * brightness;

    const { window: ww, level: wc } = wl;
    const voiMin = wc - ww / 2;
    const voiMax = wc + ww / 2;
    const span = voiMax - voiMin;
    if (span < 1) return 128;

    if (scaled <= voiMin) return 0;
    if (scaled >= voiMax) return 255;

    return Math.round(((scaled - voiMin) / span) * 255);
  }, [wl, brightness, applyWeighting]);

  const drawTransformedImage = useCallback((
    ctx: CanvasRenderingContext2D,
    dpr: number,
    centerX: number,
    centerY: number,
    drawW: number,
    drawH: number,
    drawImage: () => void
  ) => {
    const rotation = isAxial ? normalizeAngle(axialTransform.rotation) : 0;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.translate(centerX, centerY);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.translate(-drawW / 2, -drawH / 2);
    drawImage();
    ctx.restore();
  }, [isAxial, axialTransform, normalizeAngle]);

  const rotateAxialBy = useCallback((delta: number) => {
    setAxialTransform(prev => ({ rotation: normalizeAngle(prev.rotation + delta) }));
  }, [normalizeAngle]);

  const getPointerAngleFromCenter = useCallback((clientX: number, clientY: number) => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    return Math.atan2(clientY - centerY, clientX - centerX) * (180 / Math.PI);
  }, []);

  const startRotateDrag = useCallback((clientX: number, clientY: number) => {
    rotateDragRef.current = {
      dragging: true,
      startAngle: getPointerAngleFromCenter(clientX, clientY),
      startRotation: axialTransform.rotation,
    };
  }, [axialTransform.rotation, getPointerAngleFromCenter]);

  const moveRotateDrag = useCallback((clientX: number, clientY: number) => {
    const drag = rotateDragRef.current;
    if (!drag.dragging) return;
    const currentAngle = getPointerAngleFromCenter(clientX, clientY);
    let delta = currentAngle - drag.startAngle;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    const nextRotation = normalizeAngle(drag.startRotation + delta);
    setAxialTransform({ rotation: nextRotation });
  }, [normalizeAngle, getPointerAngleFromCenter]);

  const stopRotateDrag = useCallback(() => {
    rotateDragRef.current.dragging = false;
  }, []);

  const dismissCanvasToolModes = useCallback(() => {
    setIsRotateMode(false);
    stopRotateDrag();
    setIsZoomMode(false);
    lastPointerClientRef.current = null;
  }, [stopRotateDrag]);

  const dismissAllToolbarPanels = useCallback(() => {
    dismissCanvasToolModes();
    setIsWlMode(false);
    setIsWwMode(false);
    setIsBrightnessMode(false);
  }, [dismissCanvasToolModes]);

  const cancelZoomAnimation = useCallback(() => {
    if (zoomAnimRafRef.current != null) {
      cancelAnimationFrame(zoomAnimRafRef.current);
      zoomAnimRafRef.current = null;
    }
  }, []);

  /** Pan/zoom/rotate/draft state only (parent handles slice, WL, persisted measurements). */
  const resetViewportInteractionState = useCallback(() => {
    cancelZoomAnimation();
    stopRotateDrag();
    setAxialTransform({ rotation: 0 });
    zoomScaleRef.current = 1;
    panSrcRef.current = { x: 0, y: 0 };
    setZoomScale(1);
    setPanSrc({ x: 0, y: 0 });
    dismissAllToolbarPanels();
    setIsDrawing(false);
    setDrawingPoints([]);
    setIsPanning(false);
    panStartRef.current = null;
  }, [stopRotateDrag, cancelZoomAnimation, dismissAllToolbarPanels]);

  const handleViewerReset = useCallback(() => {
    resetViewportInteractionState();
    setWlSafe({ ...wlDefaultsRef.current });
    setBrightness(1);
    onViewportReset?.();
  }, [onViewportReset, resetViewportInteractionState, setWlSafe]);

  /** Map screen position to slice image pixel (continuous) for current zoom/pan/rotation. */
  const clientToImagePixel = useCallback(
    (clientX: number, clientY: number): { imgX: number; imgY: number } | null => {
      const main = canvasRef.current;
      if (!main) return null;
      const rect = main.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const displayW_css = main.width / dpr;
      const displayH_css = main.height / dpr;
      if (displayW_css < 1 || displayH_css < 1) return null;
      const lx = ((clientX - rect.left) / Math.max(rect.width, 1)) * displayW_css;
      const ly = ((clientY - rect.top) / Math.max(rect.height, 1)) * displayH_css;

      const iw = sliceDimsRef.current.w;
      const ih = sliceDimsRef.current.h;
      if (iw < 1 || ih < 1) return null;

      const { spacingX, spacingY } = getPlaneGeometry();
      const physicalW = iw * spacingX;
      const physicalH = ih * spacingY;
      const sx = displayW_css / physicalW || 1;
      const sy = displayH_css / physicalH || 1;
      const scaleFit = Math.min(sx, sy);
      const drawW = Math.max(1, Math.round(physicalW * scaleFit));
      const drawH = Math.max(1, Math.round(physicalH * scaleFit));

      const cx = displayW_css / 2;
      const cy = displayH_css / 2;
      const θ = (normalizeAngle(axialTransform.rotation) * Math.PI) / 180;
      const rx = lx - cx;
      const ry = ly - cy;
      const ix = Math.cos(-θ) * rx - Math.sin(-θ) * ry;
      const iy = Math.sin(-θ) * rx + Math.cos(-θ) * ry;
      let u = ix + drawW / 2;
      let v = iy + drawH / 2;
      u = Math.max(0, Math.min(drawW, u));
      v = Math.max(0, Math.min(drawH, v));
      const uFrac = drawW > 0 ? u / drawW : 0.5;
      const vFrac = drawH > 0 ? v / drawH : 0.5;

      const z = zoomScaleRef.current;
      const cropW = Math.max(1, Math.floor(iw / z));
      const cropH = Math.max(1, Math.floor(ih / z));
      const px = Math.max(0, Math.min(iw - cropW, Math.round(panSrcRef.current.x)));
      const py = Math.max(0, Math.min(ih - cropH, Math.round(panSrcRef.current.y)));
      return {
        imgX: px + uFrac * cropW,
        imgY: py + vFrac * cropH,
      };
    },
    [getPlaneGeometry, normalizeAngle, axialTransform.rotation]
  );

    /** Update zoom scale while keeping a fixed image-space focal point (pan only — no slice/WL changes). */
    const applyZoomAtImageFocal = useCallback((focalX: number, focalY: number, newZ: number) => {
      const iw = sliceDimsRef.current.w;
      const ih = sliceDimsRef.current.h;
      if (iw < 1 || ih < 1) return;

      const clampedZ = Math.min(VIEWPORT_ZOOM_MAX, Math.max(VIEWPORT_ZOOM_MIN, newZ));
      if (clampedZ <= VIEWPORT_ZOOM_MIN + 1e-6) {
        zoomScaleRef.current = VIEWPORT_ZOOM_MIN;
        panSrcRef.current = { x: 0, y: 0 };
        setZoomScale(VIEWPORT_ZOOM_MIN);
        setPanSrc({ x: 0, y: 0 });
        return;
      }

      const newCropW = Math.max(1, Math.floor(iw / clampedZ));
      const newCropH = Math.max(1, Math.floor(ih / clampedZ));
      let npx = Math.round(focalX - newCropW / 2);
      let npy = Math.round(focalY - newCropH / 2);
      npx = Math.max(0, Math.min(iw - newCropW, npx));
      npy = Math.max(0, Math.min(ih - newCropH, npy));

      zoomScaleRef.current = clampedZ;
      panSrcRef.current = { x: npx, y: npy };
      setZoomScale(clampedZ);
      setPanSrc({ x: npx, y: npy });
    }, []);

    const getViewportCenterImagePixel = useCallback((): { x: number; y: number } => {
      const iw = sliceDimsRef.current.w;
      const ih = sliceDimsRef.current.h;
      if (iw < 1 || ih < 1) return { x: 0, y: 0 };
      const z = Math.max(VIEWPORT_ZOOM_MIN, zoomScaleRef.current);
      const cropW = Math.max(1, Math.floor(iw / z));
      const cropH = Math.max(1, Math.floor(ih / z));
      return {
        x: panSrcRef.current.x + cropW / 2,
        y: panSrcRef.current.y + cropH / 2,
      };
    }, []);

    const animateZoomToTarget = useCallback(
      (targetZ: number) => {
        cancelZoomAnimation();
        const iw = sliceDimsRef.current.w;
        const ih = sliceDimsRef.current.h;
        if (iw < 1 || ih < 1) return;

        const focal = getViewportCenterImagePixel();
        const startZ = zoomScaleRef.current;
        const endZ = Math.min(VIEWPORT_ZOOM_MAX, Math.max(VIEWPORT_ZOOM_MIN, targetZ));
        if (Math.abs(endZ - startZ) < 1e-4) return;

        const t0 = performance.now();
        const tick = (now: number) => {
          const t = Math.min(1, (now - t0) / VIEWPORT_ZOOM_ANIM_MS);
          const eased = 1 - (1 - t) ** 3;
          const z = startZ + (endZ - startZ) * eased;
          applyZoomAtImageFocal(focal.x, focal.y, z);
          if (t < 1) {
            zoomAnimRafRef.current = requestAnimationFrame(tick);
          } else {
            applyZoomAtImageFocal(focal.x, focal.y, endZ);
            zoomAnimRafRef.current = null;
          }
        };
        zoomAnimRafRef.current = requestAnimationFrame(tick);
      },
      [applyZoomAtImageFocal, cancelZoomAnimation, getViewportCenterImagePixel],
    );

    const zoomInStep = useCallback(() => {
      animateZoomToTarget(zoomScaleRef.current * VIEWPORT_ZOOM_STEP);
    }, [animateZoomToTarget]);

    const zoomOutStep = useCallback(() => {
      animateZoomToTarget(zoomScaleRef.current / VIEWPORT_ZOOM_STEP);
    }, [animateZoomToTarget]);

  /** Axial zoom mode: zoom toward whatever is under the pointer (hover + scroll). */
  const applyAxialWheelZoomAtPointer = useCallback(
    (clientX: number, clientY: number, deltaY: number, deltaMode: number) => {
      const iw = sliceDimsRef.current.w;
      const ih = sliceDimsRef.current.h;
      if (iw < 1 || ih < 1) return;

      cancelZoomAnimation();

      const main = canvasRef.current;
      if (main) {
        const r = main.getBoundingClientRect();
        const inside =
          clientX >= r.left &&
          clientX <= r.right &&
          clientY >= r.top &&
          clientY <= r.bottom;
        if (!inside && lastPointerClientRef.current) {
          clientX = lastPointerClientRef.current.x;
          clientY = lastPointerClientRef.current.y;
        }
      }

      let focal = clientToImagePixel(clientX, clientY);
      if (!focal && lastPointerClientRef.current) {
        focal = clientToImagePixel(lastPointerClientRef.current.x, lastPointerClientRef.current.y);
      }
      const center = getViewportCenterImagePixel();
      const fx = focal?.imgX ?? center.x;
      const fy = focal?.imgY ?? center.y;

      const prevZ = zoomScaleRef.current;
      let step = deltaY;
      if (deltaMode === 1) step *= 16;
      if (deltaMode === 2) step *= 800;
      const factor = Math.exp(-step * 0.0012);
      const newZ = Math.min(VIEWPORT_ZOOM_MAX, Math.max(VIEWPORT_ZOOM_MIN, prevZ * factor));
      if (Math.abs(newZ - prevZ) < 1e-6) return;

      applyZoomAtImageFocal(fx, fy, newZ);
    }, [applyZoomAtImageFocal, cancelZoomAnimation, clientToImagePixel, getViewportCenterImagePixel],
  );

  // Reset interaction state when a new volume buffer is loaded for this viewer.
  useEffect(() => {
    if (isAxial) {
      setAxialTransform({ rotation: 0 });
      setIsRotateMode(false);
    }
    cancelZoomAnimation();
    zoomScaleRef.current = 1;
    panSrcRef.current = { x: 0, y: 0 };
    setZoomScale(1);
    setPanSrc({ x: 0, y: 0 });
    setIsZoomMode(false);
    lastPointerClientRef.current = null;
  }, [imageData, isAxial, cancelZoomAnimation]);

  // Heavy rendering effect: builds source canvas and caches ImageBitmap when slice/WL/weighting changes
  const bitmapRef = useRef<ImageBitmap | null>(null);
  const bitmapKeyRef = useRef<string | null>(null);
  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    const overlay = overlayCanvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    (async () => {
      const { sliceData, width, height } = getSliceData();

      // Track slice dimensions for pan calculations
      sliceDimsRef.current = { w: width, h: height };

      // Build RGBA image buffer after applying window/level
      const rgba = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < sliceData.length; i++) {
        const value = applyWindowLevel(sliceData[i]);
        rgba[i * 4] = value;
        rgba[i * 4 + 1] = value;
        rgba[i * 4 + 2] = value;
        rgba[i * 4 + 3] = 255;
      }

      const imgData = new ImageData(rgba, width, height);

      // Compute display size (CSS pixels)
      const displayW = displaySize.width || width;
      const displayH = displaySize.height || height;

      const dpr = window.devicePixelRatio || 1;

      // Set backing store to match the desired display size in device pixels
      const MAX_BACKING = 8192; // cap to avoid infinite memory growth
      let targetW = Math.max(1, Math.floor(displayW * dpr));
      let targetH = Math.max(1, Math.floor(displayH * dpr));

      // If either dimension exceeds limit, scale down while preserving aspect
      if (targetW > MAX_BACKING || targetH > MAX_BACKING) {
        const scale = Math.min(MAX_BACKING / targetW, MAX_BACKING / targetH);
        targetW = Math.max(1, Math.floor(targetW * scale));
        targetH = Math.max(1, Math.floor(targetH * scale));
      }

      canvas.width = targetW;
      canvas.height = targetH;

      // Scale canvas CSS size to the target display size (CSS pixels)
      canvas.style.width = `${displayW}px`;
      canvas.style.height = `${displayH}px`;

      // Ensure we have a source canvas to draw from synchronously
      if (!sourceCanvasRef.current) sourceCanvasRef.current = document.createElement('canvas');
      const src = sourceCanvasRef.current;
      if (src.width !== width || src.height !== height) {
        src.width = width;
        src.height = height;
      }
      const sctx = src.getContext('2d');
      sctx?.putImageData(imgData, 0, 0);

      // Draw immediately from source canvas (synchronous and fast)
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Compute CSS display sizes (canvas backing divided by DPR)
      const displayW_css = canvas.width / dpr;
      const displayH_css = canvas.height / dpr;

      // compute scaled draw size preserving aspect and centering
      const { spacingX, spacingY } = getPlaneGeometry();
      const physicalW = width * spacingX;
      const physicalH = height * spacingY;
      const sx = displayW_css / physicalW || 1;
      const sy = displayH_css / physicalH || 1;
      const scale = Math.min(sx, sy);
      const drawW = Math.max(1, Math.round(physicalW * scale));
      const drawH = Math.max(1, Math.round(physicalH * scale));
      const centerX = displayW_css / 2;
      const centerY = displayH_css / 2;

      if (zoomScale > 1) {
        const cropW = Math.max(1, Math.floor(width / zoomScale));
        const cropH = Math.max(1, Math.floor(height / zoomScale));
        cropRef.current = { w: cropW, h: cropH };

        const px = Math.max(0, Math.min(sliceDimsRef.current.w - cropW, Math.round(panSrc.x || 0)));
        const py = Math.max(0, Math.min(sliceDimsRef.current.h - cropH, Math.round(panSrc.y || 0)));
        if (panSrc.x !== px || panSrc.y !== py) {
          panSrcRef.current = { x: px, y: py };
          setPanSrc({ x: px, y: py });
        }

        drawTransformedImage(ctx, dpr, centerX, centerY, drawW, drawH, () => {
          ctx.drawImage(src, px, py, cropW, cropH, 0, 0, drawW, drawH);
        });
      } else {
        drawTransformedImage(ctx, dpr, centerX, centerY, drawW, drawH, () => {
          ctx.drawImage(src, 0, 0, width, height, 0, 0, drawW, drawH);
        });
      }

      // Asynchronously build and cache an ImageBitmap for faster subsequent draws
      const key = `${plane}:${currentSlice}:${wl.window}:${wl.level}:${brightness}`;
      if (bitmapKeyRef.current !== key) {
        try {
          const b = await createImageBitmap(imgData);
          if (cancelled) { b.close?.(); }
          else {
            bitmapRef.current?.close?.();
            bitmapRef.current = b;
            bitmapKeyRef.current = key;
          }
        } catch (e) {
          // ignore
        }
      }

      // Ensure overlay canvas matches backing store and CSS size
      if (overlay) {
        overlay.width = canvas.width;
        overlay.height = canvas.height;
        overlay.style.width = `${displayW}px`;
        overlay.style.height = `${displayH}px`;
        // Force overlay draw effect to run immediately after image draw
        setOverlayTick((t) => t + 1);
      }
    })();

    return () => { cancelled = true; };
  }, [imageData, currentSlice, plane, wl, applyWindowLevel, getSliceData, getPlaneGeometry, displaySize, zoomScale, panSrc, drawTransformedImage]);

  // Fast pan/zoom draw effect: responds to panSrc and zoomScale without rebuilding pixels
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const src = sourceCanvasRef.current;
    if (!src) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const width = src.width;
    const height = src.height;

    const dpr = window.devicePixelRatio || 1;
    const displayW_css = canvas.width / dpr;
    const displayH_css = canvas.height / dpr;
    const { spacingX, spacingY } = getPlaneGeometry();
    const physicalW = width * spacingX;
    const physicalH = height * spacingY;
    const sx = displayW_css / physicalW || 1;
    const sy = displayH_css / physicalH || 1;
    const scale = Math.min(sx, sy);
    const drawW = Math.max(1, Math.round(physicalW * scale));
    const drawH = Math.max(1, Math.round(physicalH * scale));
    const centerX = displayW_css / 2;
    const centerY = displayH_css / 2;

    if (zoomScale > 1) {
      const cropW = Math.max(1, Math.floor(width / zoomScale));
      const cropH = Math.max(1, Math.floor(height / zoomScale));
      cropRef.current = { w: cropW, h: cropH };

      const px = Math.max(0, Math.min(sliceDimsRef.current.w - cropW, Math.round(panSrc.x || 0)));
      const py = Math.max(0, Math.min(sliceDimsRef.current.h - cropH, Math.round(panSrc.y || 0)));

      drawTransformedImage(ctx, dpr, centerX, centerY, drawW, drawH, () => {
        ctx.drawImage(src, px, py, cropW, cropH, 0, 0, drawW, drawH);
      });
    } else {
      drawTransformedImage(ctx, dpr, centerX, centerY, drawW, drawH, () => {
        ctx.drawImage(src, 0, 0, width, height, 0, 0, drawW, drawH);
      });
    }
  }, [panSrc, zoomScale, displaySize, getPlaneGeometry, drawTransformedImage, axialTransform.rotation]);

  // Render measurements overlay
  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    const mainCanvas = canvasRef.current;
    if (!canvas || !mainCanvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;

    // Match internal pixel dimensions of main canvas
    canvas.width = mainCanvas.width;
    canvas.height = mainCanvas.height;

    // Scale context so drawing uses CSS pixel coords
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Clear in CSS pixel coordinates
    const clearW = canvas.width / dpr;
    const clearH = canvas.height / dpr;
    ctx.clearRect(0, 0, clearW, clearH);

    const drawLabel = (
      text: string,
      x: number,
      y: number,
      fill = '#111827',
      textFill = '#e5e7eb',
      maxWidth = 96,
      textOpacity = 1,
      bgOpacity = 0.12,
    ) => {
      ctx.save();
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const words = text.split(/\s+/).filter(Boolean);
      const lines: string[] = [];
      let current = '';
      for (const word of words) {
        const next = current ? `${current} ${word}` : word;
        if (ctx.measureText(next).width <= maxWidth || !current) {
          current = next;
        } else {
          lines.push(current);
          current = word;
        }
      }
      if (current) lines.push(current);
      const lineHeight = 12;
      const widest = Math.max(...lines.map((line) => ctx.measureText(line).width), 0);
      const boxW = Math.max(36, Math.min(maxWidth + 14, widest + 14));
      const boxH = Math.max(18, lines.length * lineHeight + 6);

      // Draw faint background first (same for selected and unselected)
      ctx.save();
      ctx.globalAlpha = bgOpacity;
      ctx.fillStyle = fill;
      ctx.fillRect(x - boxW / 2, y - boxH / 2, boxW, boxH);
      ctx.restore();

      // Draw text with requested opacity so selected text can be darker
      ctx.save();
      ctx.globalAlpha = textOpacity;
      ctx.fillStyle = textFill;
      lines.forEach((line, index) => {
        const lineY = y - ((lines.length - 1) * lineHeight) / 2 + index * lineHeight + 0.5;
        ctx.fillText(line, x, lineY);
      });
      ctx.restore();
      ctx.restore();
    };

    // Draw crosshair (optional)
    if (showCrosshair) {
      ctx.strokeStyle = 'rgba(0, 255, 255, 0.5)';
      ctx.lineWidth = 1;
      const centerX = clearW / 2;
      const centerY = clearH / 2;
      
      ctx.beginPath();
      ctx.moveTo(centerX, 0);
      ctx.lineTo(centerX, clearH);
      ctx.moveTo(0, centerY);
      ctx.lineTo(clearW, centerY);
      ctx.stroke();
    }

    // Draw completed measurements
    measurements.forEach((measurement) => {
      if ((measurement.plane ?? measurementPlane) !== measurementPlane) return;

      ctx.strokeStyle = '#3b82f6';
      ctx.fillStyle = '#3b82f6';
      ctx.lineWidth = 2;

      const points = measurement.points;

      const isSelected = measurement.id === selectedLineId;
      const overlayAlpha = 1;
      const labelTextAlpha = isSelected ? 0.95 : 0.12;
      const valueTextAlpha = isSelected ? 0.85 : 0.08;
      const labelBgAlpha = 0.12;
      if ((measurement.type === 'distance' || measurement.type === 'line') && points.length >= 2) {
        ctx.save();
        ctx.globalAlpha = overlayAlpha;
        // draw baseline (dashed for infinite 'line', solid for distance)
        if (measurement.type === 'line') {
          const dx = points[1].x - points[0].x;
          const dy = points[1].y - points[0].y;
          const len = Math.hypot(dx, dy) || 1;
          const ux = dx / len;
          const uy = dy / len;
          const big = (canvas.width + canvas.height) / dpr;
          const a = { x: points[0].x - ux * big, y: points[0].y - uy * big };
          const b = { x: points[1].x + ux * big, y: points[1].y + uy * big };
          ctx.save();
          ctx.setLineDash([6, 4]);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
          ctx.restore();
        }

        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        ctx.lineTo(points[1].x, points[1].y);
        // emphasize if selected
        if (isSelected) {
          ctx.strokeStyle = '#f59e0b';
          ctx.lineWidth = 4;
        } else {
          ctx.strokeStyle = '#3b82f6';
          ctx.lineWidth = 2;
        }
        ctx.stroke();

        points.forEach(p => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
          ctx.fill();
        });
        ctx.restore();
        const midX = (points[0].x + points[1].x) / 2;
        const midY = (points[0].y + points[1].y) / 2;
        // value label: prefer measurement.value (keeps panel/overlay in sync),
        // fall back to viewport calculation if not yet propagated.
        const valueText = measurement.value || calculateMeasurementValue(measurement.type as MeasurementTool, points);
        if (measurement.label) {
          drawLabel(measurement.label, midX, midY - 34, '#0f172a', '#e5e7eb', 96, labelTextAlpha, labelBgAlpha);
        }
        if ((pixelSpacing || measurement.value) && valueText) {
          drawLabel(valueText, midX, midY - 14, '#0f172a', '#e5e7eb', 96, valueTextAlpha, labelBgAlpha);
        }
        if (measurement.id === hoveredLineId || measurement.id === selectedLineId) {
          drawLabel('⊥ add', midX, midY + 14, '#ffffff', '#111827', 96, isSelected ? 0.25 : 0.14, 0.08);
        }
      } else if (measurement.type === 'perpendicular' && points.length >= 2) {
        ctx.save();
        ctx.globalAlpha = overlayAlpha;
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        ctx.lineTo(points[1].x, points[1].y);
        ctx.stroke();

        ctx.fillStyle = '#10b981'; // vibrantly color anchor
        ctx.beginPath();
        ctx.arc(points[0].x, points[0].y, 4, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#3b82f6';
        ctx.beginPath();
        ctx.arc(points[1].x, points[1].y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        if (measurement.label) {
          drawLabel(measurement.label, (points[0].x + points[1].x) / 2, (points[0].y + points[1].y) / 2 - 14, '#0f172a', '#e5e7eb', 96, labelTextAlpha, labelBgAlpha);
        }
      } else if (measurement.type === 'point' && points.length >= 1) {
        const p = points[0];
        ctx.save();
        ctx.globalAlpha = overlayAlpha;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 2;
        ctx.restore();
        if (measurement.label) {
          drawLabel(measurement.label, p.x, p.y - 14, '#111827', '#e5e7eb', 96, labelTextAlpha, labelBgAlpha);
        }
      } else if (measurement.type === 'angle' && points.length >= 3) {
        ctx.save();
        ctx.globalAlpha = overlayAlpha;
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        ctx.lineTo(points[1].x, points[1].y);
        ctx.lineTo(points[2].x, points[2].y);
        ctx.stroke();
        
        points.forEach(p => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
          ctx.fill();
        });
        ctx.restore();
        if (measurement.label) {
          drawLabel(measurement.label, points[1].x, points[1].y - 16, '#111827', '#e5e7eb', 96, labelTextAlpha, labelBgAlpha);
        }
      } else if (measurement.type === 'ellipse' && points.length >= 2) {
        const cx = (points[0].x + points[1].x) / 2;
        const cy = (points[0].y + points[1].y) / 2;
        const rx = Math.abs(points[1].x - points[0].x) / 2;
        const ry = Math.abs(points[1].y - points[0].y) / 2;
        
        ctx.save();
        ctx.globalAlpha = overlayAlpha;
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      } else if (measurement.type === 'closedCurve' && points.length > 2) {
        ctx.save();
        ctx.globalAlpha = overlayAlpha;
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        points.forEach(p => ctx.lineTo(p.x, p.y));
        ctx.closePath();
        ctx.stroke();
        
        points.forEach(p => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
          ctx.fill();
        });
        ctx.restore();
      } else if (measurement.type === 'freehand' && points.length > 1) {
        ctx.save();
        ctx.globalAlpha = overlayAlpha;
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        points.forEach(p => ctx.lineTo(p.x, p.y));
        ctx.stroke();
        ctx.restore();
      }
    });

    // Draw current drawing
    if (isDrawing && drawingPoints.length > 0) {
      ctx.strokeStyle = '#60a5fa';
      ctx.fillStyle = '#60a5fa';
      ctx.lineWidth = 2;

      if (activeTool === 'distance' || activeTool === 'line' || activeTool === 'perpendicular' || activeTool === 'angle') {
        ctx.beginPath();
        ctx.moveTo(drawingPoints[0].x, drawingPoints[0].y);
        drawingPoints.forEach(p => ctx.lineTo(p.x, p.y));
        ctx.stroke();
        
        drawingPoints.forEach(p => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
          ctx.fill();
        });
      } else if (activeTool === 'ellipse' && drawingPoints.length >= 2) {
        const cx = (drawingPoints[0].x + drawingPoints[1].x) / 2;
        const cy = (drawingPoints[0].y + drawingPoints[1].y) / 2;
        const rx = Math.abs(drawingPoints[1].x - drawingPoints[0].x) / 2;
        const ry = Math.abs(drawingPoints[1].y - drawingPoints[0].y) / 2;
        
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (activeTool === 'closedCurve') {
        ctx.beginPath();
        ctx.moveTo(drawingPoints[0].x, drawingPoints[0].y);
        drawingPoints.forEach(p => ctx.lineTo(p.x, p.y));
        ctx.stroke();
        
        drawingPoints.forEach(p => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
          ctx.fill();
        });
      } else if (activeTool === 'freehand') {
        ctx.beginPath();
        ctx.moveTo(drawingPoints[0].x, drawingPoints[0].y);
        drawingPoints.forEach(p => ctx.lineTo(p.x, p.y));
        ctx.stroke();
      }
    }

    // ── Reference line (cross-plane protocol guide) ──────────────────────
    if (computedReferenceLine) {
      const rl = computedReferenceLine;
      const y = rl.cssY;

      // Only draw if within the visible canvas bounds.
      if (y >= 0 && y <= clearH) {
        ctx.save();
        // Dashed yellow line spanning the full draw width.
        ctx.setLineDash([8, 5]);
        ctx.strokeStyle = 'rgba(250, 204, 21, 0.85)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(clearW, y);
        ctx.stroke();
        ctx.setLineDash([]);

        // Label on the left side.
        const labelText = referenceLine?.label ?? 'Reference';
        const rlLabel = computedReferenceLine.isSagittal
          ? `${labelText} (click to navigate axial)`
          : labelText;

        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        const labelW = ctx.measureText(rlLabel).width + 10;

        // Background pill.
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.beginPath();
        ctx.roundRect(6, y - 6, labelW, 18, 6);
        ctx.fill();

        // Label text.
        ctx.fillStyle = '#facc15';
        ctx.fillText(rlLabel, 12, y + 6);

        // Click target indicator (small arrow or circle on the right).
        ctx.fillStyle = 'rgba(250, 204, 21, 0.6)';
        ctx.beginPath();
        ctx.arc(clearW - 16, y, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#000';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('↕', clearW - 16, y);

        ctx.restore();
      }
    }
  }, [measurements, currentSlice, isDrawing, drawingPoints, activeTool, selectedLineId, overlayTick, computedReferenceLine, referenceLine, plane]);

  // Calculate measurement value (prefer physical units mm when possible)
  const calculateMeasurementValue = (type: MeasurementTool, points: { x: number; y: number }[]): string => {
    const { width: imgW, height: imgH, spacingX: geomSpacingX, spacingY: geomSpacingY } = getPlaneGeometry();
    const spacingX = pixelSpacing && pixelSpacing.x > 0 ? pixelSpacing.x : geomSpacingX || 1;
    const spacingY = pixelSpacing && pixelSpacing.y > 0 ? pixelSpacing.y : geomSpacingY || 1;

    // The image is letterboxed / pillarboxed inside the display canvas.
    // Measurement CSS-pixel coordinates are relative to the draw area, not
    // the full display, so px↔mm conversion must use drawW / drawH.
    const dW = displaySize.width || imgW || 1;
    const dH = displaySize.height || imgH || 1;
    const physicalW = Math.max(1, imgW * spacingX);
    const physicalH = Math.max(1, imgH * spacingY);
    const fitScale = Math.min(dW / physicalW, dH / physicalH);
    const drawW = Math.max(1, Math.round(physicalW * fitScale));
    const drawH = Math.max(1, Math.round(physicalH * fitScale));

    const pxPerCssX = imgW / drawW;
    const pxPerCssY = imgH / drawH;
    // mm per CSS pixel = (image_pixels * spacing_mm_per_image_pixel) / draw_css_pixels
    const mmPerCssX = pxPerCssX * spacingX;
    const mmPerCssY = pxPerCssY * spacingY;

    if ((type === 'distance' || type === 'perpendicular' || type === 'line') && points.length === 2) {
      const dx = points[1].x - points[0].x;
      const dy = points[1].y - points[0].y;
      const dist_px = Math.sqrt((dx * pxPerCssX) ** 2 + (dy * pxPerCssY) ** 2);
      if (measurementUnits === 'px' || !Number.isFinite(dist_px)) {
        if (dist_px === 0) return '0.00 px';
        return `${dist_px.toFixed(2)} px`;
      }
      const dx_mm = dx * mmPerCssX;
      const dy_mm = dy * mmPerCssY;
      const dist_mm = Math.sqrt(dx_mm * dx_mm + dy_mm * dy_mm);
      if (dist_mm === 0) return '0.00 mm';
      return `${dist_mm.toFixed(2)} mm`;
    } else if (type === 'angle' && points.length === 3) {
      const v1 = { x: points[0].x - points[1].x, y: points[0].y - points[1].y };
      const v2 = { x: points[2].x - points[1].x, y: points[2].y - points[1].y };
      const dot = v1.x * v2.x + v1.y * v2.y;
      const mag1 = Math.sqrt(v1.x * v1.x + v1.y * v1.y);
      const mag2 = Math.sqrt(v2.x * v2.x + v2.y * v2.y);
      if (mag1 === 0 || mag2 === 0) return '0.0°';
      const angle = Math.acos(Math.max(-1, Math.min(1, dot / (mag1 * mag2)))) * (180 / Math.PI);
      return `${angle.toFixed(1)}°`;
    } else if (type === 'ellipse' && points.length === 2) {
      const rx = Math.abs(points[1].x - points[0].x) / 2;
      const ry = Math.abs(points[1].y - points[0].y) / 2;
      if (measurementUnits === 'px') {
        const area_px = Math.PI * (rx * pxPerCssX) * (ry * pxPerCssY);
        return `${area_px.toFixed(2)} px²`;
      }
      const area_css = Math.PI * rx * ry;
      const area_mm2 = area_css * mmPerCssX * mmPerCssY;
      return `${area_mm2.toFixed(2)} mm²`;
    }
    return '';
  };

  // Mouse handlers
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = overlayCanvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    if (e.button === 2) {
      e.preventDefault();
      return;
    }

    if (e.button !== 0) return;

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // ── Reference line click (cross-plane navigation) ───────────────────
    // Check BEFORE any tool-specific logic so the reference line is always
    // clickable regardless of the active tool (point, distance, select, etc.).
    if (computedReferenceLine && onReferenceLineClick) {
      const rl = computedReferenceLine;
      const distToLine = Math.abs(y - rl.cssY);
      const nearLabel = x <= 120 && Math.abs(y - rl.cssY) < 18;
      if (distToLine < 14 || nearLabel) {
        onReferenceLineClick(rl.refImgY, rl.imgH);
        // Consume the event so it doesn't also trigger a tool action.
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }

    if (activeTool === 'none') {
      // Point dragging — only in Select mode to avoid stealing clicks from
      // creation tools (distance/line/point/angle) that need to snap to
      // existing endpoints.
      for (const m of measurementsRef.current) {
        if ((m.plane ?? measurementPlane) !== measurementPlane) continue;
        if (m.points.length === 0) continue;
        for (let i = 0; i < m.points.length; i++) {
          const p = m.points[i];
          const dist = Math.sqrt((x - p.x) ** 2 + (y - p.y) ** 2);
          if (dist < 10) {
            draggingPointRef.current = { measurementId: m.id, pointIndex: i };
            setDraggingPoint({ measurementId: m.id, pointIndex: i });
            setIsDrawing(false);
            setDrawingPoints([]);
            return;
          }
        }
      }

      for (const m of measurementsRef.current) {
        if ((m.plane ?? measurementPlane) !== measurementPlane) continue;
        if (m.type !== 'perpendicular' || m.points.length < 2) continue;

        const anchor = m.points[0];
        const tip = m.points[1];
        const nearAnchor = Math.hypot(x - anchor.x, y - anchor.y) < 10;
        const nearTip = Math.hypot(x - tip.x, y - tip.y) < 10;
        const nearBody = distanceToSegment({ x, y }, anchor, tip) < 8;
        if (nearBody && !nearAnchor && !nearTip) {
          draggingPerpendicularRef.current = { measurementId: m.id, startX: x, startY: y, baseLineId: m.baseLineId };
          setIsDrawing(false);
          setDrawingPoints([]);
          return;
        }
      }

      for (const m of measurementsRef.current) {
        if ((m.plane ?? measurementPlane) !== measurementPlane) continue;
        if ((m.type !== 'distance' && m.type !== 'line') || m.points.length < 2) continue;

        const p0 = m.points[0];
        const p1 = m.points[1];
        const dx = p1.x - p0.x;
        const dy = p1.y - p0.y;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) continue;

        const t = Math.max(0, Math.min(1, ((x - p0.x) * dx + (y - p0.y) * dy) / lenSq));
        const closestX = p0.x + t * dx;
        const closestY = p0.y + t * dy;
        const dist = Math.sqrt((x - closestX) ** 2 + (y - closestY) ** 2);
        if (dist < 10) {
          const nearP0 = Math.hypot(x - p0.x, y - p0.y) < 10;
          const nearP1 = Math.hypot(x - p1.x, y - p1.y) < 10;
          setSelectedLineId(m.id);
          onMeasurementSelect?.(m.id);
          if (!nearP0 && !nearP1) {
            pendingLineDragRef.current = {
              measurementId: m.id,
              startX: x,
              startY: y,
              initialPoints: m.points.map((p) => ({ x: p.x, y: p.y })),
            };
            lineDragMovedRef.current = false;
          }
          return;
        }
      }
    }

    if (isAxial && isRotateMode) {
      startRotateDrag(e.clientX, e.clientY);
    } else if (activeTool === 'pan') {
      setIsPanning(true);
      panStartRef.current = { clientX: e.clientX, clientY: e.clientY, startX: panSrc.x, startY: panSrc.y };
    } else if (activeTool === 'perpendicular') {
      // handled in handleClick
    }
  };

  const panRafRef = useRef<number | null>(null);

  const drawPanImmediate = (newX: number, newY: number) => {
    const canvas = canvasRef.current;
    const src = sourceCanvasRef.current;
    if (!canvas || !src) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = src.width;
    const height = src.height;

    const displayW_css = canvas.width / dpr;
    const displayH_css = canvas.height / dpr;
    const { spacingX, spacingY } = getPlaneGeometry();
    const physicalW = width * spacingX;
    const physicalH = height * spacingY;
    const sx = displayW_css / physicalW || 1;
    const sy = displayH_css / physicalH || 1;
    const scale = Math.min(sx, sy);
    const drawW = Math.max(1, Math.round(physicalW * scale));
    const drawH = Math.max(1, Math.round(physicalH * scale));
    const centerX = displayW_css / 2;
    const centerY = displayH_css / 2;

    const cropW = Math.max(1, Math.floor(width / zoomScale));
    const cropH = Math.max(1, Math.floor(height / zoomScale));

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    drawTransformedImage(ctx, dpr, centerX, centerY, drawW, drawH, () => {
      ctx.drawImage(src, newX, newY, cropW, cropH, 0, 0, drawW, drawH);
    });
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = overlayCanvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    lastPointerClientRef.current = { x: e.clientX, y: e.clientY };

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const snapped = findSnapPoint(x, y);

    if (draggingPerpendicularRef.current) {
      const dragged = draggingPerpendicularRef.current;
      const targetMeasurement = measurementsRef.current.find((m) => m.id === dragged.measurementId);
      if (targetMeasurement) {
        const baseLine = targetMeasurement.baseLineId
          ? measurementsRef.current.find((m) => m.id === targetMeasurement.baseLineId)
          : null;
        if (baseLine && baseLine.points.length >= 2) {
          const p0 = baseLine.points[0];
          const p1 = baseLine.points[1];
          const dx = p1.x - p0.x;
          const dy = p1.y - p0.y;
          const len = Math.hypot(dx, dy) || 1;
          const lineX = dx / len;
          const lineY = dy / len;
          const perpX = -dy / len;
          const perpY = dx / len;
          const anchorT = ((x - p0.x) * dx + (y - p0.y) * dy) / (len * len);
          const anchorX = p0.x + dx * Math.max(0, Math.min(1, anchorT));
          const anchorY = p0.y + dy * Math.max(0, Math.min(1, anchorT));
          const stubDx = targetMeasurement.points[1].x - targetMeasurement.points[0].x;
          const stubDy = targetMeasurement.points[1].y - targetMeasurement.points[0].y;
          const stubLen = Math.max(1, Math.hypot(stubDx, stubDy));
          const sign = stubDx * perpX + stubDy * perpY >= 0 ? 1 : -1;
          {
            const pts = [
              { x: anchorX, y: anchorY },
              { x: anchorX + perpX * stubLen * sign, y: anchorY + perpY * stubLen * sign },
            ];
            const val = calculateMeasurementValue(targetMeasurement.type as MeasurementTool, pts);
            const now = Date.now();
            lastDraggedPointRef.current = { id: targetMeasurement.id, pointIndex: 0, x: pts[0].x, y: pts[0].y, ts: now };
            emitMeasurementUpdate(targetMeasurement.id, pts, val);
            dragMovedRef.current = true;
            lastDragTimestampRef.current = now;
          }
        } else {
          const dx = x - dragged.startX;
          const dy = y - dragged.startY;
          {
            const pts = targetMeasurement.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
            const val = calculateMeasurementValue(targetMeasurement.type as MeasurementTool, pts);
            const now = Date.now();
            lastDraggedPointRef.current = { id: targetMeasurement.id, pointIndex: -1, x: pts[0].x, y: pts[0].y, ts: now };
            emitMeasurementUpdate(targetMeasurement.id, pts, val);
            lastDragTimestampRef.current = now;
          }
        }
      }
      return;
    }

    if (pendingLineDragRef.current) {
      const drag = pendingLineDragRef.current;
      const dx = x - drag.startX;
      const dy = y - drag.startY;
      if (Math.abs(dx) + Math.abs(dy) > 1) {
        lineDragMovedRef.current = true;
      }
      if (lineDragMovedRef.current) {
        {
          const pts = drag.initialPoints.map((p) => ({ x: p.x + dx, y: p.y + dy }));
          const targetMeasurement = measurementsRef.current.find((m) => m.id === drag.measurementId);
          const val = targetMeasurement ? calculateMeasurementValue(targetMeasurement.type as MeasurementTool, pts) : undefined;
          const now = Date.now();
          const cx = pts.length ? ((pts[0].x ?? 0) + (pts[1]?.x ?? pts[0].x)) / 2 : pts[0]?.x ?? 0;
          const cy = pts.length ? ((pts[0].y ?? 0) + (pts[1]?.y ?? pts[0].y)) / 2 : pts[0]?.y ?? 0;
          lastDraggedPointRef.current = { id: drag.measurementId, pointIndex: -1, x: cx, y: cy, ts: now };
          emitMeasurementUpdate(drag.measurementId, pts, val);
          lastDragTimestampRef.current = now;
        }
      }
      return;
    }

    if (draggingPointRef.current) {
      const targetMeasurement = measurementsRef.current.find((m) => m.id === draggingPointRef.current!.measurementId);
      if (targetMeasurement && targetMeasurement.type === 'perpendicular' && targetMeasurement.points.length >= 2) {
        const baseLine = measurementsRef.current.find((m) => m.id === targetMeasurement.baseLineId);
        if (baseLine && baseLine.points.length >= 2) {
          const p0 = baseLine.points[0];
          const p1 = baseLine.points[1];
          const dx = p1.x - p0.x;
          const dy = p1.y - p0.y;
          const len = Math.hypot(dx, dy);
          const perpX = len > 0 ? -dy / len : 0;
          const perpY = len > 0 ? dx / len : 0;

          if (draggingPointRef.current.pointIndex === 0) {
            const t = len > 0 ? Math.max(0, Math.min(1, ((x - p0.x) * dx + (y - p0.y) * dy) / (len * len))) : 0;
            const anchorX = p0.x + t * dx;
            const anchorY = p0.y + t * dy;

            const stubDx = targetMeasurement.points[1].x - targetMeasurement.points[0].x;
            const stubDy = targetMeasurement.points[1].y - targetMeasurement.points[0].y;
            const stubLen = Math.hypot(stubDx, stubDy);
            const sign = stubDx * perpX + stubDy * perpY >= 0 ? 1 : -1;

            const pts = [
              { x: anchorX, y: anchorY },
              { x: anchorX + perpX * stubLen * sign, y: anchorY + perpY * stubLen * sign },
            ];
            const val = calculateMeasurementValue(targetMeasurement.type as MeasurementTool, pts);
            const now = Date.now();
            lastDraggedPointRef.current = { id: targetMeasurement.id, pointIndex: 0, x: pts[0].x, y: pts[0].y, ts: now };
            emitMeasurementUpdate(targetMeasurement.id, pts, val);
            dragMovedRef.current = true;
            lastDragTimestampRef.current = now;
          } else {
            const anchorX = targetMeasurement.points[0].x;
            const anchorY = targetMeasurement.points[0].y;
            const t = (x - anchorX) * perpX + (y - anchorY) * perpY;
            emitMeasurementUpdate(targetMeasurement.id, [
              { x: anchorX, y: anchorY },
              { x: anchorX + perpX * t, y: anchorY + perpY * t },
            ]);
          }
          return;
        }
      }

      const updatedMeasurements = measurementsRef.current.map((m) => {
        if (m.id !== draggingPointRef.current!.measurementId) return m;
        const newPoints = [...m.points];
        newPoints[draggingPointRef.current!.pointIndex] = findSnapPoint(x, y, m.id);
        return { ...m, points: newPoints };
      });
      const updated = updatedMeasurements.find((m) => m.id === draggingPointRef.current!.measurementId);
      if (updated) {
        {
          const val = calculateMeasurementValue(updated.type as MeasurementTool, updated.points);
          const now = Date.now();
          const dpIndex = draggingPointRef.current!.pointIndex;
          const moved = updated.points[dpIndex];
          lastDraggedPointRef.current = { id: updated.id, pointIndex: dpIndex, x: moved.x, y: moved.y, ts: now };
          emitMeasurementUpdate(updated.id, updated.points, val);
          dragMovedRef.current = true;
          lastDragTimestampRef.current = now;
        }
      }
      return;
    }

    if (activeTool === 'none') {
      const hovered = findNearbyLine(x, y);
      setHoveredLineId(hovered?.id ?? null);
    } else if (hoveredLineId) {
      setHoveredLineId(null);
    }

    if (isAxial && isRotateMode && rotateDragRef.current.dragging) {
      moveRotateDrag(e.clientX, e.clientY);
    } else if (activeTool === 'pan' && isPanning && panStartRef.current) {
      const cropW = Math.max(1, Math.floor(sliceDimsRef.current.w / zoomScale));
      const cropH = Math.max(1, Math.floor(sliceDimsRef.current.h / zoomScale));
      const displayW = displaySize.width || sliceDimsRef.current.w;
      const displayH = displaySize.height || sliceDimsRef.current.h;

      const dx = e.clientX - panStartRef.current.clientX;
      const dy = e.clientY - panStartRef.current.clientY;

      const imageDx = Math.round((dx / displayW) * cropW);
      const imageDy = Math.round((dy / displayH) * cropH);

      const newX = Math.max(0, Math.min(sliceDimsRef.current.w - cropW, panStartRef.current.startX - imageDx));
      const newY = Math.max(0, Math.min(sliceDimsRef.current.h - cropH, panStartRef.current.startY - imageDy));

      if (panRafRef.current != null) cancelAnimationFrame(panRafRef.current);
      panRafRef.current = requestAnimationFrame(() => drawPanImmediate(newX, newY));

      panSrcRef.current = { x: newX, y: newY };
      setPanSrc({ x: newX, y: newY });
    } else if (isDrawing) {
      if (activeTool === 'distance' || activeTool === 'line') {
        if (drawingPoints.length > 0) {
          setDrawingPoints([drawingPoints[0], snapped]);
        }
      } else if (activeTool === 'angle') {
        const pts = [...drawingPoints];
        if (pts.length > 0) {
          pts[pts.length - 1] = snapped;
          setDrawingPoints(pts);
        }
      }
    }
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = overlayCanvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (draggingPointRef.current) {
      const suppressed = dragMovedRef.current;
      const dpBefore = draggingPointRef.current;
      dragMovedRef.current = false;
      if (suppressed) {
        suppressClickRef.current = true;
        console.debug('[mouseup] draggingPoint suppressed -> set suppressClick', { x, y, suppressed, dpBefore, lastDragTs: lastDragTimestampRef.current, now: Date.now() });
      } else {
        console.debug('[mouseup] draggingPoint', { x, y, suppressed, dpBefore, lastDragTs: lastDragTimestampRef.current, now: Date.now() });
      }
      draggingPointRef.current = null;
      setDraggingPoint(null);
      return;
    }

    if (draggingPerpendicularRef.current) {
      const dp = draggingPerpendicularRef.current;
      const suppressed = dragMovedRef.current;
      dragMovedRef.current = false;
      if (suppressed) {
        suppressClickRef.current = true;
        console.debug('[mouseup] draggingPerpendicular suppressed -> set suppressClick', { x, y, suppressed, dp, lastDragTs: lastDragTimestampRef.current, now: Date.now() });
      } else {
        console.debug('[mouseup] draggingPerpendicular', { x, y, suppressed, dp, lastDragTs: lastDragTimestampRef.current, now: Date.now() });
      }
      draggingPerpendicularRef.current = null;
      return;
    }

    if (pendingLineDragRef.current) {
      const pending = pendingLineDragRef.current;
      const suppressed = dragMovedRef.current || lineDragMovedRef.current;
      dragMovedRef.current = false;
      if (suppressed) {
        suppressClickRef.current = true;
        console.debug('[mouseup] pendingLineDrag suppressed -> set suppressClick', { x, y, suppressed, pendingId: pending?.measurementId ?? null, lastDragTs: lastDragTimestampRef.current, now: Date.now() });
      } else {
        console.debug('[mouseup] pendingLineDrag', { x, y, suppressed, pendingId: pending?.measurementId ?? null, lastDragTs: lastDragTimestampRef.current, now: Date.now() });
      }
      pendingLineDragRef.current = null;
      lineDragMovedRef.current = false;
      return;
    }

    if (isAxial && isRotateMode && rotateDragRef.current.dragging) {
      stopRotateDrag();
    }
    if (activeTool === 'pan' && isPanning) {
      setIsPanning(false);
      panStartRef.current = null;
    }
  };

  const handleMouseLeave = () => {
    draggingPointRef.current = null;
    setDraggingPoint(null);
    draggingPerpendicularRef.current = null;
    pendingLineDragRef.current = null;
    lineDragMovedRef.current = false;
    if (isPanning) {
      setIsPanning(false);
      panStartRef.current = null;
    }
    if (isAxial && isRotateMode && rotateDragRef.current.dragging) {
      stopRotateDrag();
    }
  };

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = overlayCanvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (suppressClickRef.current) {
      // A drag just finished — suppress the synthetic click that follows.
      suppressClickRef.current = false;
      return;
    }
    // Also suppress clicks that occur very soon after a drag update (robust
    // against mouseup firing outside the canvas). If a drag moved recently,
    // ignore this click.
    const now = Date.now();
    if (now - lastDragTimestampRef.current < 350) {
      return;
    }
    // Pointer-scoped hard guard: if the pointer that generated this click
    // recently performed a drag, suppress the click to avoid races where
    // the pointerup/click happens immediately after a drag and is meant to
    // finalize it rather than create a new measurement. `lastPointerIdRef`
    // is set on pointerdown and cleared when pointer lifecycle ends.
    const pid = lastPointerIdRef.current;
    if (pid != null) {
      const pTs = recentPointerDragRef.current.get(pid) ?? 0;
      if (pTs && (now - pTs) < 1000) {
        console.debug('[suppress-click-due-to-pointer-drag]', { pointerId: pid, lastDragTs: pTs, now });
        // consume this click and clear recent record for this pointer
        recentPointerDragRef.current.delete(pid);
        return;
      }
    }
    // If the click is very close to the last point we dragged, treat it as
    // the user finalizing that drag (not intent to create a perpendicular).
    const lastDragged = lastDraggedPointRef.current;
    if (lastDragged && now - lastDragged.ts < 700) {
      const dxLast = x - lastDragged.x;
      const dyLast = y - lastDragged.y;
      const dist = Math.hypot(dxLast, dyLast);
      if (dist <= 14) {
        console.debug('[suppress-click-near-last-drag]', { click: { x, y }, lastDragged, dist, now });
        lastDraggedPointRef.current = null;
        // consume the click to avoid creating a new perpendicular.
        return;
      }
    }

    // ── Reference line click (cross-plane navigation) ───────────────────
    if (computedReferenceLine && onReferenceLineClick) {
      const rl = computedReferenceLine;
      const distToLine = Math.abs(y - rl.cssY);
      const nearLabel = x <= 120 && Math.abs(y - rl.cssY) < 18;
      if (distToLine < 14 || nearLabel) {
        onReferenceLineClick(rl.refImgY, rl.imgH);
        return;
      }
    }

    const snappedPoint = findSnapPoint(x, y);

    if (lineDragMovedRef.current) {
      lineDragMovedRef.current = false;
      return;
    }

    // Block new measurement creation when this viewport's plane doesn't
    // match the active protocol step's required plane.
    if (!allowNewMeasurements) return;

    // Allow creating a perpendicular either by using the select tool (none)
    // when clicking near a line's midpoint, or by using the perpendicular
    // tool and clicking anywhere near a line.  In select mode we also fall
    // back to spatial hit-testing so the user can click the midpoint of any
    // visible line without needing to hover or select it first.
    if (activeTool === 'none' || activeTool === 'perpendicular') {
      let targetLineId: string | null = hoveredLineId ?? selectedLineId ?? null;
      if (!targetLineId) {
        const nearby = findNearbyLine(x, y);
        targetLineId = nearby?.id ?? null;
      }

      if (targetLineId) {
        const baseLine = measurements.find((m) => m.id === targetLineId);
        if (baseLine && baseLine.points.length >= 2) {
          const p0 = baseLine.points[0];
          const p1 = baseLine.points[1];
          const midX = (p0.x + p1.x) / 2;
          const midY = (p0.y + p1.y) / 2;
          const addLabelX = midX;
          const addLabelY = midY + 14;
          const addLabelHit = x >= addLabelX - 24 && x <= addLabelX + 24 && y >= addLabelY - 10 && y <= addLabelY + 10;
          // If using select mode require a click near the midpoint for
          // unambiguous intent — but also accept clicks anywhere on a
          // hovered or selected line so users can quickly add additional
          // perpendiculars by clicking the already-selected line.
          // Only accept when explicitly in `perpendicular` tool, when the
          // click is near the midpoint (unambiguous intent), or when the
          // line is actively hovered, or when the perpendicular overlay label
          // itself is clicked. Do NOT accept solely because the
          // line is selected — selection is a passive state and leads to
          // accidental perpendicular creation during drag/selection flows.
          const accept = activeTool === 'perpendicular'
            ? true
            : (x >= midX - 12 && x <= midX + 12 && y >= midY - 12 && y <= midY + 12)
              || hoveredLineId === targetLineId
              || addLabelHit;
          
          // Defensive guard: if the same baseline was just dragged/updated
          // recently, suppress perpendicular creation to avoid the mouseup
          // / click being interpreted as intent to add a perpendicular.
          const nowGuard = Date.now();
          const lastDragged = lastDraggedPointRef.current;
          const lastBaselineTs = lastBaselineUpdateRef.current.get(targetLineId) ?? 0;
          if (accept && lastBaselineTs && (nowGuard - lastBaselineTs) < 900) {
            console.debug('[suppress-creation-due-to-recent-baseline-update-map]', { targetLineId, lastBaselineTs, now: nowGuard });
            return;
          }
          if (accept && lastDragged && lastDragged.id === targetLineId && (nowGuard - lastDragged.ts) < 900) {
            console.debug('[suppress-creation-due-to-recent-baseline-drag]', { targetLineId, lastDragged, now: nowGuard });
            return;
          }
          if (accept) {
            console.debug('[creating-perpendicular]', {
              targetLineId,
              hoveredLineId,
              selectedLineId,
              midX,
              midY,
              accept,
              now: Date.now(),
              lastDragDeltaMs: Date.now() - lastDragTimestampRef.current,
              suppressClick: suppressClickRef.current,
              draggingPointRef: draggingPointRef.current,
            });
            const dx = p1.x - p0.x;
            const dy = p1.y - p0.y;
            const len = Math.hypot(dx, dy);
            const perpX = len > 0 ? -dy / len : 0;
            const perpY = len > 0 ? dx / len : 0;
            const stubLen = 40;
            const stubPoints = [
              { x: midX, y: midY },
              { x: midX + perpX * stubLen, y: midY + perpY * stubLen },
            ];
            const stubValue = calculateMeasurementValue('perpendicular', stubPoints);
            emitMeasurementAdd({
              id: Date.now().toString(),
              type: 'perpendicular',
              points: stubPoints,
              value: stubValue,
              slice: currentSlice,
              plane: measurementPlane,
              baseLineId: targetLineId,
              groupId: baseLine.groupId,
              propagateAcrossSlices: true,
            });
            return;
          }
        }
      }
    }

    if (activeTool === 'distance' || activeTool === 'line') {
      if (!isDrawing) {
        setIsDrawing(true);
        // Snap the first anchor when it lands on an existing endpoint so
        // chaining lines from endpoints works naturally.
        setDrawingPoints([snappedPoint]);
      } else {
        const points = [...drawingPoints, snappedPoint];
        const value = calculateMeasurementValue('distance', points);
        // clear drawing state immediately to avoid rendering a transient
        // stray point while we commit the new measurement
        setIsDrawing(false);
        setDrawingPoints([]);
        const newMeasurement = {
          id: Date.now().toString(),
          type: activeTool,
          points,
          slice: currentSlice,
          plane: measurementPlane,
          value,
        } as Measurement;
        emitMeasurementAdd(newMeasurement);
        // select the newly created measurement so immediate drags hit it
        setSelectedLineId(newMeasurement.id);
        onMeasurementSelect?.(newMeasurement.id);
      }
    } else if (activeTool === 'point') {
      emitMeasurementAdd({
        id: Date.now().toString(),
        type: 'point',
        points: [snappedPoint],
        slice: currentSlice,
        plane: measurementPlane,
      });
    } else if (activeTool === 'angle') {
      if (!isDrawing) {
        setIsDrawing(true);
        setDrawingPoints([snappedPoint]);
      } else if (drawingPoints.length === 1) {
        setDrawingPoints(prev => [...prev, snappedPoint]);
      } else if (drawingPoints.length === 2) {
        const points = [...drawingPoints, snappedPoint];
        const value = calculateMeasurementValue('angle', points);
        emitMeasurementAdd({
          id: Date.now().toString(),
          type: 'angle',
          points,
          slice: currentSlice,
          plane: measurementPlane,
          value,
        });
        setIsDrawing(false);
        setDrawingPoints([]);
      }
    } else if (activeTool === 'closedCurve' && isDrawing) {
      const firstPoint = drawingPoints[0];
      const dist = Math.sqrt((x - firstPoint.x) ** 2 + (y - firstPoint.y) ** 2);
      
      if (dist < 10 && drawingPoints.length > 2) {
        // Close the curve
        emitMeasurementAdd({
          id: Date.now().toString(),
          type: 'closedCurve',
          points: drawingPoints,
          slice: currentSlice,
          plane: measurementPlane,
        });
        setIsDrawing(false);
        setDrawingPoints([]);
      } else {
        setDrawingPoints(prev => [...prev, { x, y }]);
      }
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (isZoomMode) {
      applyWheelZoomAtPointer(e.clientX, e.clientY, e.deltaY, e.deltaMode);
      return;
    }
    const delta = e.deltaY > 0 ? 1 : -1;
    const maxSlice = plane === 'axial' ? header.dims[3] : plane === 'sagittal' ? header.dims[1] : header.dims[2];
    const newSlice = Math.max(0, Math.min(maxSlice - 1, currentSlice + delta));
    onSliceChange(newSlice);
  };

  // When entering pan mode, only clamp pan to valid range (do not reset zoom).
  useEffect(() => {
    if (activeTool !== 'pan') return;

    const dims = sliceDimsRef.current;
    const w = Math.max(1, dims.w || 1);
    const h = Math.max(1, dims.h || 1);
    setPanSrc(prev => ({
      x: Math.max(0, Math.min(w - 1, prev.x)),
      y: Math.max(0, Math.min(h - 1, prev.y)),
    }));
  }, [activeTool]);

  const dims = header.dims;
  const maxSlice = plane === 'axial' ? dims[3] : plane === 'sagittal' ? dims[1] : dims[2];

  const { width: imgW, height: imgH } = getSliceData();
  const displayW = displaySize.width || imgW;
  const displayH = displaySize.height || imgH;

  return (
    <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden flex flex-col h-full w-full min-h-0">
      {/* Docked toolbar — does not overlap the image canvas; wraps when multiple viewers are narrow */}
      <div className="shrink-0 border-b border-gray-800 bg-gray-950 px-1.5 py-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 justify-between w-full min-w-0">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0 min-w-0 text-[10px] leading-tight text-gray-300">
            <span className="font-semibold capitalize text-gray-100 shrink-0">{planeLabel ?? plane}</span>
            <span className="text-gray-600 shrink-0" aria-hidden>
              |
            </span>
            <span className="tabular-nums shrink-0 whitespace-nowrap">
              Sl {currentSlice + 1}/{maxSlice}
            </span>
            <span className="text-gray-600 shrink-0" aria-hidden>
              |
            </span>
            <span className="tabular-nums shrink-0 whitespace-nowrap" title="Window width / window center (this viewer)">
              WW {Math.round(wl.window)} · WC {Math.round(wl.level)}
            </span>
            <span className="text-gray-600 shrink-0" aria-hidden>
              |
            </span>
            <span className="tabular-nums shrink-0 whitespace-nowrap text-gray-200" title="Brightness (this viewer only)">
              Br {Math.round(brightness * 100)}%
            </span>
            <span className="text-gray-600 shrink-0" aria-hidden>
              |
            </span>
            <span className="tabular-nums shrink-0 whitespace-nowrap text-gray-200" title="Zoom scale (this viewer only)">
              Z {Math.round(zoomScale * 100)}%
            </span>
            <span className="text-gray-600 shrink-0" aria-hidden>
              |
            </span>
            {(() => {
              const { spacingX: gsx, spacingY: gsy } = getPlaneGeometry();
              const sx = (pixelSpacing && pixelSpacing.x > 0 ? pixelSpacing.x : gsx) || 1;
              const sy = (pixelSpacing && pixelSpacing.y > 0 ? pixelSpacing.y : gsy) || 1;
              const isFallback = (!pixelSpacing || pixelSpacing.x <= 0 || pixelSpacing.y <= 0) &&
                (gsx === 1 || gsy === 1);
              return (
                <span
                  className={`tabular-nums shrink-0 whitespace-nowrap ${isFallback ? 'text-amber-400' : 'text-gray-400'}`}
                  title={`Pixel spacing: ${sx.toFixed(3)} × ${sy.toFixed(3)} mm/pixel${isFallback ? ' (FALLBACK — measurements approximate)' : ''}`}
                >
                  {sx.toFixed(2)}×{sy.toFixed(2)} mm/px
                </span>
              );
            })()}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-0.5 shrink-0">
            <button
              type="button"
              className={`px-1.5 py-0.5 rounded border text-[10px] ${
                isWlMode
                  ? 'bg-amber-600 border-amber-500 text-white'
                  : 'bg-gray-800 border-gray-700 text-gray-200 hover:bg-gray-700'
              }`}
              onClick={(e) => {
                e.stopPropagation();
                setIsWlMode((v) => {
                  const next = !v;
                  if (next) dismissCanvasToolModes();
                  return next;
                });
              }}
              title="Window level (center) — slider (this viewer only)"
              aria-expanded={isWlMode}
            >
              WL
            </button>
            <button
              type="button"
              className={`px-1.5 py-0.5 rounded border text-[10px] ${
                isWwMode
                  ? 'bg-amber-600 border-amber-500 text-white'
                  : 'bg-gray-800 border-gray-700 text-gray-200 hover:bg-gray-700'
              }`}
              onClick={(e) => {
                e.stopPropagation();
                setIsWwMode((v) => {
                  const next = !v;
                  if (next) dismissCanvasToolModes();
                  return next;
                });
              }}
              title="Window width — slider (this viewer only)"
              aria-expanded={isWwMode}
            >
              WW
            </button>
            <button
              type="button"
              className={`px-1.5 py-0.5 rounded border text-[10px] ${
                isBrightnessMode
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-gray-800 border-gray-700 text-gray-200 hover:bg-gray-700'
              }`}
              onClick={(e) => {
                e.stopPropagation();
                setIsBrightnessMode((v) => {
                  const next = !v;
                  if (next) dismissCanvasToolModes();
                  return next;
                });
              }}
              title="Brightness gain (this viewer only)"
              aria-expanded={isBrightnessMode}
            >
              Bright
            </button>
            <button
              type="button"
              className="px-1.5 py-0.5 rounded bg-gray-800 border border-gray-700 hover:bg-gray-700 text-[10px] text-gray-100"
              onClick={(e) => {
                e.stopPropagation();
                handleViewerReset();
              }}
              title="Reset viewer to state right after this sequence was loaded (zoom, pan, WL, brightness, slice, in-view marks)"
            >
              Reset
            </button>
            {onClose ? (
              <button
                type="button"
                className="px-1.5 py-0.5 rounded bg-gray-800 border border-red-900/60 text-red-300 hover:bg-red-950/40 text-[10px]"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose();
                }}
                title="Close this viewer"
              >
                Close
              </button>
            ) : null}
            {isAxial ? (
              <>
                <span className="text-gray-600 px-0.5" aria-hidden>
                  |
                </span>
                <button
                  type="button"
                  className={`px-1.5 py-0.5 rounded border text-[10px] ${
                    isRotateMode
                      ? 'bg-blue-600 border-blue-500 text-white'
                      : 'bg-gray-800 border-gray-700 text-gray-200 hover:bg-gray-700'
                  }`}
                  onClick={() => {
                    setIsRotateMode((v) => {
                      const next = !v;
                      if (next) dismissCanvasToolModes();
                      return next;
                    });
                    stopRotateDrag();
                  }}
                  title="Rotate (axial)"
                >
                  Rot
                </button>
                <button
                  type="button"
                  className="px-1.5 py-0.5 rounded bg-gray-800 border border-gray-700 hover:bg-gray-700 text-[10px] text-gray-200"
                  onClick={() => setAxialTransform({ rotation: 0 })}
                  title="Rotation 0°"
                >
                  0°
                </button>
              </>
            ) : null}
          </div>
        </div>
        {(isWlMode || isWwMode || isBrightnessMode) && (
          <div
            className="mt-0.5 space-y-0.5 min-w-0 border-t border-gray-800/80 pt-0.5"
            onMouseDown={(e) => e.stopPropagation()}
          >
            {isWlMode ? (
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-[10px] text-gray-500 shrink-0 w-[4.5rem]" title="Window center (this viewer)">
                  WL {Math.round(wl.level)}
                </span>
                <Slider
                  className="min-w-0 flex-1 max-w-[10rem] sm:max-w-[14rem] h-4"
                  min={WL_MIN_CENTER}
                  max={WL_MAX_CENTER}
                  step={1}
                  value={[wl.level]}
                  onValueChange={(v) => {
                    const level = v[0] ?? wl.level;
                    setWlSafe((prev) => ({ ...prev, level }));
                  }}
                  aria-label="Window level"
                />
              </div>
            ) : null}
            {isWwMode ? (
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-[10px] text-gray-500 shrink-0 w-[4.5rem]" title="Window width (this viewer)">
                  WW {Math.round(wl.window)}
                </span>
                <Slider
                  className="min-w-0 flex-1 max-w-[10rem] sm:max-w-[14rem] h-4"
                  min={WL_MIN_WIDTH}
                  max={WL_MAX_WIDTH}
                  step={1}
                  value={[wl.window]}
                  onValueChange={(v) => {
                    const window = v[0] ?? wl.window;
                    setWlSafe((prev) => ({ ...prev, window }));
                  }}
                  aria-label="Window width"
                />
              </div>
            ) : null}
            {isBrightnessMode ? (
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-[10px] text-gray-500 shrink-0 w-[4.5rem]" title="Brightness (this viewer only)">
                  Bright
                </span>
                <Slider
                  className="min-w-0 flex-1 max-w-[10rem] sm:max-w-[14rem] h-4"
                  min={0.25}
                  max={2.5}
                  step={0.02}
                  value={[brightness]}
                  onValueChange={(v) => setBrightness(v[0] ?? 1)}
                  aria-label="Viewer brightness"
                />
              </div>
            ) : null}
          </div>
        )}
      </div>

      <div ref={containerRef} className="flex-1 flex items-center justify-center p-2 overflow-auto min-h-0">
        <div
          className="relative flex items-center justify-center w-full h-full"
          style={{ overflow: 'visible' }}
        >
          <div className="flex items-center" style={{ width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
            <div className="relative" style={{ width: `${displayW}px`, height: `${displayH}px` }}>
              <canvas
                ref={canvasRef}
                className="absolute inset-0 w-full h-full"
                style={{ imageRendering: 'auto' }}
              />
              <canvas
                ref={overlayCanvasRef}
                className="absolute inset-0 w-full h-full"
                style={{
                  cursor: isAxial && isRotateMode
                        ? 'ew-resize'
                        : activeTool === 'pan'
                          ? (isPanning ? 'grabbing' : 'grab')
                          : 'crosshair',
                }}
                onPointerDown={(e) => {
                  overlayCanvasRef.current?.setPointerCapture(e.pointerId);
                  lastPointerIdRef.current = e.pointerId;
                  pointerActionRef.current.set(e.pointerId, { last: 'down', ts: Date.now() });
                  handleMouseDown(e as any as React.MouseEvent<HTMLCanvasElement>);
                }}
                onPointerMove={(e) => {
                  const isDragging = !!(draggingPointRef.current || pendingLineDragRef.current || draggingPerpendicularRef.current || dragMovedRef.current || lineDragMovedRef.current);
                  if (isDragging) {
                    pointerActionRef.current.set(e.pointerId, { last: 'drag', ts: Date.now() });
                  } else {
                    pointerActionRef.current.set(e.pointerId, { last: 'move', ts: Date.now() });
                  }
                  handleMouseMove(e as any as React.MouseEvent<HTMLCanvasElement>);
                }}
                onPointerUp={(e) => {
                  try { overlayCanvasRef.current?.releasePointerCapture(e.pointerId); } catch (_) {}
                  const pa = pointerActionRef.current.get(e.pointerId);
                  if (pa && pa.last === 'drag') {
                    recentPointerDragRef.current.set(e.pointerId, Date.now());
                  }
                  pointerActionRef.current.set(e.pointerId, { last: 'up', ts: Date.now() });
                  handleMouseUp(e as any as React.MouseEvent<HTMLCanvasElement>);
                }}
                onPointerLeave={(e) => {
                  handleMouseLeave();
                }}
                onClick={(e) => {
                  handleClick(e as any as React.MouseEvent<HTMLCanvasElement>);
                }}
                onWheel={handleWheel}
                onContextMenu={(ev) => ev.preventDefault()}
              />
            </div>

            {/* Vertical slice slider in the non-image area to the right */}
            <div ref={sliderRef} className="ml-4 flex flex-col items-center" style={{ height: `${displayH}px`, minHeight: '56px' }}>
              <div className="text-xs text-gray-200 mb-2">{currentSlice + 1}</div>
              <div className="h-full flex items-center">
                <Slider
                  orientation="vertical"
                  value={[currentSlice]}
                  onValueChange={(arr) => onSliceChange(arr[0])}
                  min={0}
                  max={Math.max(0, maxSlice - 1)}
                  step={1}
                  className="h-full"
                />
              </div>
              <div className="text-xs text-gray-200 mt-2">{maxSlice}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}