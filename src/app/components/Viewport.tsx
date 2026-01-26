import { useRef, useEffect, useState, useCallback } from 'react';
import type { WindowLevel, MeasurementTool, Measurement } from './MedicalImageViewer';
import { Slider } from '@/app/components/ui/slider';

interface ViewportProps {
  imageData: Uint8Array;
  header: any;
  plane: 'axial' | 'sagittal' | 'coronal';
  currentSlice: number;
  onSliceChange: (slice: number) => void;
  windowLevel: WindowLevel;
  onWindowLevelChange: (wl: WindowLevel) => void;
  activeTool: MeasurementTool;
  measurements: Measurement[];
  onMeasurementAdd: (measurement: Measurement) => void;
  applyWeighting: (pixelValue: number) => number;
  showCrosshair?: boolean;
}

export function Viewport({
  imageData,
  header,
  plane,
  currentSlice,
  onSliceChange,
  windowLevel,
  onWindowLevelChange,
  activeTool,
  measurements,
  onMeasurementAdd,
  applyWeighting,
  showCrosshair = false,
}: ViewportProps) {
  const [autoFlash, setAutoFlash] = useState<{ window: number; level: number } | null>(null);

  useEffect(() => {
    if (!windowLevel) return;
    setAutoFlash({ window: Math.round(windowLevel.window), level: Math.round(windowLevel.level) });
    const id = setTimeout(() => setAutoFlash(null), 1200);
    return () => clearTimeout(id);
  }, [windowLevel]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  // container for responsive sizing
  const containerRef = useRef<HTMLDivElement>(null);
  const [displaySize, setDisplaySize] = useState({ width: 0, height: 0 });
  // for debugging: container rect seen by ResizeObserver
  const [containerRect, setContainerRect] = useState({ width: 0, height: 0 });
  const [ancestorRects, setAncestorRects] = useState<{ parent: { width: number; height: number } | null; grandParent: { width: number; height: number } | null }>({ parent: null, grandParent: null });
  const sliderRef = useRef<HTMLDivElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawingPoints, setDrawingPoints] = useState<{ x: number; y: number }[]>([]);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);



  // Get slice data based on orientation
  const getSliceData = useCallback(() => {
    const dims = header.dims;
    const width = plane === 'sagittal' ? dims[2] : dims[1];
    const height = plane === 'axial' ? dims[2] : dims[3];
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
  }, [imageData, header, plane, currentSlice]);

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

      // Compute available size from window and subtract left/right panels and header to avoid feedback loops
      const leftPanel = document.querySelector('.w-60') as HTMLElement | null;
      const rightPanel = document.querySelector('.w-72') as HTMLElement | null;
      const headerEl = document.querySelector('header') as HTMLElement | null;

      const leftW = leftPanel ? Math.round(leftPanel.getBoundingClientRect().width) : 0;
      const rightW = rightPanel ? Math.round(rightPanel.getBoundingClientRect().width) : 0;
      const headerH = headerEl ? Math.round(headerEl.getBoundingClientRect().height) : 0;

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
      const availW = Math.max(1, window.innerWidth - leftW - rightW - sliderWidth - sliderMarginLeft - paddingBuffer * 2);
      const availH = Math.max(1, window.innerHeight - headerH - paddingBuffer * 2);

      const { width: imgW, height: imgH } = getSliceData();

      let dw = Math.max(1, Math.round(availW));
      let dh = Math.max(1, Math.round(availH));

      // Fit-only: scale image to fit inside available width/height
      {
        const sx = availW / imgW || 1;
        const sy = availH / imgH || 1;
        const scale = Math.min(sx, sy);
        dw = Math.max(1, Math.round(imgW * scale));
        dh = Math.max(1, Math.round(imgH * scale));
      }

      // Avoid tiny oscillations: only update if size changed by at least 1px
      if (Math.abs(displaySize.width - Math.round(dw)) < 1 && Math.abs(displaySize.height - Math.round(dh)) < 1) {
        return;
      }

      // log details for debugging
      console.debug('avail', availW, availH, 'panels', leftW, rightW, 'slider', sliderWidth, 'img', imgW, imgH, 'display', dw, dh);

      setDisplaySize({ width: Math.round(dw), height: Math.round(dh) });
    };

    const ro = new ResizeObserver(() => update());
    ro.observe(container);
    window.addEventListener('resize', update);
    // use capture to catch scrolls from ancestors
    window.addEventListener('scroll', update, true);
    update();
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [getSliceData, displaySize]);

  // Apply window/level and weighting to image
  const applyWindowLevel = useCallback((value: number): number => {
    // Apply weighting first
    const weighted = applyWeighting(value);
    
    // Then apply window/level
    const { window, level } = windowLevel;
    const min = level - window / 2;
    const max = level + window / 2;
    
    if (weighted <= min) return 0;
    if (weighted >= max) return 255;
    
    return Math.round(((weighted - min) / window) * 255);
  }, [windowLevel, applyWeighting]);

  // Render image (draw scaled to the target display size using ImageBitmap)
  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    const overlay = overlayCanvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    (async () => {
      const { sliceData, width, height } = getSliceData();

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
      try {
        const bitmap = await createImageBitmap(imgData);
        if (cancelled) {
          bitmap.close?.();
          return;
        }

        // Draw bitmap stretched to full backing pixels
        // Use identity transform since we're drawing into the full backing size
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close?.();
      } catch (err) {
        // Fallback to putImageData if createImageBitmap isn't available
        const fallbackCtx = ctx;
        fallbackCtx.setTransform(1, 0, 0, 1, 0, 0);
        fallbackCtx.clearRect(0, 0, canvas.width, canvas.height);
        // draw at top-left; it will be scaled by CSS
        fallbackCtx.putImageData(imgData, 0, 0);
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
  }, [imageData, currentSlice, plane, windowLevel, applyWindowLevel, getSliceData, displaySize]);

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

      if (measurement.type === 'distance' && points.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        ctx.lineTo(points[1].x, points[1].y);
        ctx.stroke();
        
        // Draw endpoints
        points.forEach(p => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
          ctx.fill();
        });
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

      if (activeTool === 'distance' || activeTool === 'angle') {
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

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (activeTool === 'none') {
      setIsDragging(true);
      setDragStart({ x: e.clientX, y: e.clientY });
    } else {
      setIsDrawing(true);
      setDrawingPoints([{ x, y }]);
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = overlayCanvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (isDragging && dragStart) {
      // Window/Level adjustment
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      
      const newWindow = Math.max(1, windowLevel.window + dx);
      const newLevel = windowLevel.level - dy;
      
      onWindowLevelChange({ window: newWindow, level: newLevel });
      setDragStart({ x: e.clientX, y: e.clientY });
    } else if (isDrawing) {
      if (activeTool === 'freehand') {
        setDrawingPoints(prev => [...prev, { x, y }]);
      } else if (activeTool === 'ellipse' || (activeTool === 'distance' && drawingPoints.length === 1)) {
        setDrawingPoints([drawingPoints[0], { x, y }]);
      }
    }
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = overlayCanvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (isDragging) {
      setIsDragging(false);
      setDragStart(null);
    } else if (isDrawing) {
      if (activeTool === 'distance') {
        if (drawingPoints.length === 1) {
          const points = [...drawingPoints, { x, y }];
          const value = calculateMeasurementValue('distance', points);
          onMeasurementAdd({
            id: Date.now().toString(),
            type: 'distance',
            points,
            slice: currentSlice,
            plane,
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
            plane,
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
          plane,
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
            plane,
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
          plane,
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
    const delta = e.deltaY > 0 ? 1 : -1;
    const maxSlice = plane === 'axial' ? header.dims[3] : plane === 'sagittal' ? header.dims[1] : header.dims[2];
    const newSlice = Math.max(0, Math.min(maxSlice - 1, currentSlice + delta));
    onSliceChange(newSlice);
  };

  const dims = header.dims;
  const maxSlice = plane === 'axial' ? dims[3] : plane === 'sagittal' ? dims[1] : dims[2];

  // Ensure we have sensible display sizes so the wrapper takes space in the layout
  const { width: imgW, height: imgH } = getSliceData();
  const displayW = displaySize.width || imgW;
  const displayH = displaySize.height || imgH;

  return (
    <div className="relative bg-gray-900 rounded-lg border border-gray-800 overflow-hidden flex flex-col">
      <div className="absolute top-2 left-2 z-10 bg-black bg-opacity-50 px-2 py-1 rounded text-xs text-white">
        <div className="font-semibold capitalize">{plane}</div>
        <div className="text-gray-400">
          Slice: {currentSlice + 1}/{maxSlice}
        </div>
        <div className="text-gray-400 mt-1">
          W: {Math.round(windowLevel.window)} L: {Math.round(windowLevel.level)}
        </div>
      </div>

  {/* Debug overlay: container and image sizes */}
      <div className="absolute top-2 right-2 z-10 bg-black bg-opacity-50 px-2 py-1 rounded text-xs text-white">
        <div className="font-semibold">Debug</div>
        <div className="text-gray-400 text-xs">Container: {containerRect.width} x {containerRect.height}</div>
        <div className="text-gray-400 text-xs">Display: {displaySize.width} x {displaySize.height}</div>
        <div className="text-gray-400 text-xs">Image: {getSliceData().width} x {getSliceData().height}</div>
        <div className="text-gray-400 text-xs mt-1">Parent: {ancestorRects.parent ? `${ancestorRects.parent.width} x ${ancestorRects.parent.height}` : '—'}</div>
        <div className="text-gray-400 text-xs">GrandParent: {ancestorRects.grandParent ? `${ancestorRects.grandParent.width} x ${ancestorRects.grandParent.height}` : '—'}</div>
      </div>

      {/* Auto WL flash */}
      {autoFlash && (
        <div className="absolute top-16 left-1/2 transform -translate-x-1/2 z-20 bg-green-800 bg-opacity-80 px-3 py-1 rounded text-xs text-white">
          Auto WL applied — W: {autoFlash.window} L: {autoFlash.level}
        </div>
      )}

      <div className="flex-1 flex items-center justify-center p-4 overflow-auto min-h-0">
        <div ref={containerRef} className="relative w-full h-full flex items-center justify-center" style={{ maxWidth: '100%', maxHeight: '100%' }}>
          <div className="flex items-center max-w-full max-h-full">
            <div className="relative" style={{ width: `${displayW}px`, height: `${displayH}px` }}>
              <canvas
                ref={canvasRef}
                className="absolute inset-0 w-full h-full"
                style={{ imageRendering: 'pixelated' }}
              />
              <canvas
                ref={overlayCanvasRef}
                className="absolute inset-0 w-full h-full cursor-crosshair"
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onClick={handleClick}
                onWheel={handleWheel}
              />
            </div>

            {/* Vertical slice slider in the non-image area to the right */}
            <div ref={sliderRef} className="ml-4 flex flex-col items-center" style={{ height: `${displayH}px` }}>
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
