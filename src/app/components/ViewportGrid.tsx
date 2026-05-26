import { useEffect, useRef, useState } from 'react';
import { Viewport } from './Viewport';
import type { WindowLevel, MeasurementTool, Measurement } from './MedicalImageViewer';
import type { Plane } from './dicom/DicomLoader';

export type ViewPlane = 'axial' | 'sagittal' | 'coronal';

interface SequenceWindow {
  id: Plane;
  label: string;
  imageData: Uint8Array;
  header: any;
  defaultWindowLevel: WindowLevel;
}

interface ViewportGridProps {
  imageData: Uint8Array;
  header: any;
  currentSlice: { axial: number; sagittal: number; coronal: number };
  /** Single-view mode */
  viewPlane: ViewPlane;
  onSliceChange: (plane: Plane, slice: number) => void;
  /** Initial W/L for each viewer (each `Viewport` owns brightness independently). */
  resolveDefaultWindowLevel: (viewportId: Plane) => WindowLevel;
  activeTool: MeasurementTool;
  measurements: Measurement[];
  onMeasurementAdd: (measurement: Measurement) => void;
  onMeasurementUpdate?: (id: string, newPoints: { x: number; y: number }[], value?: string, imageScale?: { x: number; y: number }) => void;
  pixelSpacing?: { x: number; y: number };
  measurementUnits?: 'mm' | 'px';
  selectedMeasurementId?: string | null;
  onMeasurementSelect?: (id: string | null) => void;
  applyWeighting: (pixelValue: number) => number;
  showCrosshair?: boolean;
  /** Multi-sequence mode (study): one draggable window per sequence. */
  sequenceWindows?: SequenceWindow[];
  onWindowFocus?: (plane: Plane) => void;
  onHideWindow?: (plane: Plane) => void;
  /** Restore defaults for the given acquisition plane / viewer only. */
  onResetViewport?: (plane: Plane) => void;
  /** Per-plane display size callback for px↔mm conversion. */
  onDisplaySizeChange?: (plane: Plane, size: { width: number; height: number }) => void;
}

type Rect = { top: number; left: number; width: number; height: number; z?: number };

