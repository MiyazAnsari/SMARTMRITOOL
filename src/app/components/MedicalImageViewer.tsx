import { useState, useEffect, useCallback, useRef } from 'react';
import * as nifti from 'nifti-reader-js';
import { ViewportGrid } from './ViewportGrid';
import { Toolbar } from './Toolbar';
import { WeightingPanel } from './WeightingPanel';

export interface MedicalImageViewerProps {
  niftiData: ArrayBuffer;
}

export type MeasurementTool = 'none' | 'distance' | 'angle' | 'ellipse' | 'closedCurve' | 'freehand';
export type WeightingType = 'T1' | 'T2' | 'PD' | 'CT' | 'Custom';

export interface WindowLevel {
  window: number;
  level: number;
}

export interface Measurement {
  id: string;
  type: MeasurementTool;
  points: { x: number; y: number }[];
  slice: number;
  plane: 'axial' | 'sagittal' | 'coronal';
  value?: string;
}

export function MedicalImageViewer({ niftiData }: MedicalImageViewerProps) {
  const [imageData, setImageData] = useState<Uint8Array | null>(null);
  const [header, setHeader] = useState<any>(null);
  const [dataRange, setDataRange] = useState<{ min: number; max: number }>({ min: 0, max: 255 });
  const [currentSlice, setCurrentSlice] = useState({ axial: 0, sagittal: 0, coronal: 0 });
  const [windowLevel, setWindowLevel] = useState<WindowLevel>({ window: 400, level: 40 });
  const [activeTool, setActiveTool] = useState<MeasurementTool>('none');
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [weighting, setWeighting] = useState<WeightingType>('T1');
  const [customWeighting, setCustomWeighting] = useState({ te: 0, tr: 0, ti: 0 });
  // Which plane is currently shown in the main viewport (single-plane view)
  const [selectedPlane, setSelectedPlane] = useState<'axial' | 'sagittal' | 'coronal'>('axial');
  // UI helpers
  const [showCrosshair, setShowCrosshair] = useState<boolean>(false);
  // resizable panel widths (px)
  const [leftWidth, setLeftWidth] = useState<number>(240); // default w-60 (15rem)
  const [rightWidth, setRightWidth] = useState<number>(288); // default w-72 (18rem)
  const leftResizing = useRef(false);
  const rightResizing = useRef(false);

  useEffect(() => {
    if (!niftiData) return;

    try {
      // All nifti-reader-js functions expect ArrayBuffer, not Uint8Array
      
      // Check if compressed (shouldn't be at this point, but just in case)
      if (nifti.isCompressed(niftiData)) {
        throw new Error('File appears to be compressed. Please use a .nii.gz file and ensure it\'s properly decompressed.');
      }
      
      if (!nifti.isNIFTI(niftiData)) {
        throw new Error('File is not a valid NIfTI format');
      }

      const niftiHeader = nifti.readHeader(niftiData);
      if (!niftiHeader) {
        throw new Error('Could not read NIfTI header');
      }

      const niftiImage = nifti.readImage(niftiHeader, niftiData);
      if (!niftiImage) {
        throw new Error('Could not read NIfTI image data');
      }
      
      // Parse data based on data type
      let typedData: number[];
      const datatypeCode = niftiHeader.datatypeCode;
      
      // NIFTI datatype codes
      // 2 = uint8, 4 = int16, 8 = int32, 16 = float32, 64 = float64, 512 = uint16
      if (datatypeCode === 2) {
        typedData = Array.from(new Uint8Array(niftiImage));
      } else if (datatypeCode === 4) {
        typedData = Array.from(new Int16Array(niftiImage));
      } else if (datatypeCode === 512) {
        typedData = Array.from(new Uint16Array(niftiImage));
      } else if (datatypeCode === 8) {
        typedData = Array.from(new Int32Array(niftiImage));
      } else if (datatypeCode === 16) {
        typedData = Array.from(new Float32Array(niftiImage));
      } else if (datatypeCode === 64) {
        typedData = Array.from(new Float64Array(niftiImage));
      } else {
        // Default to Int16, most common for medical images
        console.warn(`Unknown datatype code ${datatypeCode}, defaulting to Int16`);
        typedData = Array.from(new Int16Array(niftiImage));
      }
      
      // Calculate min and max values from the actual data
      let min = Infinity;
      let max = -Infinity;
      
      for (let i = 0; i < typedData.length; i++) {
        const val = typedData[i];
        if (val < min) min = val;
        if (val > max) max = val;
      }
      
      // Apply scl_slope and scl_inter if present
      const slope = niftiHeader.scl_slope || 1;
      const inter = niftiHeader.scl_inter || 0;
      
      if (slope !== 0 && slope !== 1) {
        min = min * slope + inter;
        max = max * slope + inter;
      }
      
      console.log('Data range:', { min, max, datatypeCode, slope, inter });
      console.log('Dimensions:', niftiHeader.dims);
      
      // Normalize data to 0-255 range for display
      const range = max - min;
      const normalizedData = new Uint8Array(typedData.length);
      
      if (range > 0) {
        for (let i = 0; i < typedData.length; i++) {
          let val = typedData[i];
          if (slope !== 0 && slope !== 1) {
            val = val * slope + inter;
          }
          normalizedData[i] = Math.round(((val - min) / range) * 255);
        }
      }
      
      setHeader(niftiHeader);
      setImageData(normalizedData);
      setDataRange({ min, max });
      
      // Set initial slices to middle
      setCurrentSlice({
        axial: Math.floor(niftiHeader.dims[3] / 2),
        sagittal: Math.floor(niftiHeader.dims[1] / 2),
        coronal: Math.floor(niftiHeader.dims[2] / 2),
      });
      
      // Set default window/level based on normalized range (0-255)
      setWindowLevel({ window: 255, level: 128 });
    } catch (error) {
      console.error('Error parsing NIfTI file:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      alert(`Error parsing NIfTI file: ${errorMessage}\n\nPlease ensure it is a valid NIfTI format.`);
    }
  }, [niftiData]);

  const handleSliceChange = useCallback((plane: 'axial' | 'sagittal' | 'coronal', slice: number) => {
    setCurrentSlice(prev => ({ ...prev, [plane]: slice }));
  }, []);

  const handleWindowLevelChange = useCallback((wl: WindowLevel) => {
    setWindowLevel(wl);
  }, []);

  // Resizer handlers
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      // Keep reasonable minimums so the center viewport never collapses
      const MIN_LEFT = 120;
      const MIN_RIGHT = 160;
      const MIN_CENTER = 320; // ensure the viewport remains usable
      const totalW = window.innerWidth;
      const rect = document.body.getBoundingClientRect();
      const x = e.clientX - rect.left;

      if (leftResizing.current) {
        // compute maximum left width so center doesn't collapse and right panel retains min
        const maxLeft = Math.max(MIN_LEFT, totalW - MIN_RIGHT - MIN_CENTER);
        const newW = Math.min(Math.max(MIN_LEFT, x), maxLeft);
        setLeftWidth(newW);
      } else if (rightResizing.current) {
        // compute right width measured from right edge and clamp so center stays visible
        const rawRight = Math.max(MIN_RIGHT, totalW - x);
        const maxRight = Math.max(MIN_RIGHT, totalW - MIN_LEFT - MIN_CENTER);
        const newRight = Math.min(rawRight, maxRight);
        setRightWidth(newRight);
      }
    };

    const onMouseUp = () => {
      leftResizing.current = false;
      rightResizing.current = false;
      document.body.style.cursor = '';
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('mouseleave', onMouseUp);
    window.addEventListener('blur', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('mouseleave', onMouseUp);
      window.removeEventListener('blur', onMouseUp);
    };
  }, []);

  const handleMeasurementAdd = useCallback((measurement: Measurement) => {
    setMeasurements(prev => [...prev, measurement]);
  }, []);

  const handleMeasurementDelete = useCallback((id: string) => {
    setMeasurements(prev => prev.filter(m => m.id !== id));
  }, []);

  const handleAutoWindowLevel = useCallback(() => {
    if (!imageData || !header) return;
    const dims = header.dims;

    const plane = selectedPlane;
    const sliceIndex = plane === 'axial' ? currentSlice.axial : plane === 'sagittal' ? currentSlice.sagittal : currentSlice.coronal;

    let min = Infinity;
    let max = -Infinity;

    if (plane === 'axial') {
      const width = dims[1];
      const height = dims[2];
      const offset = sliceIndex * width * height;
      const sliceSize = width * height;
      for (let i = 0; i < sliceSize; i++) {
        const v = imageData[offset + i] || 0;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    } else if (plane === 'sagittal') {
      const width = dims[2];
      const height = dims[3];
      for (let z = 0; z < height; z++) {
        for (let y = 0; y < width; y++) {
          const sourceIdx = z * dims[1] * dims[2] + y * dims[1] + sliceIndex;
          const v = imageData[sourceIdx] || 0;
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
    } else { // coronal
      const width = dims[1];
      const height = dims[3];
      for (let z = 0; z < height; z++) {
        for (let x = 0; x < width; x++) {
          const sourceIdx = z * dims[1] * dims[2] + sliceIndex * dims[1] + x;
          const v = imageData[sourceIdx] || 0;
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
    }

    if (min === Infinity || max === -Infinity) return;

    const window = Math.max(1, max - min);
    const level = Math.round((min + max) / 2);

    setWindowLevel({ window, level });
  }, [imageData, header, selectedPlane, currentSlice]);

  const applyWeighting = useCallback((pixelValue: number): number => {
    // DREAMER algorithm simulation - in reality this would be much more complex
    // This is a simplified representation of tissue weighting
    switch (weighting) {
      case 'T1':
        // T1-weighted: Fat is bright, water is dark
        return Math.min(255, pixelValue * 1.2);
      case 'T2':
        // T2-weighted: Water is bright, fat is intermediate
        return Math.min(255, pixelValue * 0.8 + 30);
      case 'PD':
        // Proton density: Both fat and water are bright
        return Math.min(255, pixelValue * 1.0);
      case 'CT':
        // CT/Hard tissue: Bone is bright
        return Math.min(255, Math.max(0, pixelValue - 20) * 1.5);
      case 'Custom':
        // Custom weighting based on TE, TR, TI parameters
        const teFactor = customWeighting.te / 100;
        const trFactor = customWeighting.tr / 1000;
        const tiFactor = customWeighting.ti / 500;
        return Math.min(255, pixelValue * (1 + teFactor - trFactor + tiFactor));
      default:
        return pixelValue;
    }
  }, [weighting, customWeighting]);

  if (!imageData || !header) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-gray-400">Loading image...</div>
      </div>
    );
  }

  return (
    <div className="h-full flex">
      <div style={{ width: leftWidth }} className="flex-shrink-0">
        <Toolbar 
          activeTool={activeTool}
          onToolChange={setActiveTool}
          measurements={measurements}
          onMeasurementDelete={handleMeasurementDelete}
          showCrosshair={showCrosshair}
          onToggleCrosshair={() => setShowCrosshair(v => !v)}
          onAutoWindowLevel={handleAutoWindowLevel}
        />
      </div>

      {/* left resizer: larger interactive hit area with thin visual line */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize left panel"
        onMouseDown={() => { leftResizing.current = true; document.body.style.cursor = 'col-resize'; }}
        onTouchStart={() => { leftResizing.current = true; document.body.style.cursor = 'col-resize'; }}
        onDoubleClick={() => { setLeftWidth(240); }}
        className="w-8 -ml-4 -mr-4 cursor-col-resize relative"
        style={{ zIndex: 40 }}
      >
        {/* thin visible divider centered inside the hit area */}
        <div className="absolute inset-y-0 left-1/2 w-px bg-transparent hover:bg-gray-700" />
      </div>
      
      <div className="flex-1 flex flex-col min-h-0">
        <ViewportGrid
          imageData={imageData}
          header={header}
          currentSlice={currentSlice}
          selectedPlane={selectedPlane}
          onSliceChange={handleSliceChange}
          windowLevel={windowLevel}
          onWindowLevelChange={handleWindowLevelChange}
          activeTool={activeTool}
          measurements={measurements}
          onMeasurementAdd={handleMeasurementAdd}
          applyWeighting={applyWeighting}
          showCrosshair={showCrosshair}
        />
      </div>

      {/* right resizer: larger interactive hit area with thin visual line */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize right panel"
        onMouseDown={() => { rightResizing.current = true; document.body.style.cursor = 'col-resize'; }}
        onTouchStart={() => { rightResizing.current = true; document.body.style.cursor = 'col-resize'; }}
        onDoubleClick={() => { setRightWidth(288); }}
        className="w-8 -ml-4 -mr-4 cursor-col-resize relative"
        style={{ zIndex: 40 }}
      >
        <div className="absolute inset-y-0 left-1/2 w-px bg-transparent hover:bg-gray-700" />
      </div>

      <div style={{ width: rightWidth }} className="flex-shrink-0">
        <WeightingPanel
          weighting={weighting}
          onWeightingChange={setWeighting}
          customWeighting={customWeighting}
          onCustomWeightingChange={setCustomWeighting}
          selectedPlane={selectedPlane}
          onPlaneChange={setSelectedPlane}
        />
      </div>
    </div>
  );
}