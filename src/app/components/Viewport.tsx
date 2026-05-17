import { useRef, useEffect, useState, useCallback } from 'react';
import type { WindowLevel, MeasurementTool, Measurement } from './MedicalImageViewer';
import { Slider } from './ui/slider';

const WL_MIN_WIDTH = 8;
const WL_MAX_WIDTH = 255;
const WL_MIN_CENTER = 0;
const WL_MAX_CENTER = 255;

/** Clamp WW/WL to display-space limits (normalized 0–255 pixels). */
function sanitizeWindowLevel(
  windowWidth: number,
  windowCenter: number,
  fallback: WindowLevel,
): WindowLevel {
  let ww = Math.round(windowWidth);
  let wc = Math.round(windowCenter);
  if (!Number.isFinite(ww) || !Number.isFinite(wc)) return { ...fallback };
  ww = Math.max(WL_MIN_WIDTH, Math.min(WL_MAX_WIDTH, ww));
  wc = Math.max(WL_MIN_CENTER, Math.min(WL_MAX_CENTER, wc));
  if (wc + ww / 2 <= wc - ww / 2) return { ...fallback };
  return { window: ww, level: wc };
}

const VIEWPORT_ZOOM_MIN = 1;
const VIEWPORT_ZOOM_MAX = 20;
const VIEWPORT_ZOOM_STEP = 1.18;
const VIEWPORT_ZOOM_ANIM_MS = 140;

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
  applyWeighting: (pixelValue: number) => number;
  showCrosshair?: boolean;
  parentWindowHeight?: number;
  /** Restore upload defaults for this viewer only (slice/WL/measurements handled in parent). */
  onViewportReset?: () => void;
  /** Multi-viewer: hide this viewer (same as window chrome close). */
  onClose?: () => void;
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
  applyWeighting,
  showCrosshair = false,
  parentWindowHeight,
  onViewportReset,
  onClose,
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
  // for debugging: container rect seen by ResizeObserver
  const [containerRect, setContainerRect] = useState({ width: 0, height: 0 });
  const [ancestorRects, setAncestorRects] = useState<{ parent: { width: number; height: number } | null; grandParent: { width: number; height: number } | null }>({ parent: null, grandParent: null });
  const sliderRef = useRef<HTMLDivElement | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawingPoints, setDrawingPoints] = useState<{ x: number; y: number }[]>([]);

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
      // Horizontal = x (same as axial width). Vertical = through-plane (z). Using true dz here
      // often stretches anatomy because slice spacing ≫ in-plane spacing; match in-plane pitch so
      // MPR matches the familiar 512×512-style square voxels on screen.
      spacingX = p1;
      spacingY = dInPlane;
    } else {
      // sagittal: horizontal = y, vertical = z
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
      // store rect for debugging
      setContainerRect({ width: Math.round(rect.width), height: Math.round(rect.height) });

      // also capture parent chain sizes to find where height is constrained
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

      // Compute available size from the container rect (for floating windows this avoids using the full window size)
      let sliderWidth = 0;
      let sliderMarginLeft = 0;
      const sliderEl = sliderRef.current;
      if (sliderEl) {
        const sRect = sliderEl.getBoundingClientRect();
        sliderWidth = Math.round(sRect.width);
        const sStyle = window.getComputedStyle(sliderEl);
        sliderMarginLeft = parseFloat(sStyle.marginLeft || '0') || 0;
      }

      // Rebuilt fit algorithm (aspect-preserving, deterministic)
      const paddingBuffer = 8;
      const { width: imgW, height: imgH, spacingX, spacingY } = getPlaneGeometry();
      const physicalW = imgW * spacingX;
      const physicalH = imgH * spacingY;

      // Available area inside the container (subtract slider if present)
      const availW = Math.max(1, rect.width - sliderWidth - sliderMarginLeft - paddingBuffer * 2);
      const availH = Math.max(1, rect.height - paddingBuffer * 2);

      // If image has invalid dimensions, fallback to small default
      const safeImgW = Math.max(1, imgW || 1);
      const safeImgH = Math.max(1, imgH || 1);

      // Compute scale so image fits into the available area using the smaller dimension
      // (allow upscaling so the image can fill the smaller container dimension)
      const safePhysicalW = Math.max(1, physicalW || 1);
      const safePhysicalH = Math.max(1, physicalH || 1);
      const scale = Math.min(availW / safePhysicalW, availH / safePhysicalH);
      const computedW = Math.max(1, Math.round(safePhysicalW * scale));
      const computedH = Math.max(1, Math.round(safePhysicalH * scale));

      // Enforce sensible min / max so the wrapper never collapses
      const MIN_DISPLAY = 48; // absolute lower bound
      const maxW = Math.max(MIN_DISPLAY, Math.round(rect.width - paddingBuffer * 2));
      const maxH = Math.max(MIN_DISPLAY, Math.round(rect.height - paddingBuffer * 2));

      const finalW = Math.max(MIN_DISPLAY, Math.min(maxW, Math.round(computedW)));
      const finalH = Math.max(MIN_DISPLAY, Math.min(maxH, Math.round(computedH)));

      // Adaptive hysteresis based on the container size to avoid micro updates
      const deltaW = Math.max(2, Math.round(rect.width * 0.005));
      const deltaH = Math.max(2, Math.round(rect.height * 0.005));
      if (Math.abs(displaySizeRef.current.width - finalW) < deltaW && Math.abs(displaySizeRef.current.height - finalH) < deltaH) {
        return;
      }

      // Debug trace (left intentionally minimal)
      console.debug('fit', { rectW: rect.width, rectH: rect.height, availW, availH, imgW: safeImgW, imgH: safeImgH, physicalW: safePhysicalW, physicalH: safePhysicalH, finalW, finalH });

      displaySizeRef.current = { width: finalW, height: finalH };
      setDisplaySize({ width: finalW, height: finalH });
    };

    // Debounced ResizeObserver + rAF to avoid reacting to rapid micro-changes
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
    // use capture to catch scrolls from ancestors
    window.addEventListener('scroll', onScroll, true);

    // run once immediately
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

  /** Wheel zoom (unchanged behavior): only when Zoom mode is on; focal = pointer. */
  const applyWheelZoomAtPointer = useCallback(
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
    },
    [applyZoomAtImageFocal, cancelZoomAnimation, clientToImagePixel, getViewportCenterImagePixel],
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
        // draw full image centered and scaled
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
      if (measurement.slice !== currentSlice) return;

      ctx.strokeStyle = '#3b82f6';
      ctx.fillStyle = '#3b82f6';
      ctx.lineWidth = 2;

      const points = measurement.points;

      if ((measurement.type === 'distance' || measurement.type === 'line') && points.length >= 2) {
        if (measurement.type === 'line') {
          // Visualize the line as extending across the canvas to make tangent
          // placement obvious.
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
        ctx.stroke();

        points.forEach(p => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
          ctx.fill();
        });
      } else if (measurement.type === 'point' && points.length >= 1) {
        const p = points[0];
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
      } else if (measurement.type === 'angle' && points.length >= 3) {
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
      } else if (measurement.type === 'ellipse' && points.length >= 2) {
        const cx = (points[0].x + points[1].x) / 2;
        const cy = (points[0].y + points[1].y) / 2;
        const rx = Math.abs(points[1].x - points[0].x) / 2;
        const ry = Math.abs(points[1].y - points[0].y) / 2;
        
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (measurement.type === 'closedCurve' && points.length > 2) {
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
      } else if (measurement.type === 'freehand' && points.length > 1) {
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        points.forEach(p => ctx.lineTo(p.x, p.y));
        ctx.stroke();
      }
    });

    // Draw current drawing
    if (isDrawing && drawingPoints.length > 0) {
      ctx.strokeStyle = '#60a5fa';
      ctx.fillStyle = '#60a5fa';
      ctx.lineWidth = 2;

      if (activeTool === 'distance' || activeTool === 'line' || activeTool === 'angle') {
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
  }, [measurements, currentSlice, isDrawing, drawingPoints, activeTool]);

  // Calculate measurement value
  const calculateMeasurementValue = (type: MeasurementTool, points: { x: number; y: number }[]): string => {
    if (type === 'distance' && points.length === 2) {
      const dx = points[1].x - points[0].x;
      const dy = points[1].y - points[0].y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      return `${dist.toFixed(2)} px`;
    } else if (type === 'angle' && points.length === 3) {
      const v1 = { x: points[0].x - points[1].x, y: points[0].y - points[1].y };
      const v2 = { x: points[2].x - points[1].x, y: points[2].y - points[1].y };
      const dot = v1.x * v2.x + v1.y * v2.y;
      const mag1 = Math.sqrt(v1.x * v1.x + v1.y * v1.y);
      const mag2 = Math.sqrt(v2.x * v2.x + v2.y * v2.y);
      const angle = Math.acos(dot / (mag1 * mag2)) * (180 / Math.PI);
      return `${angle.toFixed(1)}°`;
    } else if (type === 'ellipse' && points.length === 2) {
      const rx = Math.abs(points[1].x - points[0].x) / 2;
      const ry = Math.abs(points[1].y - points[0].y) / 2;
      const area = Math.PI * rx * ry;
      return `${area.toFixed(2)} px²`;
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

    if (isAxial && isRotateMode) {
      startRotateDrag(e.clientX, e.clientY);
    } else if (activeTool === 'pan') {
      setIsPanning(true);
      panStartRef.current = { clientX: e.clientX, clientY: e.clientY, startX: panSrc.x, startY: panSrc.y };
    } else if (activeTool === 'point') {
      // Single-click point primitive — emit immediately, no drag phase.
      onMeasurementAdd({
        id: Date.now().toString(),
        type: 'point',
        points: [{ x, y }],
        slice: currentSlice,
        plane: measurementPlane,
      });
    } else {
      setIsDrawing(true);
      setDrawingPoints([{ x, y }]);
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

    // clear then draw
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

    if (isAxial && isRotateMode && rotateDragRef.current.dragging) {
      moveRotateDrag(e.clientX, e.clientY);
    } else if (activeTool === 'pan' && isPanning && panStartRef.current) {
      // Calculate image crop size
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

      // Immediate visual update via rAF draw
      if (panRafRef.current != null) cancelAnimationFrame(panRafRef.current);
      panRafRef.current = requestAnimationFrame(() => drawPanImmediate(newX, newY));

      // Still update state for persistence and other effects
      panSrcRef.current = { x: newX, y: newY };
      setPanSrc({ x: newX, y: newY });
    } else if (isDrawing) {
      if (activeTool === 'freehand') {
        setDrawingPoints(prev => [...prev, { x, y }]);
      } else if (
        activeTool === 'ellipse' ||
        ((activeTool === 'distance' || activeTool === 'line') && drawingPoints.length === 1)
      ) {
        setDrawingPoints([drawingPoints[0], { x, y }]);
      }
    }
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = overlayCanvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (isAxial && isRotateMode && rotateDragRef.current.dragging) {
      stopRotateDrag();
    }
    if (activeTool === 'pan' && isPanning) {
      setIsPanning(false);
      panStartRef.current = null;
    } else if (isDrawing) {
      if (activeTool === 'distance' || activeTool === 'line') {
        if (drawingPoints.length === 1) {
          const points = [...drawingPoints, { x, y }];
          const value = calculateMeasurementValue('distance', points);
          onMeasurementAdd({
            id: Date.now().toString(),
            type: activeTool,
            points,
            slice: currentSlice,
            plane: measurementPlane,
            value,
          });
          setIsDrawing(false);
          setDrawingPoints([]);
        }
      } else if (activeTool === 'angle') {
        if (drawingPoints.length < 3) {
          setDrawingPoints(prev => [...prev, { x, y }]);
        }
        if (drawingPoints.length === 2) {
          const points = [...drawingPoints, { x, y }];
          const value = calculateMeasurementValue('angle', points);
          onMeasurementAdd({
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
      } else if (activeTool === 'ellipse') {
        const points = [drawingPoints[0], { x, y }];
        const value = calculateMeasurementValue('ellipse', points);
        onMeasurementAdd({
          id: Date.now().toString(),
          type: 'ellipse',
          points,
          slice: currentSlice,
          plane: measurementPlane,
          value,
        });
        setIsDrawing(false);
        setDrawingPoints([]);
      } else if (activeTool === 'freehand') {
        if (drawingPoints.length > 1) {
          onMeasurementAdd({
            id: Date.now().toString(),
            type: 'freehand',
            points: drawingPoints,
            slice: currentSlice,
            plane: measurementPlane,
          });
        }
        setIsDrawing(false);
        setDrawingPoints([]);
      }
    }
  };

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (activeTool === 'closedCurve' && isDrawing) {
      const rect = overlayCanvasRef.current?.getBoundingClientRect();
      if (!rect) return;

      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // Check if clicking near first point to close
      const firstPoint = drawingPoints[0];
      const dist = Math.sqrt((x - firstPoint.x) ** 2 + (y - firstPoint.y) ** 2);
      
      if (dist < 10 && drawingPoints.length > 2) {
        // Close the curve
        onMeasurementAdd({
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

  // Ensure we have sensible display sizes so the wrapper takes space in the layout
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
              className={`px-1.5 py-0.5 rounded border text-[10px] ${
                isZoomMode
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-gray-800 border-gray-700 text-gray-200 hover:bg-gray-700'
              }`}
              onClick={(e) => {
                e.stopPropagation();
                setIsZoomMode((v) => {
                  const next = !v;
                  if (next) dismissCanvasToolModes();
                  return next;
                });
              }}
              title="Zoom: wheel zooms toward cursor; use +/− for trackpad (this viewer only)"
              aria-expanded={isZoomMode}
            >
              Zoom{isZoomMode ? ' ▼' : ''}
            </button>
            {isZoomMode ? (
              <>
                <button
                  type="button"
                  className="min-w-[1.35rem] px-1 py-0.5 rounded border text-[11px] font-semibold leading-none bg-gray-800 border-gray-700 text-gray-100 hover:bg-gray-700 disabled:opacity-35 disabled:pointer-events-none"
                  disabled={zoomScale >= VIEWPORT_ZOOM_MAX - 0.02}
                  onClick={(e) => {
                    e.stopPropagation();
                    zoomInStep();
                  }}
                  title="Zoom in (viewport center)"
                  aria-label="Zoom in"
                >
                  +
                </button>
                <button
                  type="button"
                  className="min-w-[1.35rem] px-1 py-0.5 rounded border text-[11px] font-semibold leading-none bg-gray-800 border-gray-700 text-gray-100 hover:bg-gray-700 disabled:opacity-35 disabled:pointer-events-none"
                  disabled={zoomScale <= VIEWPORT_ZOOM_MIN + 0.02}
                  onClick={(e) => {
                    e.stopPropagation();
                    zoomOutStep();
                  }}
                  title="Zoom out (viewport center)"
                  aria-label="Zoom out"
                >
                  −
                </button>
              </>
            ) : null}
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
                  cursor: isZoomMode
                      ? 'zoom-in'
                      : isAxial && isRotateMode
                        ? 'ew-resize'
                        : activeTool === 'pan'
                          ? (isPanning ? 'grabbing' : 'grab')
                          : 'crosshair',
                }}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onClick={handleClick}
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