export function ViewportGrid({
  imageData,
  header,
  currentSlice,
  viewPlane,
  onSliceChange,
  resolveDefaultWindowLevel,
  activeTool,
  measurements,
  onMeasurementAdd,
  onMeasurementUpdate,
  pixelSpacing,
  measurementUnits,
  selectedMeasurementId,
  onMeasurementSelect,
  applyWeighting,
  showCrosshair = false,
  sequenceWindows,
  onWindowFocus,
  onHideWindow,
  onResetViewport,
  onDisplaySizeChange,
}: ViewportGridProps) {
  // pixelSpacing is optional and provided by parent when available
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [positions, setPositions] = useState<Record<string, Rect>>({});
  const zCounterRef = useRef<number>(100);
  const draggingRef = useRef<{ id: string | null; startX: number; startY: number; left: number; top: number } | null>(null);
  const resizingRef = useRef<{ id: string | null; startX: number; startY: number; width: number; height: number } | null>(null);
  const GRID = 12;
  const MIN_W = 260;
  const MIN_H = 220;

  const snap = (n: number) => Math.round(n / GRID) * GRID;

  const sequenceMode = sequenceWindows !== undefined;

  useEffect(() => {
    if (!sequenceWindows?.length) return;
    const defaults: Record<Plane, Rect> = {
      axial: { top: 12, left: 12, width: 420, height: 420, z: 100 },
      sagittal: { top: 12, left: 460, width: 420, height: 420, z: 101 },
      coronal: { top: 460, left: 12, width: 420, height: 420, z: 102 },
    };
    setPositions((prev) => {
      const next = { ...prev };
      sequenceWindows.forEach((w) => {
        if (!next[w.id]) next[w.id] = defaults[w.id];
      });
      return next;
    });
  }, [sequenceWindows]);

  const bringToFront = (id: string) => {
    zCounterRef.current += 1;
    setPositions((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), z: zCounterRef.current } }));
  };

  const startDrag = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    bringToFront(id);
    const pos = positions[id];
    if (!pos) return;
    draggingRef.current = { id, startX: e.clientX, startY: e.clientY, left: pos.left, top: pos.top };
    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return;
      const d = draggingRef.current;
      const container = containerRef.current?.getBoundingClientRect();
      if (!container) return;
      const dx = ev.clientX - d.startX;
      const dy = ev.clientY - d.startY;
      const w = positions[d.id!]?.width || MIN_W;
      const h = positions[d.id!]?.height || MIN_H;
      const left = Math.max(0, Math.min(container.width - w, d.left + dx));
      const top = Math.max(0, Math.min(container.height - h, d.top + dy));
      setPositions((prev) => ({ ...prev, [d.id!]: { ...(prev[d.id!] || {}), left: snap(left), top: snap(top) } }));
    };
    const onUp = () => {
      draggingRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const startResize = (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    bringToFront(id);
    const pos = positions[id];
    if (!pos) return;
    resizingRef.current = { id, startX: e.clientX, startY: e.clientY, width: pos.width, height: pos.height };
    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      const r = resizingRef.current;
      const container = containerRef.current?.getBoundingClientRect();
      if (!container) return;
      const dx = ev.clientX - r.startX;
      const dy = ev.clientY - r.startY;
      const left = positions[r.id!]?.left || 0;
      const top = positions[r.id!]?.top || 0;
      const width = Math.max(MIN_W, Math.min(container.width - left, r.width + dx));
      const height = Math.max(MIN_H, Math.min(container.height - top, r.height + dy));
      setPositions((prev) => ({ ...prev, [r.id!]: { ...(prev[r.id!] || {}), width: snap(width), height: snap(height) } }));
    };
    const onUp = () => {
      resizingRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  if (!sequenceMode) {
    const planeSlice =
      viewPlane === 'axial' ? currentSlice.axial : viewPlane === 'sagittal' ? currentSlice.sagittal : currentSlice.coronal;
    const planeMeasurements = measurements.filter((m) => {
      if ((m.plane ?? viewPlane) !== viewPlane) return false;
      // If propagation is disabled for this measurement, only show on the exact slice
      const propagate = m.propagateAcrossSlices ?? true;
      if (propagate) return true;
      return m.slice === planeSlice;
    });

    return (
      <div ref={containerRef} className="flex-1 min-h-0 min-w-0 flex flex-col bg-gray-950 relative">
        <div className="flex-1 min-h-0 p-2 flex flex-col">
          <div className="flex-1 min-h-0 relative rounded-lg border border-gray-800 bg-gray-900 overflow-hidden shadow-lg">
            <Viewport
              imageData={imageData}
              header={header}
              plane={viewPlane}
              measurementPlane={viewPlane}
              currentSlice={planeSlice}
              onSliceChange={(slice) => onSliceChange(viewPlane, slice)}
              defaultWindowLevel={resolveDefaultWindowLevel(viewPlane)}
              activeTool={activeTool}
              measurements={planeMeasurements}
              onMeasurementAdd={onMeasurementAdd}
              onMeasurementUpdate={onMeasurementUpdate}
              pixelSpacing={pixelSpacing}
              measurementUnits={measurementUnits}
              selectedMeasurementId={selectedMeasurementId}
              onMeasurementSelect={onMeasurementSelect}
              applyWeighting={applyWeighting}
              showCrosshair={showCrosshair}
              onViewportReset={() => onResetViewport?.(viewPlane)}
              onDisplaySizeChange={(size) => onDisplaySizeChange?.(viewPlane, size)}
            />
          </div>
        </div>
      </div>
    );
  }

  if (!sequenceWindows.length) {
    return (
      <div ref={containerRef} className="flex-1 p-2 bg-gray-950 relative min-h-0 min-w-0 overflow-hidden">
        <div className="w-full h-full rounded-lg border border-gray-800 bg-gray-900 flex items-center justify-center text-sm text-gray-400">
          All sequences hidden. Click axial/sagittal/coronal on the right panel to show one again.
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex-1 p-2 bg-gray-950 relative min-h-0 min-w-0 overflow-hidden">
      {sequenceWindows.map((w) => {
        const pos = positions[w.id] || { top: 12, left: 12, width: 420, height: 420, z: 100 };
        const sequenceSlice = currentSlice[w.id];
        return (
          <div
            key={w.id}
            className="absolute bg-gray-900 border border-gray-800 rounded-lg shadow-lg overflow-hidden flex flex-col"
            style={{ top: pos.top, left: pos.left, width: pos.width, height: pos.height, zIndex: pos.z || 100 }}
            onMouseDown={() => {
              bringToFront(w.id);
              onWindowFocus?.(w.id);
            }}
          >
            <div
              className="shrink-0 flex items-center justify-between px-2 py-1 bg-gray-800 border-b border-gray-700 cursor-move"
              onMouseDown={(e) => startDrag(w.id, e)}
            >
              <div className="text-xs text-gray-200 font-semibold capitalize">{w.label}</div>
              <div className="flex items-center gap-2">
                <div className="text-[10px] text-gray-400">{w.header?.dims?.[3] || 0} slices</div>
                <button
                  type="button"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onHideWindow?.(w.id);
                  }}
                  className="text-[11px] leading-none text-gray-300 hover:text-red-400"
                  aria-label={`Hide ${w.label} sequence`}
                  title={`Hide ${w.label}`}
                >
                  x
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 min-w-0 relative flex flex-col">
                <Viewport
                imageData={w.imageData}
                header={w.header}
                plane="axial"
                planeLabel={w.label}
                measurementPlane={w.id}
                currentSlice={sequenceSlice}
                onSliceChange={(slice) => onSliceChange(w.id, slice)}
                defaultWindowLevel={w.defaultWindowLevel}
                activeTool={activeTool}
                measurements={measurements.filter((m) => {
                  if ((m.plane ?? w.id) !== w.id) return false;
                  const propagate = m.propagateAcrossSlices ?? true;
                  if (propagate) return true;
                  return m.slice === sequenceSlice;
                })}
                onMeasurementAdd={onMeasurementAdd}
                onMeasurementUpdate={onMeasurementUpdate}
                pixelSpacing={pixelSpacing}
                measurementUnits={measurementUnits}
                selectedMeasurementId={selectedMeasurementId}
                onMeasurementSelect={onMeasurementSelect}
                applyWeighting={applyWeighting}
                showCrosshair={showCrosshair}
                parentWindowHeight={pos.height}
                onViewportReset={() => onResetViewport?.(w.id)}
                onClose={() => onHideWindow?.(w.id)}
                onDisplaySizeChange={(size) => onDisplaySizeChange?.(w.id, size)}
              />
              <div
                onMouseDown={(e) => startResize(w.id, e)}
                className="absolute w-10 h-10 cursor-se-resize bg-transparent hover:bg-gray-700"
                style={{ right: -6, bottom: -6, zIndex: (pos.z || 100) + 10 }}
                aria-label={`Resize ${w.label}`}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
