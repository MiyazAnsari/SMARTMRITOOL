import { useRef, useEffect, useState, useCallback } from 'react';
import type { WindowLevel, MeasurementTool, Measurement } from './MedicalImageViewer';

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
}: ViewportProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
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

  // Render image
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { sliceData, width, height } = getSliceData();

    // Set canvas size
    canvas.width = width;
    canvas.height = height;

    // Create image data
    const imgData = ctx.createImageData(width, height);
    
    for (let i = 0; i < sliceData.length; i++) {
      const value = applyWindowLevel(sliceData[i]);
      imgData.data[i * 4] = value;
      imgData.data[i * 4 + 1] = value;
      imgData.data[i * 4 + 2] = value;
      imgData.data[i * 4 + 3] = 255;
    }

    ctx.putImageData(imgData, 0, 0);
  }, [imageData, currentSlice, plane, windowLevel, applyWindowLevel, getSliceData]);

  // Render measurements overlay
  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    const mainCanvas = canvasRef.current;
    if (!canvas || !mainCanvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = mainCanvas.width;
    canvas.height = mainCanvas.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw crosshair
    ctx.strokeStyle = 'rgba(0, 255, 255, 0.5)';
    ctx.lineWidth = 1;
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    
    ctx.beginPath();
    ctx.moveTo(centerX, 0);
    ctx.lineTo(centerX, canvas.height);
    ctx.moveTo(0, centerY);
    ctx.lineTo(canvas.width, centerY);
    ctx.stroke();

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

      <div className="flex-1 flex items-center justify-center p-4 overflow-hidden">
        <div className="relative" style={{ maxWidth: '100%', maxHeight: '100%' }}>
          <canvas
            ref={canvasRef}
            className="absolute top-0 left-0"
            style={{ imageRendering: 'pixelated' }}
          />
          <canvas
            ref={overlayCanvasRef}
            className="absolute top-0 left-0 cursor-crosshair"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onClick={handleClick}
            onWheel={handleWheel}
          />
        </div>
      </div>
    </div>
  );
}
