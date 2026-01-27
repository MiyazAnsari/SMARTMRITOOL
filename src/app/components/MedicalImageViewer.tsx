import { useState, useEffect, useCallback, useRef } from 'react';
import * as nifti from 'nifti-reader-js';
import { ViewportGrid } from './ViewportGrid';
import { WeightingPanel } from './WeightingPanel';
import { Button } from './ui/button';
import { RadioGroup, RadioGroupItem } from './ui/radio-group';
import { Slider } from './ui/slider';
import { Label } from './ui/label';
import { MousePointer, Circle as CircleIcon, Pencil, Layout, Move } from 'lucide-react';

export interface MedicalImageViewerProps {
  niftiData?: ArrayBuffer | null;
}

export type MeasurementTool = 'none' | 'distance' | 'angle' | 'ellipse' | 'closedCurve' | 'freehand' | 'pan';
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

interface MedicalImageViewerExtras {
  onFileLoad?: (data: ArrayBuffer, name: string) => void;
}

export function MedicalImageViewer({ niftiData, onFileLoad }: MedicalImageViewerProps & MedicalImageViewerExtras) {
  const [imageData, setImageData] = useState<Uint8Array | null>(null);
  const [header, setHeader] = useState<any>(null);
  const [dataRange, setDataRange] = useState<{ min: number; max: number }>({ min: 0, max: 255 });
  const [currentSlice, setCurrentSlice] = useState({ axial: 0, sagittal: 0, coronal: 0 });
  const [windowLevel, setWindowLevel] = useState<WindowLevel>({ window: 400, level: 40 });
  const [activeTool, setActiveTool] = useState<MeasurementTool>('none');
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [weighting, setWeighting] = useState<WeightingType>('T1');
  // single psi slider for custom weighting (0-180 degrees)
  const [customWeighting, setCustomWeighting] = useState({ psi: 90 });
  // Which planes are currently open in the center (multi-window)
  const [selectedPlanes, setSelectedPlanes] = useState<Array<'axial' | 'sagittal' | 'coronal'>>(['axial']);
  // Processing mode for contrasts
  const [contrastMode, setContrastMode] = useState<'disk' | 'gpu'>('disk');
  // UI helpers
  const [showCrosshair, setShowCrosshair] = useState<boolean>(false);
  // resizable right panel width (px)
  const [rightWidth, setRightWidth] = useState<number>(288); // default w-72 (18rem)
  const rightResizing = useRef(false);
  // tiling signal for ViewportGrid
  const [tileSignal, setTileSignal] = useState<number>(0);
  const [layoutPreference, setLayoutPreference] = useState<'auto' | 'row' | 'column' | 'grid'>('auto');
  const [rightPanelOverflow, setRightPanelOverflow] = useState(false);

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

  // Resizer handlers (only right panel now)
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const MIN_RIGHT = 160;
      const MIN_CENTER = 320; // ensure the viewport remains usable
      const totalW = window.innerWidth;
      const rect = document.body.getBoundingClientRect();
      const x = e.clientX - rect.left;

      if (rightResizing.current) {
        // compute right width measured from right edge and clamp so center stays visible
        const rawRight = Math.max(MIN_RIGHT, totalW - x);
        const maxRight = Math.max(MIN_RIGHT, totalW - MIN_CENTER);
        const newRight = Math.min(rawRight, maxRight);
        setRightWidth(newRight);
      }
    };

    const onMouseUp = () => {
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

    // Use the first selected plane as the primary context for Auto WL
    const plane = selectedPlanes.length > 0 ? selectedPlanes[0] : 'axial';
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
  }, [imageData, header, selectedPlanes, currentSlice]);

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
        // Custom weighting based on single tissue weight psi (0-180)
        const psiFactor = (customWeighting.psi || 0) / 180; // normalized 0..1
        return Math.min(255, pixelValue * (1 + psiFactor));
      default:
        return pixelValue;
    }
  }, [weighting, customWeighting]);

  const loaded = Boolean(imageData && header);

  return (
    <div className="h-full flex">
      <div className="flex-1 flex flex-col min-h-0 relative">
        {loaded ? (
          <ViewportGrid
            imageData={imageData!}
            header={header!}
            currentSlice={currentSlice}
            selectedPlanes={selectedPlanes}
            tileSignal={tileSignal}
            layoutPreference={layoutPreference}
            onClosePlane={(p) => setSelectedPlanes(prev => prev.filter(x => x !== p))}
            onSliceChange={handleSliceChange}
            windowLevel={windowLevel}
            onWindowLevelChange={handleWindowLevelChange}
            activeTool={activeTool}
            measurements={measurements}
            onMeasurementAdd={handleMeasurementAdd}
            applyWeighting={applyWeighting}
            showCrosshair={showCrosshair}
          />
        ) : (
          <div className="h-full flex items-center justify-center">
            <div className="text-center max-w-md">
              <svg className="mx-auto h-16 w-16 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <h3 className="mt-4 text-lg font-medium text-gray-300">No image loaded</h3>
              <p className="mt-2 text-sm text-gray-500">Load imaging data (.nii or .nii.gz) to begin</p>
            </div>
          </div>
        )}

        {/* Floating bottom-right tool bar (select, ellipse, freehand, auto WL, tile) */}
        <div className="absolute bottom-4 right-4 flex items-center space-x-2" style={{ zIndex: 9999 }}>
          <Button
            size="sm"
            variant={activeTool === 'none' ? 'default' : 'ghost'}
            className={activeTool === 'none' ? 'bg-blue-600 text-white' : 'text-gray-300'}
            onClick={() => setActiveTool('none')}
            aria-label="Select tool"
          >
            <MousePointer className="h-4 w-4" />
          </Button>

          <Button
            size="sm"
            variant={activeTool === 'ellipse' ? 'default' : 'ghost'}
            className={activeTool === 'ellipse' ? 'bg-blue-600 text-white' : 'text-gray-300'}
            onClick={() => setActiveTool('ellipse')}
            aria-label="Ellipse tool"
          >
            <CircleIcon className="h-4 w-4" />
          </Button>

          <Button
            size="sm"
            variant={activeTool === 'freehand' ? 'default' : 'ghost'}
            className={activeTool === 'freehand' ? 'bg-blue-600 text-white' : 'text-gray-300'}
            onClick={() => setActiveTool('freehand')}
            aria-label="Freehand tool"
          >
            <Pencil className="h-4 w-4" />
          </Button>

          <Button
            size="sm"
            variant={activeTool === 'pan' ? 'default' : 'ghost'}
            className={activeTool === 'pan' ? 'bg-blue-600 text-white' : 'text-gray-300'}
            onClick={() => setActiveTool(v => v === 'pan' ? 'none' : 'pan')}
            aria-label="Pan tool"
          >
            <Move className="h-4 w-4" />
          </Button>

          <Button
            size="sm"
            variant="ghost"
            className="text-gray-300"
            onClick={() => handleAutoWindowLevel()}
            aria-label="Auto window level"
          >
            Auto WL
          </Button>

          {/* If right panel overflowed, render weighting controls into the bottom menu */}
          {rightPanelOverflow && (
            <div className="bg-gray-800 p-2 rounded border border-gray-700 flex items-center space-x-3">
              <RadioGroup value={weighting} onValueChange={(v) => setWeighting(v as WeightingType)}>
                <div className="flex items-center space-x-2">
                  <div className="flex items-center space-x-1">
                    <RadioGroupItem value="T1" id="t1-bottom" />
                    <Label htmlFor="t1-bottom" className="text-xs text-gray-300 cursor-pointer">T1</Label>
                  </div>
                  <div className="flex items-center space-x-1">
                    <RadioGroupItem value="T2" id="t2-bottom" />
                    <Label htmlFor="t2-bottom" className="text-xs text-gray-300 cursor-pointer">T2</Label>
                  </div>
                  <div className="flex items-center space-x-1">
                    <RadioGroupItem value="PD" id="pd-bottom" />
                    <Label htmlFor="pd-bottom" className="text-xs text-gray-300 cursor-pointer">PD</Label>
                  </div>
                  <div className="flex items-center space-x-1">
                    <RadioGroupItem value="CT" id="ct-bottom" />
                    <Label htmlFor="ct-bottom" className="text-xs text-gray-300 cursor-pointer">CT</Label>
                  </div>
                  <div className="flex items-center space-x-1">
                    <RadioGroupItem value="Custom" id="custom-bottom" />
                    <Label htmlFor="custom-bottom" className="text-xs text-gray-300 cursor-pointer">Custom</Label>
                  </div>
                </div>
              </RadioGroup>

              {weighting === 'Custom' && (
                <div className="w-40">
                  <Slider value={[customWeighting.psi]} onValueChange={([psi]) => setCustomWeighting({ psi })} min={0} max={180} step={1} />
                </div>
              )}
            </div>
          )}

          <Button
            size="sm"
            variant="ghost"
            className="text-gray-300"
            onClick={() => setTileSignal(s => s + 1)}
            aria-label="Tile windows"
          >
            <Layout className="h-4 w-4" />
          </Button>
        </div>
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
          onCustomWeightingChange={(p) => setCustomWeighting(p)}
          contrastMode={contrastMode}
          onContrastModeChange={(m) => setContrastMode(m)}
          selectedPlanes={selectedPlanes}
          onPlanesChange={(planes) => setSelectedPlanes(planes)}
          onFileLoad={onFileLoad}
          layoutPreference={layoutPreference}
          onLayoutPreferenceChange={(p) => {
            setLayoutPreference(p);
            // ensure layoutPreference state updates propagate before tiling runs
            setTimeout(() => setTileSignal(s => s + 1), 0);
          }}
          onOverflowChange={(v) => setRightPanelOverflow(v)}
        />
      </div>
    </div>
  );
}