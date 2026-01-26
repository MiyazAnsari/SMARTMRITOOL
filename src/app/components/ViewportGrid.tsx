import { useEffect, useRef, useState } from 'react';
import { Viewport } from './Viewport';
import type { WindowLevel, MeasurementTool, Measurement } from './MedicalImageViewer';

interface ViewportGridProps {
  imageData: Uint8Array;
  header: any;
  currentSlice: { axial: number; sagittal: number; coronal: number };
  /** which planes are open in the center (multi-window) */
  selectedPlanes?: Array<'axial' | 'sagittal' | 'coronal'>;
  onClosePlane?: (plane: 'axial' | 'sagittal' | 'coronal') => void;
  onSliceChange: (plane: 'axial' | 'sagittal' | 'coronal', slice: number) => void;
  windowLevel: WindowLevel;
  onWindowLevelChange: (wl: WindowLevel) => void;
  activeTool: MeasurementTool;
  measurements: Measurement[];
  onMeasurementAdd: (measurement: Measurement) => void;
  applyWeighting: (pixelValue: number) => number;
  /** Show crosshair lines */
  showCrosshair?: boolean;
  /** Signal to trigger tiling layout (increment to re-tile) */
  tileSignal?: number;
}

export function ViewportGrid({
  imageData,
  header,
  currentSlice,
  selectedPlanes = ['axial'],
  onClosePlane,
  onSliceChange,
  windowLevel,
  onWindowLevelChange,
  activeTool,
  measurements,
  onMeasurementAdd,
  applyWeighting,
  showCrosshair = false,
  tileSignal = 0,
}: ViewportGridProps & { tileSignal?: number }) {
  // track positions and sizes for draggable & resizable windows
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [positions, setPositions] = useState<Record<string, { top: number; left: number; width: number; height: number }>>({});
  const draggingRef = useRef<{ id: string | null; startX: number; startY: number; origLeft: number; origTop: number } | null>(null);
  const resizingRef = useRef<{ id: string | null; startX: number; startY: number; origW: number; origH: number } | null>(null);

  // z-order counter for bringing windows to front
  const zCounterRef = useRef<number>(100);

  // Initialize positions for planes with size and z
  useEffect(() => {
    const defaults: Record<string, { top: number; left: number; width: number; height: number; z: number }> = {
      axial: { top: 12, left: 12, width: 360, height: 360, z: 100 },
      sagittal: { top: 12, left: 400, width: 360, height: 360, z: 101 },
      coronal: { top: 12, left: 788, width: 360, height: 360, z: 102 },
    };
    setPositions(prev => {
      const next = { ...prev };
      selectedPlanes.forEach(p => {
        if (!next[p]) next[p] = defaults[p];
      });
      return next;
    });
  }, [selectedPlanes]);

  const GRID = 12; // snap grid in pixels
  const MIN_W = 220;
  const MIN_H = 180;

  const snap = (n: number) => Math.round(n / GRID) * GRID;

  const bringToFront = (id: string) => {
    zCounterRef.current += 1;
    setPositions(prev => ({ ...prev, [id]: { ...(prev[id] || {}), z: zCounterRef.current } }));
  };

  const onHeaderMouseDown = (id: string, e: React.MouseEvent) => {
    bringToFront(id);
    const containerRect = containerRef.current?.getBoundingClientRect();
    if (!containerRect) return;
    const pos = positions[id];
    if (!pos) return;
    draggingRef.current = { id, startX: e.clientX, startY: e.clientY, origLeft: pos.left, origTop: pos.top };

    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return;
      const d = draggingRef.current;
      const dx = ev.clientX - d.startX;
      const dy = ev.clientY - d.startY;
      const container = containerRef.current?.getBoundingClientRect();
      if (!container) return;
      // clamp into container bounds and snap
      const newLeft = Math.max(0, Math.min(container.width - (positions[id]?.width || MIN_W), d.origLeft + dx));
      const newTop = Math.max(0, Math.min(container.height - (positions[id]?.height || MIN_H), d.origTop + dy));
      setPositions(prev => ({ ...prev, [id]: { ...(prev[id] || {}), left: snap(newLeft), top: snap(newTop) } }));
    };

    const onUp = () => {
      draggingRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const onResizeMouseDown = (id: string, e: React.MouseEvent, direction: 'se' | 'e' | 's' = 'se') => {
    e.stopPropagation();
    const pos = positions[id];
    if (!pos) return;
    resizingRef.current = { id, startX: e.clientX, startY: e.clientY, origW: pos.width, origH: pos.height };

    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      const r = resizingRef.current;
      const container = containerRef.current?.getBoundingClientRect();
      if (!container) return;
      const dx = ev.clientX - r.startX;
      const dy = ev.clientY - r.startY;

      let newW = r.origW;
      let newH = r.origH;

      if (direction === 'se' || direction === 'e') {
        newW = Math.max(MIN_W, Math.min(container.width - (positions[r.id!]?.left || 0), r.origW + dx));
      }
      if (direction === 'se' || direction === 's') {
        newH = Math.max(MIN_H, Math.min(container.height - (positions[r.id!]?.top || 0), r.origH + dy));
      }

      setPositions(prev => {
        const cur = prev[r.id!] || { top: 0, left: 0, width: r.origW, height: r.origH };
        if (direction === 'e') {
          // Horizontal-only resize: update width only, preserve current height exactly
          return { ...prev, [r.id!]: { ...cur, width: snap(newW) } };
        }
        if (direction === 's') {
          // Vertical-only resize: update height only
          return { ...prev, [r.id!]: { ...cur, height: snap(newH) } };
        }
        // 'se' diagonal: update both
        return { ...prev, [r.id!]: { ...cur, width: snap(newW), height: snap(newH) } };
      });
    };

    const onUp = () => {
      resizingRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const closePlane = (p: 'axial' | 'sagittal' | 'coronal') => {
    onClosePlane?.(p);
  };

  // Tile windows when signaled: arrange in grid to fill container
  useEffect(() => {
    if (!containerRef.current) return;
    const c = containerRef.current.getBoundingClientRect();
    const open = selectedPlanes.length;
    if (open === 0) return;

    // Prefer explicit layouts for small counts: 1x1, 1x2, 1x3, 2x2
    let cols: number;
    let rows: number;
    if (open <= 3) {
      cols = open;
      rows = 1;
    } else if (open === 4) {
      cols = 2;
      rows = 2;
    } else {
      // For larger counts, pick a near-square grid (cols >= rows)
      cols = Math.ceil(Math.sqrt(open));
      rows = Math.ceil(open / cols);
    }
    const padding = 12;
    const tileW = Math.max(MIN_W, Math.floor((c.width - (cols + 1) * padding) / cols));
    const tileH = Math.max(MIN_H, Math.floor((c.height - (rows + 1) * padding) / rows));

    const next: Record<string, { top: number; left: number; width: number; height: number }> = {};
    selectedPlanes.forEach((p, i) => {
      const r = Math.floor(i / cols);
      const col = i % cols;
      const left = padding + col * (tileW + padding);
      const top = padding + r * (tileH + padding);
      next[p] = { top: snap(top), left: snap(left), width: snap(tileW), height: snap(tileH) };
    });
    setPositions(prev => ({ ...prev, ...next }));
  }, [selectedPlanes, tileSignal]);

  return (
    <div ref={containerRef} className="flex-1 p-2 bg-gray-950 flex items-stretch min-h-0 min-w-0 relative">
      {selectedPlanes.map((plane) => {
        const planeSlice = plane === 'axial' ? currentSlice.axial : plane === 'sagittal' ? currentSlice.sagittal : currentSlice.coronal;
        const planeMeasurements = measurements.filter(m => m.plane === plane);
        const pos = positions[plane] || { top: 12, left: 12, width: 360, height: 360 };
        return (
          <div
            key={plane}
            className="absolute bg-gray-900 border border-gray-800 rounded-lg shadow-lg overflow-hidden"
            style={{ top: pos.top, left: pos.left, width: pos.width, height: pos.height, zIndex: pos.z || 100 }}
            onMouseDown={() => bringToFront(plane)}
          >
            <div className="flex items-center justify-between px-2 py-1 bg-gray-800 border-b border-gray-700 cursor-move" onMouseDown={(e) => onHeaderMouseDown(plane, e)}>
              <div className="text-xs text-gray-200 font-semibold capitalize">{plane}</div>
              <div className="flex items-center space-x-2">
                <button onClick={() => closePlane(plane)} className="text-xs text-gray-400 hover:text-red-400">✕</button>
              </div>
            </div>
            <div className="w-full h-full relative">
                <Viewport
                imageData={imageData}
                header={header}
                plane={plane}
                currentSlice={planeSlice}
                onSliceChange={(slice) => onSliceChange(plane, slice)}
                windowLevel={windowLevel}
                onWindowLevelChange={onWindowLevelChange}
                activeTool={activeTool}
                measurements={planeMeasurements}
                onMeasurementAdd={onMeasurementAdd}
                applyWeighting={applyWeighting}
                showCrosshair={showCrosshair}
                  parentWindowHeight={pos.height}
              />

              {/* right resize handle */}
              <div
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onResizeMouseDown(plane, e, 'e'); }}
                onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); onResizeMouseDown(plane, e as any, 'e'); }}
                className="absolute right-0 top-1/2 -translate-y-1/2 w-6 h-12 cursor-ew-resize bg-transparent hover:bg-gray-700"
                style={{ zIndex: (pos.z || 100) + 100, pointerEvents: 'auto' }}
                aria-label={`Resize ${plane} window horizontally`}
              />

              {/* bottom resize handle */}
              <div
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onResizeMouseDown(plane, e, 's'); }}
                onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); onResizeMouseDown(plane, e as any, 's'); }}
                className="absolute bottom-0 left-1/2 -translate-x-1/2 w-12 h-6 cursor-ns-resize bg-transparent hover:bg-gray-700"
                style={{ zIndex: (pos.z || 100) + 100, pointerEvents: 'auto' }}
                aria-label={`Resize ${plane} window vertically`}
              />

              {/* bottom-right diagonal handle (bigger and offset outside window edges for easier hit) */}
              <div
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onResizeMouseDown(plane, e, 'se'); }}
                onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); onResizeMouseDown(plane, e as any, 'se'); }}
                className="absolute w-12 h-12 cursor-se-resize bg-transparent hover:bg-gray-700 flex items-center justify-center"
                style={{ right: -8, bottom: -8, zIndex: (pos.z || 100) + 200, pointerEvents: 'auto' }}
                aria-label={`Resize ${plane} window`}
              >
                <div className="w-3 h-3 rotate-45 bg-gray-400" />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
