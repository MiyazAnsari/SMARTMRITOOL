import { useState } from 'react';
import { Separator } from './ui/separator';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import { WeightingType } from './MedicalImageViewer';
import { StudyUpload } from './dicom/StudyUpload';
import type { DicomStudyView } from './dicom/patientStudy';
import type { Plane } from './dicom/DicomLoader';
import {
  MeasurementWorkflow,
  WorkflowState,
} from './measurement/MeasurementWorkflow';
import type { Measurement } from './MedicalImageViewer';

interface WeightingPanelProps {
  weighting: WeightingType;
  onWeightingChange: (weighting: WeightingType) => void;
  customWeighting: { psi: number };
  onCustomWeightingChange: (params: { psi: number }) => void;
  /** DICOM: which viewers are open (must match `MedicalImageViewer` studyViewport.open). */
  openStudyPlanes?: Plane[];
  /** DICOM: toggle viewer open/closed (same behavior as viewer “x”). */
  onStudyPlaneToggle?: (plane: Plane) => void;
  onFileLoad?: (data: ArrayBuffer, name: string) => void;
  onStudyLoad?: (study: import('./dicom/DicomStudy').DicomStudy) => void;
  studyData?: DicomStudyView | null;
  activeStudyPlane?: Plane;
  workflow: WorkflowState;
  onWorkflowChange: (s: WorkflowState) => void;
  measurements: Measurement[];
  selectedMeasurementId?: string | null;
  onMeasurementSelect?: (id: string | null) => void;
  onStepRedo?: (stepId: string) => void;
  onResetMeasurements?: () => void;
  pixelSpacing: { x: number; y: number };
  onPlaneRequest?: (plane: Plane) => void;
  onOverflowChange?: (overflowing: boolean) => void;
  /** CSS→image-pixel scale factor for converting overlay coordinates to physical mm. */
  imageScale?: { x: number; y: number };
}

export function WeightingPanel({ 
  weighting, 
  onWeightingChange, 
  customWeighting, 
  onCustomWeightingChange,
  openStudyPlanes,
  onStudyPlaneToggle,
  onFileLoad,
  onStudyLoad,
  studyData,
  activeStudyPlane,
  workflow,
  onWorkflowChange,
  measurements,
  selectedMeasurementId,
  onMeasurementSelect,
  onStepRedo,
  onResetMeasurements,
  pixelSpacing,
  onPlaneRequest,
  onOverflowChange,
  imageScale,
}: WeightingPanelProps) {
  const [uploadOpen, setUploadOpen] = useState(true);
  return (
    <div className="bg-gray-900 border-l border-gray-800 p-4 overflow-y-auto h-full">
      <div className="mb-4">
        <h2 className="text-sm font-bold text-blue-300 mb-3">Annotation Suite</h2>
        {(onFileLoad || onStudyLoad) && (
          <StudyUpload
            onNiftiLoad={(buf, name) => onFileLoad?.(buf, name)}
            onStudyLoad={(study) => onStudyLoad?.(study)}
          />
        )}
        {studyData && (
          <div className="mt-2 text-[10px] text-gray-400">
            Loaded study: <span className="text-gray-200">{studyData.studyName}</span>
            <span className="text-gray-500"> · </span>
            <span className="text-gray-200 capitalize">{studyData.laterality} knee</span>
            <div className="mt-1">
              <div className="mb-1 text-gray-500">Viewers (click to show / hide):</div>
              <div className="flex flex-wrap gap-1">
                {(['axial', 'sagittal', 'coronal'] as Plane[]).map((p) => {
                  const exists = Boolean(studyData.volumes[p]);
                  const isOpen = openStudyPlanes?.includes(p) ?? false;
                  const isFocused = activeStudyPlane === p;
                  return (
                    <button
                      key={p}
                      type="button"
                      aria-pressed={exists ? isOpen : undefined}
                      disabled={!exists}
                      onClick={() => {
                        if (!exists) return;
                        onStudyPlaneToggle?.(p);
                      }}
                      className={`px-2 py-0.5 rounded capitalize border transition-colors ${
                        !exists
                          ? 'bg-gray-900 text-gray-500 border-gray-800 cursor-not-allowed'
                          : isOpen && isFocused
                            ? 'bg-blue-600 text-white border-blue-500 ring-2 ring-blue-400/80'
                            : isOpen
                              ? 'bg-blue-800/90 text-gray-100 border-blue-600 hover:bg-blue-700'
                              : 'bg-gray-800 text-gray-400 border-gray-700 hover:bg-gray-700 hover:text-gray-200'
                      }`}
                      title={
                        !exists
                          ? `${p} sequence not loaded`
                          : isOpen
                            ? `Hide ${p} viewer (same as window close)`
                            : `Show ${p} viewer`
                      }
                    >
                      {p}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      <MeasurementWorkflow
        state={workflow}
        onStateChange={onWorkflowChange}
        pixelSpacing={pixelSpacing}
        measurements={measurements}
        selectedMeasurementId={selectedMeasurementId}
        onMeasurementSelect={onMeasurementSelect}
        onStepRedo={onStepRedo}
        onResetMeasurements={onResetMeasurements}
        onPlaneRequest={onPlaneRequest}
        imageScale={imageScale}
      />

    </div>
  );
}
