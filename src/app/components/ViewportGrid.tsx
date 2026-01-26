import { Viewport } from './Viewport';
import type { WindowLevel, MeasurementTool, Measurement } from './MedicalImageViewer';

interface ViewportGridProps {
  imageData: Uint8Array;
  header: any;
  currentSlice: { axial: number; sagittal: number; coronal: number };
  /** which plane to show in the main viewport */
  selectedPlane?: 'axial' | 'sagittal' | 'coronal';
  onSliceChange: (plane: 'axial' | 'sagittal' | 'coronal', slice: number) => void;
  windowLevel: WindowLevel;
  onWindowLevelChange: (wl: WindowLevel) => void;
  activeTool: MeasurementTool;
  measurements: Measurement[];
  onMeasurementAdd: (measurement: Measurement) => void;
  applyWeighting: (pixelValue: number) => number;
  /** Show crosshair lines */
  showCrosshair?: boolean;
}

export function ViewportGrid({
  imageData,
  header,
  currentSlice,
  selectedPlane = 'axial',
  onSliceChange,
  windowLevel,
  onWindowLevelChange,
  activeTool,
  measurements,
  onMeasurementAdd,
  applyWeighting,
  showCrosshair = false,
  scaleMode = 'fit',
}: ViewportGridProps) {
  // Determine slice and measurements for the selected plane
  const plane = selectedPlane;
  const planeSlice = plane === 'axial' ? currentSlice.axial : plane === 'sagittal' ? currentSlice.sagittal : currentSlice.coronal;
  const planeMeasurements = measurements.filter(m => m.plane === plane);

  return (
    <div className="flex-1 p-2 bg-gray-950 flex items-stretch min-h-0 min-w-0">
      <div className="w-full h-full min-h-0 min-w-0 flex">
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
        />
      </div>
    </div>
  );
}
