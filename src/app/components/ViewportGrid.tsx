import { useRef } from 'react';
import { Viewport } from './Viewport';
import type { WindowLevel, MeasurementTool, Measurement } from './MedicalImageViewer';

export type ViewPlane = 'axial' | 'sagittal' | 'coronal';

interface ViewportGridProps {
  imageData: Uint8Array;
  header: any;
  currentSlice: { axial: number; sagittal: number; coronal: number };
  /** Single MPR orientation — same full-area layout as the default axial view. */
  viewPlane: ViewPlane;
  onSliceChange: (plane: 'axial' | 'sagittal' | 'coronal', slice: number) => void;
  windowLevel: WindowLevel;
  onWindowLevelChange: (wl: WindowLevel) => void;
  activeTool: MeasurementTool;
  measurements: Measurement[];
  onMeasurementAdd: (measurement: Measurement) => void;
  applyWeighting: (pixelValue: number) => number;
  showCrosshair?: boolean;
}

export function ViewportGrid({
  imageData,
  header,
  currentSlice,
  viewPlane,
  onSliceChange,
  windowLevel,
  onWindowLevelChange,
  activeTool,
  measurements,
  onMeasurementAdd,
  applyWeighting,
  showCrosshair = false,
}: ViewportGridProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const planeSlice =
    viewPlane === 'axial' ? currentSlice.axial : viewPlane === 'sagittal' ? currentSlice.sagittal : currentSlice.coronal;
  const planeMeasurements = measurements.filter(m => m.plane === viewPlane);

  return (
    <div
      ref={containerRef}
      className="flex-1 min-h-0 min-w-0 flex flex-col bg-gray-950 relative"
    >
      <div className="flex-1 min-h-0 p-2 flex flex-col">
        <div className="flex-1 min-h-0 relative rounded-lg border border-gray-800 bg-gray-900 overflow-hidden shadow-lg">
          <Viewport
            imageData={imageData}
            header={header}
            plane={viewPlane}
            currentSlice={planeSlice}
            onSliceChange={(slice) => onSliceChange(viewPlane, slice)}
            windowLevel={windowLevel}
            onWindowLevelChange={onWindowLevelChange}
            activeTool={activeTool}
            measurements={planeMeasurements}
            onMeasurementAdd={onMeasurementAdd}
            applyWeighting={applyWeighting}
            showCrosshair={showCrosshair}
          />
        </div>
      </div>
    </div>
  );
}
