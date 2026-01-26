import { Viewport } from './Viewport';
import type { WindowLevel, MeasurementTool, Measurement } from './MedicalImageViewer';

interface ViewportGridProps {
  imageData: Uint8Array;
  header: any;
  currentSlice: { axial: number; sagittal: number; coronal: number };
  onSliceChange: (plane: 'axial' | 'sagittal' | 'coronal', slice: number) => void;
  windowLevel: WindowLevel;
  onWindowLevelChange: (wl: WindowLevel) => void;
  activeTool: MeasurementTool;
  measurements: Measurement[];
  onMeasurementAdd: (measurement: Measurement) => void;
  applyWeighting: (pixelValue: number) => number;
}

export function ViewportGrid({
  imageData,
  header,
  currentSlice,
  onSliceChange,
  windowLevel,
  onWindowLevelChange,
  activeTool,
  measurements,
  onMeasurementAdd,
  applyWeighting,
}: ViewportGridProps) {
  return (
    <div className="flex-1 grid grid-cols-2 grid-rows-2 gap-1 p-2 bg-gray-950">
      <Viewport
        imageData={imageData}
        header={header}
        plane="axial"
        currentSlice={currentSlice.axial}
        onSliceChange={(slice) => onSliceChange('axial', slice)}
        windowLevel={windowLevel}
        onWindowLevelChange={onWindowLevelChange}
        activeTool={activeTool}
        measurements={measurements.filter(m => m.plane === 'axial')}
        onMeasurementAdd={onMeasurementAdd}
        applyWeighting={applyWeighting}
      />
      <Viewport
        imageData={imageData}
        header={header}
        plane="sagittal"
        currentSlice={currentSlice.sagittal}
        onSliceChange={(slice) => onSliceChange('sagittal', slice)}
        windowLevel={windowLevel}
        onWindowLevelChange={onWindowLevelChange}
        activeTool={activeTool}
        measurements={measurements.filter(m => m.plane === 'sagittal')}
        onMeasurementAdd={onMeasurementAdd}
        applyWeighting={applyWeighting}
      />
      <Viewport
        imageData={imageData}
        header={header}
        plane="coronal"
        currentSlice={currentSlice.coronal}
        onSliceChange={(slice) => onSliceChange('coronal', slice)}
        windowLevel={windowLevel}
        onWindowLevelChange={onWindowLevelChange}
        activeTool={activeTool}
        measurements={measurements.filter(m => m.plane === 'coronal')}
        onMeasurementAdd={onMeasurementAdd}
        applyWeighting={applyWeighting}
      />
      <div className="bg-gray-900 rounded-lg border border-gray-800 flex items-center justify-center">
        <div className="text-center">
          <div className="text-gray-500 text-sm mb-2">3D View</div>
          <div className="text-gray-600 text-xs">MPR reconstruction placeholder</div>
        </div>
      </div>
    </div>
  );
}
